//! Signed-manifest gated shell self-update.
//!
//! The running shell copies itself to a temporary directory and starts that
//! independent copier. The copier waits for this process to exit before it
//! atomically replaces the installed executable.

use crate::config::{platform_triple, ShellConfig};
use crate::download;
use crate::fsutil::atomic_replace;
use crate::fsutil::atomic_write;
use crate::fsutil::FileLock;
use crate::manifest::{Artifact, Manifest};
use crate::process;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TICKET_SCHEMA: u32 = 2;

#[derive(Debug, Serialize, Deserialize)]
struct UpdateTicket {
    schema: u32,
    id: String,
    target: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
    parent_pid: u32,
    #[serde(default)]
    parent_start_time: u64,
    sha256: String,
    restart_args: Vec<String>,
    working_dir: PathBuf,
    #[serde(default)]
    state_dir: Option<PathBuf>,
    result_path: PathBuf,
}

#[derive(Serialize)]
struct UpdateResult<'a> {
    schema: u32,
    id: &'a str,
    phase: &'a str,
    timestamp_unix_ms: u128,
    detail: Option<String>,
}

fn version(value: &str, field: &str) -> Result<semver::Version> {
    semver::Version::parse(value).with_context(|| format!("invalid {field} version {value:?}"))
}

fn needs_stub_update(current: &str, minimum: Option<&str>) -> Result<bool> {
    let Some(minimum) = minimum else {
        return Ok(false);
    };
    Ok(version(current, "shell")? < version(minimum, "minimum shell")?)
}

fn normalize_sha256(value: &str) -> Result<String> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "shell artifact SHA256 must be 64 hex characters"
    );
    Ok(value.to_ascii_lowercase())
}

fn ticket_state_dir(working_dir: &Path, declared_state_dir: Option<&Path>) -> Result<PathBuf> {
    let Some(declared_state_dir) = declared_state_dir else {
        // Tickets created before state_dir was added used the installation's
        // original updates directory.
        return Ok(working_dir.join("updates").canonicalize()?);
    };

    let cfg = ShellConfig::load_for_app_dir(working_dir)?;
    let declared = declared_state_dir.canonicalize()?;
    let current_matches = cfg
        .updates_dir()?
        .canonicalize()
        .is_ok_and(|expected| expected == declared);
    let legacy_matches = cfg
        .legacy_updates_dir()?
        .canonicalize()
        .is_ok_and(|expected| expected == declared);
    ensure!(
        current_matches || legacy_matches,
        "self-update state directory does not match installation state"
    );
    Ok(declared)
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// A mislabeled artifact must not create an endless self-update/restart loop.
fn verify_shell_version(binary: &Path, expected: &str) -> Result<()> {
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("check downloaded shell version")?;
    let until = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if std::time::Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            bail!("downloaded shell did not answer --version");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "downloaded shell version check failed"
    );
    ensure!(
        String::from_utf8_lossy(&output.stdout).trim() == expected,
        "downloaded shell version does not match manifest {expected}"
    );
    Ok(())
}

fn unique_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

