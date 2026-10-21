//! Per-installation process tracking and safe stop/uninstall handling.

use crate::config::ShellConfig;
use crate::fsutil::{atomic_write, FileLock};
use crate::process;
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const RECORD_FILE: &str = "process.json";
const RECORD_LOCK_FILE: &str = "process.lock";
const RECORD_SCHEMA_VERSION: u32 = 1;
const APP_LOCK_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProcessRecord {
    schema_version: u32,
    owner_pid: u32,
    owner_start_time: u64,
    child_pid: Option<u32>,
    child_start_time: Option<u64>,
    installation: String,
}

/// A launch's durable process record. The process lock remains held until the
/// Electron PID and creation time have both been written.
pub struct ProcessRecordGuard {
    record_path: PathBuf,
    lock_path: PathBuf,
    record: ProcessRecord,
    startup_lock: Option<FileLock>,
}

impl ProcessRecordGuard {
    pub fn begin(cfg: &ShellConfig) -> Result<Self> {
        let (record_path, lock_path) = record_paths(cfg)?;
        let lock = FileLock::exclusive(&lock_path)?;
        let installation = canonical_installation(&cfg.app_dir()?)?;

        if let Some(previous) = read_record(&record_path)? {
            ensure_record_matches(&previous, &installation)?;
            if record_has_live_process(&previous)? {
                bail!("this installation has a recorded process still running; use --stop first");
            }
            std::fs::remove_file(&record_path)
                .context("remove stale installation process record")?;
        }

        let owner_pid = std::process::id();
        let record = ProcessRecord {
            schema_version: RECORD_SCHEMA_VERSION,
            owner_pid,
            owner_start_time: process::start_time(owner_pid)?,
            child_pid: None,
            child_start_time: None,
            installation,
        };
        write_record(&record_path, &record)?;
        Ok(Self {
            record_path,
            lock_path,
            record,
            startup_lock: Some(lock),
        })
    }

    /// Save the child identity before releasing the process-record lock. If
    /// the child has already exited, the owner record remains sufficient.
    pub fn record_child(&mut self, pid: u32) -> Result<()> {
        ensure!(pid != 0, "invalid Electron process id");
        match process::start_time(pid) {
            Ok(start_time) => {
                self.record.child_pid = Some(pid);
                self.record.child_start_time = Some(start_time);
                write_record(&self.record_path, &self.record)?;
            }
            Err(error) if !process::is_alive(pid) => {
                let _ = error;
                self.record.child_pid = None;
                self.record.child_start_time = None;
                write_record(&self.record_path, &self.record)?;
            }
            Err(error) => return Err(error).context("inspect Electron process creation time"),
        }
        self.startup_lock.take();
        Ok(())
    }

    /// Remove the record only when it still belongs to this launch and no
    /// recorded process remains alive. A replaced/new instance is preserved.
    pub fn finish(&mut self) -> Result<()> {
        self.startup_lock.take();
        let _lock = FileLock::exclusive(&self.lock_path)?;
        let Some(current) = read_record(&self.record_path)? else {
            return Ok(());
        };
        if current.owner_pid != self.record.owner_pid
            || current.owner_start_time != self.record.owner_start_time
            || current.installation != self.record.installation
        {
            return Ok(());
        }
        let finishing_own_process = current.owner_pid == std::process::id()
            && current.owner_start_time == self.record.owner_start_time;
        if (finishing_own_process && record_child_is_alive(&current)?)
            || (!finishing_own_process && record_has_live_process(&current)?)
        {
            return Ok(());
        }
        remove_record(&self.record_path)
    }
}