fn normalized_restart_args(args: &[OsString], executable: &Path) -> Vec<String> {
    let start = args
        .first()
        .is_some_and(|first| {
            let first_path = Path::new(first);
            first_path == executable || first_path.file_name() == executable.file_name()
        })
        .then_some(1)
        .unwrap_or(0);
    args[start..]
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

/// Stage and hand off a shell update when this build is below the manifest's
/// `min_stub_version`. `args` may contain either argv[0] or only user args.
/// Returns true once the independent copier has been started; the caller must
/// then exit promptly so the target executable can be replaced.
pub fn maybe_stage(cfg: &ShellConfig, manifest: &Manifest, args: &[OsString]) -> Result<bool> {
    let Some(minimum) = manifest.app.min_stub_version.as_deref() else {
        return Ok(false);
    };
    let current = crate::SHELL_VERSION;
    if !needs_stub_update(current, Some(minimum))? {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    if cfg.is_macos_app_bundle()? {
        bail!("self-updating a macOS app bundle would invalidate its signature; install the updated package instead");
    }

    let shell = manifest
        .shell
        .as_ref()
        .context("manifest requires a newer shell but has no shell artifacts")?;
    ensure!(
        version(&shell.version, "shell artifact")? >= version(minimum, "minimum shell")?,
        "manifest shell artifact {} does not satisfy min_stub_version {}",
        shell.version,
        minimum
    );
    ensure!(
        version(&shell.version, "shell artifact")? > version(current, "current shell")?,
        "manifest requires shell {}, but its artifact {} is not newer",
        minimum,
        shell.version
    );
    let artifact = shell
        .platforms
        .get(platform_triple())
        .with_context(|| format!("manifest has no shell artifact for {}", platform_triple()))?;
    let expected_sha = normalize_sha256(&artifact.sha256)?;

    let app_dir = cfg.app_dir()?;
    let updates = cfg.updates_dir()?;
    let id = unique_id();
    let work_dir = updates
        .join("staging")
        .join(format!("selfupdate-{}-{}", shell.version, expected_sha));
    fs::create_dir_all(&work_dir)?;
    let normalized = Artifact {
        sha256: expected_sha.clone(),
        ..artifact.clone()
    };
    let package_path = download::download(&normalized, &work_dir, Box::new(|_, _| {}))?;
    ensure!(
        hash_file(&package_path)?.eq_ignore_ascii_case(&expected_sha),
        "shell artifact hash changed after download"
    );

    let target = std::env::current_exe()?.canonicalize()?;
    let staged = work_dir.join(if cfg!(windows) {
        "shell-new.exe"
    } else {
        "shell-new"
    });
    if staged.exists() {
        fs::remove_file(&staged)?;
    }
    fs::copy(&package_path, &staged).context("prepare staged shell executable")?;
    ensure!(
        hash_file(&staged)?.eq_ignore_ascii_case(&expected_sha),
        "staged shell executable hash mismatch"
    );
    // HTTP downloads have no executable bit on Unix. Preserve the installed
    // launcher's permissions before executing the verified replacement.
    fs::set_permissions(
        &staged,
        fs::metadata(std::env::current_exe()?)?.permissions(),
    )?;
    verify_shell_version(&staged, &shell.version)?;
    let backup = updates
        .join("backup")
        .join(format!("shell-{}-{}.bak", current, id));
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent)?;
    }
    let ticket_path = updates
        .join("staging")
        .join(format!("selfupdate-{id}.ticket.json"));
    let result_path = updates
        .join("staging")
        .join(format!("selfupdate-{id}.result.json"));
    let copier_dir = std::env::temp_dir()
        .join("electron-runtime-shell")
        .join(format!("copier-{id}"));
    fs::create_dir_all(&copier_dir)?;
    let copier = copier_dir.join(if cfg!(windows) {
        "copier.exe"
    } else {
        "copier"
    });
    fs::copy(&target, &copier).context("copy shell to independent copier path")?;

    let ticket = UpdateTicket {
        schema: TICKET_SCHEMA,
        id: id.clone(),
        target: target.clone(),
        staged: staged.canonicalize()?,
        backup,
        parent_pid: std::process::id(),
        parent_start_time: process::start_time(std::process::id()).unwrap_or(0),
        sha256: expected_sha,
        restart_args: normalized_restart_args(args, &target),
        working_dir: app_dir.canonicalize()?,
        state_dir: Some(updates.canonicalize()?),
        result_path,
    };
    atomic_write(&ticket_path, &serde_json::to_vec_pretty(&ticket)?)?;

    let log_path = updates.join("selfupdate.log");
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("open self-update log {}", log_path.display()))?;
    let stderr = log.try_clone()?;
    Command::new(&copier)
        .arg("--apply-update")
        .arg(&ticket_path)
        .current_dir(&ticket.working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
        .context("start independent shell updater")?;
    Ok(true)
}

fn validate_ticket(ticket_path: &Path, ticket: &UpdateTicket) -> Result<()> {
    ensure!(
        ticket.schema == TICKET_SCHEMA,
        "unsupported self-update ticket schema {}",
        ticket.schema
    );
    ensure!(
        ticket.parent_pid != 0 && ticket.parent_pid != std::process::id(),
        "invalid self-update parent PID"
    );
    ensure!(!ticket.id.is_empty(), "self-update ticket id is empty");
    ensure!(
        ticket.target.is_absolute() && ticket.staged.is_absolute() && ticket.backup.is_absolute(),
        "self-update ticket paths must be absolute"
    );
    ensure!(
        ticket.working_dir.is_absolute(),
        "self-update working directory must be absolute"
    );
    let expected_sha = normalize_sha256(&ticket.sha256)?;
    ensure!(
        ticket_path.is_absolute(),
        "self-update ticket path must be absolute"
    );
    let working_dir = ticket.working_dir.canonicalize()?;
    let updates = ticket_state_dir(&working_dir, ticket.state_dir.as_deref())?;
    let staging = updates.join("staging").canonicalize()?;
    ensure!(updates.is_absolute(), "updates directory is not absolute");
    ensure!(
        staging.starts_with(&updates),
        "staging directory is outside updates"
    );
    ensure!(
        ticket_path.canonicalize()?.starts_with(&staging),
        "ticket is outside the app staging directory"
    );
    ensure!(
        ticket.staged.canonicalize()?.starts_with(&staging),
        "staged shell is outside the app staging directory"
    );
    ensure!(
        ticket.result_path.is_absolute()
            && ticket
                .result_path
                .parent()
                .and_then(|parent| parent.canonicalize().ok())
                .as_ref()
                == Some(&staging),
        "self-update result path is outside the app staging directory"
    );
    let target_parent = ticket
        .target
        .parent()
        .context("shell target has no parent")?;
    ensure!(
        target_parent.canonicalize()? == working_dir,
        "shell target is outside the expected app directory"
    );
    let backup_parent = ticket
        .backup
        .parent()
        .context("shell backup has no parent")?
        .canonicalize()?;
    ensure!(
        backup_parent.starts_with(&updates),
        "shell backup is outside updates directory"
    );
    ensure!(
        hash_file(&ticket.staged)?.eq_ignore_ascii_case(&expected_sha),
        "staged shell hash mismatch"
    );
    ensure!(
        ticket.target.is_file(),
        "installed shell target does not exist"
    );
    Ok(())
}

fn same_process_identity(expected_start_time: u64, actual_start_time: u64) -> bool {
    expected_start_time == 0 || actual_start_time == 0 || expected_start_time == actual_start_time
}

fn wait_for_parent(pid: u32, expected_start_time: u64) -> Result<()> {
    if pid == 0 || pid == std::process::id() {
        bail!("invalid parent process ID");
    }
    while process::is_alive(pid) {
        if let Ok(actual_start_time) = process::start_time(pid) {
            if !same_process_identity(expected_start_time, actual_start_time) {
                return Ok(()); // The original process exited and its PID was reused.
            }
        }
        // Recheck process creation identity after each bounded wait. This is a
        // real wait, not a fixed startup delay, and tolerates slow shutdown.
        let _ = process::wait_for_exit(pid, Duration::from_secs(2));
    }
    Ok(())
}

fn write_result(ticket: &UpdateTicket, phase: &str, detail: Option<String>) -> Result<()> {
    let timestamp_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis();
    let result = UpdateResult {
        schema: TICKET_SCHEMA,
        id: &ticket.id,
        phase,
        timestamp_unix_ms,
        detail,
    };
    atomic_write(&ticket.result_path, &serde_json::to_vec_pretty(&result)?)
}