impl Drop for ProcessRecordGuard {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// Stop this installation and return while holding its application lock.
/// Uninstall callers keep that lock through reference removal and GC.
pub fn stop_and_lock(cfg: &ShellConfig) -> Result<FileLock> {
    let app_dir = cfg.app_dir()?;
    let installation = canonical_installation(&app_dir)?;
    let app_lock_path = app_dir.join("updates/application.lock");
    let (record_path, lock_path) = record_paths(cfg)?;

    // Claim the app lock first when the launcher has already exited. This also
    // prevents a new launch racing an orphan-child shutdown.
    let mut app_lock = FileLock::try_exclusive(&app_lock_path)?;
    let process_lock = FileLock::exclusive(&lock_path)?;
    let Some(record) = read_record(&record_path)? else {
        if app_lock.is_none() {
            bail!("application lock is held but its process record is missing; refusing to uninstall or stop blindly");
        }
        return Ok(app_lock.expect("lock was checked as present"));
    };
    ensure_record_matches(&record, &installation)?;

    if record.owner_pid == record.child_pid.unwrap_or(0) {
        bail!("invalid process record: owner and Electron child have the same PID");
    }

    if let (Some(pid), Some(start_time)) = (record.child_pid, record.child_start_time) {
        if recorded_process_is_alive(pid, start_time)? {
            process::terminate_identity(pid, start_time)
                .with_context(|| format!("stop this installation's Electron process {pid}"))?;
        }
    } else if let Some(pid) = record.child_pid {
        if process::is_alive(pid) {
            bail!("Electron process {pid} has no recorded creation time; refusing to signal by PID alone");
        }
    }

    if recorded_process_is_alive(record.owner_pid, record.owner_start_time)? {
        process::terminate_identity(record.owner_pid, record.owner_start_time).with_context(
            || {
                format!(
                    "stop this installation's launcher process {}",
                    record.owner_pid
                )
            },
        )?;
    }

    if record_has_live_process(&record)? {
        bail!("a recorded installation process is still running; refusing to remove runtime references");
    }
    remove_record(&record_path)?;
    drop(process_lock);

    if app_lock.is_none() {
        app_lock = Some(wait_for_app_lock(&app_lock_path, APP_LOCK_WAIT)?);
    }
    Ok(app_lock.expect("application lock acquired before return"))
}

fn wait_for_app_lock(path: &Path, timeout: Duration) -> Result<FileLock> {
    let until = Instant::now() + timeout;
    loop {
        if let Some(lock) = FileLock::try_exclusive(path)? {
            return Ok(lock);
        }
        if Instant::now() >= until {
            bail!("application lock did not become available before timeout");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn record_paths(cfg: &ShellConfig) -> Result<(PathBuf, PathBuf)> {
    let updates = cfg.app_dir()?.join("updates");
    Ok((updates.join(RECORD_FILE), updates.join(RECORD_LOCK_FILE)))
}

fn read_record(path: &Path) -> Result<Option<ProcessRecord>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("read process record {}", path.display()))
        }
    };
    let record: ProcessRecord = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse process record {}", path.display()))?;
    ensure!(
        record.schema_version == RECORD_SCHEMA_VERSION,
        "unsupported installation process record schema"
    );
    ensure!(record.owner_pid != 0, "invalid owner PID in process record");
    ensure!(
        record.child_pid.is_some() == record.child_start_time.is_some(),
        "incomplete Electron process identity in process record"
    );
    ensure!(
        record.child_pid != Some(0),
        "invalid Electron PID in process record"
    );
    Ok(Some(record))
}

fn write_record(path: &Path, record: &ProcessRecord) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(record)?)
}

fn remove_record(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("remove process record {}", path.display()))
        }
    }
}

fn ensure_record_matches(record: &ProcessRecord, installation: &str) -> Result<()> {
    ensure!(
        record.installation == installation,
        "process record belongs to a different installation; refusing to stop it"
    );
    Ok(())
}

fn canonical_installation(path: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("canonicalize installation directory {}", path.display()))?;
    let mut value = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    Ok(value)
}

fn recorded_process_is_alive(pid: u32, expected_start_time: u64) -> Result<bool> {
    if !process::is_alive(pid) {
        return Ok(false);
    }
    if expected_start_time == 0 {
        bail!("process {pid} has no reliable creation time; refusing to signal by PID alone");
    }
    Ok(process::start_time(pid)
        .with_context(|| format!("inspect process identity for PID {pid}"))?
        == expected_start_time)
}

fn record_has_live_process(record: &ProcessRecord) -> Result<bool> {
    if recorded_process_is_alive(record.owner_pid, record.owner_start_time)? {
        return Ok(true);
    }
    if let (Some(pid), Some(start_time)) = (record.child_pid, record.child_start_time) {
        return recorded_process_is_alive(pid, start_time);
    }
    if let Some(pid) = record.child_pid {
        return Ok(process::is_alive(pid));
    }
    Ok(false)
}

fn record_child_is_alive(record: &ProcessRecord) -> Result<bool> {
    if let (Some(pid), Some(start_time)) = (record.child_pid, record.child_start_time) {
        return recorded_process_is_alive(pid, start_time);
    }
    if let Some(pid) = record.child_pid {
        return Ok(process::is_alive(pid));
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command};
    use std::time::SystemTime;

    fn test_config(dir: &Path) -> ShellConfig {
        std::fs::create_dir_all(dir).unwrap();
        let config = dir.join("minitron.toml");
        std::fs::write(
            &config,
            "app_id='test.lifecycle'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n",
        )
        .unwrap();
        ShellConfig::load_from(&config).unwrap()
    }

    fn spawn_fixture() -> Child {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "lifecycle::tests::fixture_child", "--nocapture"])
            .env("MINITRON_LIFECYCLE_FIXTURE", "1")
            .spawn()
            .unwrap()
    }

    fn record_path(cfg: &ShellConfig) -> PathBuf {
        cfg.app_dir().unwrap().join("updates").join(RECORD_FILE)
    }

    #[test]
    fn fixture_child() {
        if std::env::var_os("MINITRON_LIFECYCLE_FIXTURE").is_some() {
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }

    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn stop_kills_only_the_recorded_installation_processes() {
        let dir = std::env::temp_dir().join(format!(
            "minitron-lifecycle-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = test_config(&dir);
        let mut owner = spawn_fixture();
        let mut electron = spawn_fixture();
        let mut unrelated = spawn_fixture();
        let owner_start_time = process::start_time(owner.id()).unwrap();
        let child_start_time = process::start_time(electron.id()).unwrap();
        let record = ProcessRecord {
            schema_version: RECORD_SCHEMA_VERSION,
            owner_pid: owner.id(),
            owner_start_time,
            child_pid: Some(electron.id()),
            child_start_time: Some(child_start_time),
            installation: canonical_installation(&cfg.app_dir().unwrap()).unwrap(),
        };
        write_record(&record_path(&cfg), &record).unwrap();

        let _lock = stop_and_lock(&cfg).unwrap();
        assert!(!process::is_alive(owner.id()));
        assert!(!process::is_alive(electron.id()));
        assert!(process::is_alive(unrelated.id()));
        assert!(!record_path(&cfg).exists());

        let _ = unrelated.kill();
        let _ = unrelated.wait();
        let _ = owner.wait();
        let _ = electron.wait();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mismatched_installation_record_is_never_signaled() {
        let dir = std::env::temp_dir().join(format!(
            "minitron-lifecycle-mismatch-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = test_config(&dir);
        let mut child = spawn_fixture();
        let record = ProcessRecord {
            schema_version: RECORD_SCHEMA_VERSION,
            owner_pid: child.id(),
            owner_start_time: process::start_time(child.id()).unwrap(),
            child_pid: None,
            child_start_time: None,
            installation: "different-installation".to_owned(),
        };
        write_record(&record_path(&cfg), &record).unwrap();

        assert!(stop_and_lock(&cfg).is_err());
        assert!(process::is_alive(child.id()));
        child.kill().unwrap();
        let _ = child.wait();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn record_cleanup_keeps_a_replaced_instance_record() {
        let dir = std::env::temp_dir().join(format!(
            "minitron-lifecycle-replace-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = test_config(&dir);
        let mut guard = ProcessRecordGuard::begin(&cfg).unwrap();
        let mut replacement = guard.record.clone();
        replacement.owner_pid = replacement.owner_pid.saturating_add(1);
        write_record(&record_path(&cfg), &replacement).unwrap();
        guard.finish().unwrap();
        assert!(record_path(&cfg).exists());
        drop(guard);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn normal_owner_exit_removes_its_process_record() {
        let dir = std::env::temp_dir().join(format!(
            "minitron-lifecycle-finish-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cfg = test_config(&dir);
        let mut guard = ProcessRecordGuard::begin(&cfg).unwrap();
        guard.finish().unwrap();
        assert!(!record_path(&cfg).exists());
        drop(guard);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