fn replace_with_retries(source: &Path, target: &Path) -> Result<()> {
    let mut last_error = None;
    for delay in [0, 100, 250, 500, 1000] {
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        match replace_file(source, target) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    match last_error {
        Some(error) => Err(error).context("replace retries exhausted"),
        None => bail!("replacement was not attempted"),
    }
}

fn replace_file(source: &Path, target: &Path) -> Result<()> {
    atomic_replace(source, target).with_context(|| format!("replace {}", target.display()))
}

fn restore_backup(backup: &Path, target: &Path) -> Result<()> {
    let temp = target.with_extension("restore.tmp");
    fs::copy(backup, &temp).context("copy shell backup for restore")?;
    replace_with_retries(&temp, target).context("restore previous shell executable")
}

/// Copier mode, invoked as `copier --apply-update <absolute-ticket.json>`.
pub fn apply_ticket(ticket_path: &Path) -> Result<()> {
    let ticket_bytes = fs::read(ticket_path).context("read self-update ticket")?;
    let ticket: UpdateTicket =
        serde_json::from_slice(&ticket_bytes).context("parse self-update ticket")?;
    validate_ticket(ticket_path, &ticket)?;
    write_result(&ticket, "copier_started", None)?;
    write_result(&ticket, "waiting_for_parent", None)?;
    wait_for_parent(ticket.parent_pid, ticket.parent_start_time)?;
    write_result(&ticket, "parent_exited", None)?;
    // A user may start the old shell in the gap after its parent exits. Take
    // the same application lock as normal startup before replacing the target.
    write_result(&ticket, "waiting_for_application_lock", None)?;
    // Legacy tickets (written before Unix state moved outside read-only
    // installations) must keep using their declared in-installation state.
    // New tickets were checked against the installation state by validate_ticket.
    let state_dir = if let Some(state_dir) = &ticket.state_dir {
        state_dir.canonicalize()?
    } else {
        ticket.working_dir.join("updates").canonicalize()?
    };
    let _application = FileLock::exclusive(&state_dir.join("application.lock"))?;

    // Verify again after waiting; the staging path can change while the shell
    // exits, and no unverified file should replace the installed executable.
    ensure!(
        hash_file(&ticket.staged)?.eq_ignore_ascii_case(&ticket.sha256),
        "staged shell hash mismatch after parent exit"
    );
    if let Some(parent) = ticket.backup.parent() {
        fs::create_dir_all(parent)?;
    }
    write_result(&ticket, "backing_up", None)?;
    let current_hash = hash_file(&ticket.target)?;
    fs::copy(&ticket.target, &ticket.backup).context("backup currently installed shell")?;
    ensure!(
        hash_file(&ticket.backup)?.eq_ignore_ascii_case(&current_hash),
        "self-update backup hash mismatch"
    );
    write_result(&ticket, "backup_created", None)?;
    write_result(&ticket, "replacing", None)?;
    if let Err(error) = replace_with_retries(&ticket.staged, &ticket.target) {
        let _ = write_result(&ticket, "replacement_failed", Some(format!("{error:#}")));
        return Err(error).context("replace installed shell after retries");
    }
    if let Err(error) = hash_file(&ticket.target).and_then(|actual| {
        ensure!(
            actual.eq_ignore_ascii_case(&ticket.sha256),
            "installed shell hash mismatch after replacement"
        );
        Ok(())
    }) {
        let _ = write_result(
            &ticket,
            "replacement_hash_failed",
            Some(format!("{error:#}")),
        );
        return Err(error);
    }
    write_result(&ticket, "replaced", None)?;
    drop(_application);

    let mut command = Command::new(&ticket.target);
    command
        .args(&ticket.restart_args)
        .current_dir(&ticket.working_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Err(spawn_error) = command.spawn() {
        let _application = FileLock::exclusive(&state_dir.join("application.lock"))?;
        if let Err(restore_error) = restore_backup(&ticket.backup, &ticket.target) {
            let detail = format!(
                "updated shell start failed: {spawn_error}; restore failed: {restore_error:#}"
            );
            let _ = write_result(&ticket, "restore_failed", Some(detail.clone()));
            return Err(anyhow::anyhow!(detail));
        }
        write_result(
            &ticket,
            "restored",
            Some(format!(
                "updated shell start failed; previous executable restored: {spawn_error}"
            )),
        )?;
        drop(_application);
        return Err(spawn_error).context("start updated shell; previous shell restored");
    }

    write_result(&ticket, "restarted", None)?;
    let _ = fs::remove_file(ticket_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_stub_version_gates_only_older_shells() {
        assert!(needs_stub_update("0.1.0", Some("0.2.0")).unwrap());
        assert!(!needs_stub_update("0.2.0", Some("0.2.0")).unwrap());
        assert!(!needs_stub_update("0.3.0", Some("0.2.0")).unwrap());
        assert!(!needs_stub_update("0.1.0", None).unwrap());
    }

    #[test]
    fn restart_arguments_drop_argv_zero_when_present() {
        let exe = Path::new(r"C:\Apps\shell.exe");
        let with_exe = vec![
            OsString::from(r"C:\Apps\shell.exe"),
            OsString::from("--headless"),
        ];
        let without_exe = vec![OsString::from("--headless")];
        assert_eq!(normalized_restart_args(&with_exe, exe), vec!["--headless"]);
        assert_eq!(
            normalized_restart_args(&without_exe, exe),
            vec!["--headless"]
        );
    }

    #[test]
    fn process_creation_time_detects_reused_pid_when_available() {
        assert!(same_process_identity(0, 42));
        assert!(same_process_identity(42, 42));
        assert!(same_process_identity(42, 0));
        assert!(!same_process_identity(42, 43));
    }

    #[test]
    fn explicit_state_dir_accepts_legacy_installation_state() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("installed");
        let legacy_updates = install.join("updates");
        std::fs::create_dir_all(&legacy_updates).unwrap();
        std::fs::write(
            install.join("minitron.toml"),
            "app_id='test.selfupdate-state'\nrequired_runtime='32.2.0'\napp_version='1.0.0'\n",
        )
        .unwrap();

        assert_eq!(
            ticket_state_dir(&install, Some(&legacy_updates)).unwrap(),
            legacy_updates.canonicalize().unwrap()
        );
    }
}
