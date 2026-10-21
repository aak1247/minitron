//! App release staging, activation, crash recovery, and pointer-based rollback.
//!
//! Downloaded releases are immutable. A running Electron process keeps using
//! its original `resources_dir`; only a later shell startup changes active.json.

use crate::config::ShellConfig;
use crate::download::{self, ProgressFn};
use crate::fsutil::{atomic_write, FileLock};
use crate::manifest::{Artifact, Manifest};
use crate::process;
use crate::release::{Release, RuntimeKey};
use anyhow::{bail, ensure, Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STATE_SCHEMA: u32 = 1;
#[cfg(not(windows))]
const INSTALLED_BASE_FILE: &str = "installed-base.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActiveState {
    schema: u32,
    active: Release,
    #[serde(default)]
    previous: Option<Release>,
    #[serde(default)]
    txid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingState {
    schema: u32,
    release: Release,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TxPhase {
    Prepared,
    AwaitingHealth,
    Committed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Transaction {
    schema: u32,
    txid: String,
    from: Release,
    to: Release,
    phase: TxPhase,
    ready_file: PathBuf,
    #[serde(default)]
    attempt_pid: Option<u32>,
    #[serde(default)]
    attempt_start_time: Option<u64>,
    #[serde(default)]
    exit_code: Option<i32>,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct InstalledBase {
    schema: u32,
    installation: String,
    app_version: String,
    required_runtime: String,
}

fn updates_dir(cfg: &ShellConfig) -> Result<PathBuf> {
    cfg.updates_dir()
}

fn read_state_file<T: DeserializeOwned>(cfg: &ShellConfig, name: &str) -> Result<Option<T>> {
    let current = updates_dir(cfg)?.join(name);
    if let Some(value) = read_optional(&current)? {
        return Ok(Some(value));
    }
    #[cfg(not(windows))]
    {
        let legacy = cfg.legacy_updates_dir()?.join(name);
        if legacy != current {
            return read_optional(&legacy);
        }
    }
    Ok(None)
}

/// Copy only the small state records from the old in-installation Unix layout.
/// Immutable release payloads remain in place and are accepted by validation.
pub fn migrate_legacy_state(cfg: &ShellConfig) -> Result<()> {
    #[cfg(windows)]
    let _ = cfg;
    #[cfg(not(windows))]
    {
        let current = updates_dir(cfg)?;
        let legacy = cfg.legacy_updates_dir()?;
        if legacy == current {
            return Ok(());
        }
        let legacy_metadata = match fs::symlink_metadata(&legacy) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(error).with_context(|| format!("inspect {}", legacy.display()))
            }
        };
        if !legacy_metadata.file_type().is_dir() {
            bail!(
                "legacy updates path is not a plain directory: {}",
                legacy.display()
            );
        }
        for name in ["active.json", "pending.json", "transaction.json"] {
            let destination = current.join(name);
            if destination.exists() {
                continue;
            }
            let source = legacy.join(name);
            let metadata = match fs::symlink_metadata(&source) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(error).with_context(|| format!("inspect {}", source.display()))
                }
            };
            ensure!(
                metadata.file_type().is_file() && metadata.len() <= 16 * 1024 * 1024,
                "legacy state is not a bounded regular file: {}",
                source.display()
            );
            let bytes = fs::read(&source)
                .with_context(|| format!("read legacy state {}", source.display()))?;
            atomic_write(&destination, &bytes)?;
        }
    }
    Ok(())
}

/// Reconcile installer-provided base resources with the state retained outside
/// Unix installations. An installer upgrade intentionally makes its new base
/// authoritative, while user data and immutable release payloads remain intact.
#[cfg(not(windows))]
pub fn reconcile_installed_base(cfg: &ShellConfig) -> Result<()> {
    let path = updates_dir(cfg)?.join(INSTALLED_BASE_FILE);
    let current = InstalledBase {
        schema: STATE_SCHEMA,
        installation: canonical_installation(&cfg.installation_dir()?)?,
        app_version: cfg.app_version.clone(),
        required_runtime: cfg.required_runtime.clone(),
    };
    let previous = read_optional::<InstalledBase>(&path)?;
    if let Some(previous) = previous {
        ensure!(
            previous.schema == STATE_SCHEMA,
            "unsupported installed base metadata schema"
        );
        ensure!(
            previous.installation == current.installation,
            "installed base metadata belongs to a different installation"
        );
        if previous.app_version != current.app_version
            || previous.required_runtime != current.required_runtime
        {
            let active = ActiveState {
                schema: STATE_SCHEMA,
                active: legacy_release(cfg)?,
                previous: None,
                txid: None,
            };
            write_active(cfg, &active)?;
            remove_file_if_exists(&updates_dir(cfg)?.join("pending.json"))?;
            remove_file_if_exists(&updates_dir(cfg)?.join("transaction.json"))?;
            remove_dir_if_exists(&updates_dir(cfg)?.join("attempts"))?;
            write_json(&path, &current)?;
            crate::runtime::register(cfg, &retained_releases(cfg)?)
                .context("reconcile runtime refs after installer base upgrade")?;
        }
        return Ok(());
    }
    // Older launchers did not record the installed base. A newer active release
    // can be a normal downloaded update, so preserve it until a subsequent
    // installer change can be compared with this first baseline marker.
    write_json(&path, &current)?;
    Ok(())
}

#[cfg(not(windows))]
fn canonical_installation(path: &Path) -> Result<String> {
    Ok(std::fs::canonicalize(path)
        .with_context(|| format!("canonicalize installation directory {}", path.display()))?
        .to_string_lossy()
        .into_owned())
}

#[cfg(not(windows))]
fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

/// Lock shared release metadata while registering runtimes or changing state.
/// Callers that perform a `retained_releases` + `runtime::register` pair must
/// hold this lock across both operations.
pub fn state_lock(cfg: &ShellConfig) -> Result<FileLock> {
    Ok(FileLock::exclusive(&updates_dir(cfg)?.join("state.lock"))?)
}

fn active_path(cfg: &ShellConfig) -> Result<PathBuf> {
    Ok(updates_dir(cfg)?.join("active.json"))
}

fn pending_path(cfg: &ShellConfig) -> Result<PathBuf> {
    Ok(updates_dir(cfg)?.join("pending.json"))
}

fn transaction_path(cfg: &ShellConfig) -> Result<PathBuf> {
    Ok(updates_dir(cfg)?.join("transaction.json"))
}

fn read_optional<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write(path, &bytes)
}

fn restore_pending(cfg: &ShellConfig, previous: Option<&PendingState>) -> Result<()> {
    let path = pending_path(cfg)?;
    if let Some(previous) = previous {
        write_json(&path, previous)
    } else {
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
        }
    }
}

fn register_current_releases(cfg: &ShellConfig) -> Result<()> {
    let retained = retained_releases(cfg)?;
    crate::runtime::register(cfg, &retained).context("register retained release runtimes")
}

fn legacy_release(cfg: &ShellConfig) -> Result<Release> {
    let resources_dir = cfg.resources_dir()?;
    let resources_dir = resources_dir
        .canonicalize()
        .with_context(|| format!("resolve legacy resources at {}", resources_dir.display()))?;
    let release = Release {
        app_version: cfg.app_version.clone(),
        runtime_key: RuntimeKey::current(&cfg.required_runtime),
        resources_dir,
        // The installer did not record the original package digest.
        artifact_sha256: String::new(),
    };
    validate_release_for_app(cfg, &release)?;
    Ok(release)
}

fn validate_release_for_app(cfg: &ShellConfig, release: &Release) -> Result<()> {
    release.validate()?;
    let resources = release
        .resources_dir
        .canonicalize()
        .with_context(|| format!("resolve resources at {}", release.resources_dir.display()))?;
    let legacy = cfg.resources_dir()?.canonicalize().ok();
    let releases_root = updates_dir(cfg)?.join("releases").canonicalize().ok();
    #[cfg(not(windows))]
    let legacy_releases_root = cfg
        .legacy_updates_dir()?
        .join("releases")
        .canonicalize()
        .ok();
    #[cfg(windows)]
    let legacy_releases_root: Option<PathBuf> = None;
    let is_legacy = legacy.as_ref().is_some_and(|root| root == &resources);
    let is_managed = releases_root
        .as_ref()
        .is_some_and(|root| resources.starts_with(root));
    let is_legacy_managed = legacy_releases_root
        .as_ref()
        .is_some_and(|root| resources.starts_with(root));
    ensure!(
        is_legacy || is_managed || is_legacy_managed,
        "release resources path is outside the app release directories"
    );
    Ok(())
}

fn read_active(cfg: &ShellConfig) -> Result<ActiveState> {
    match read_state_file::<ActiveState>(cfg, "active.json")? {
        Some(state) => {
            ensure!(
                state.schema == STATE_SCHEMA,
                "unsupported active.json schema {}",
                state.schema
            );
            validate_release_for_app(cfg, &state.active)?;
            if let Some(previous) = &state.previous {
                validate_release_for_app(cfg, previous)?;
            }
            Ok(state)
        }
        None => Ok(ActiveState {
            schema: STATE_SCHEMA,
            active: legacy_release(cfg)?,
            previous: None,
            txid: None,
        }),
    }
}

/// Resolve the release to launch. Existing installs without active.json keep
/// using their original `resources/` directory and shell.toml versions.
pub fn resolve_active(cfg: &ShellConfig) -> Result<Release> {
    let _state = FileLock::shared(&updates_dir(cfg)?.join("state.lock"))?;
    Ok(read_active(cfg)?.active)
}

fn release_key(release: &Release) -> (String, String, String) {
    (
        release.app_version.clone(),
        release.runtime_key.version.clone(),
        release.artifact_sha256.to_ascii_lowercase(),
    )
}

fn is_same_immutable_release(
    active: &Release,
    app_version: &str,
    runtime_key: &RuntimeKey,
    artifact_sha: &str,
) -> Result<bool> {
    if active.app_version != app_version {
        return Ok(false);
    }
    ensure!(
        active.runtime_key == *runtime_key,
        "app version {app_version} is immutable and cannot change its runtime"
    );
    // Legacy metadata has no ZIP digest (its old asar-only hash is not
    // comparable), so version + runtime is the only safe identity available.
    if active.artifact_sha256.is_empty() {
        return Ok(true);
    }
    ensure!(
        active.artifact_sha256.eq_ignore_ascii_case(artifact_sha),
        "app version {app_version} already exists with a different release hash"
    );
    Ok(true)
}

/// Releases whose runtimes must remain registered for activation or rollback.
pub fn retained_releases(cfg: &ShellConfig) -> Result<Vec<Release>> {
    let active = read_active(cfg)?;
    let mut releases = vec![active.active];
    releases.extend(active.previous);

    if let Some(pending) = read_state_file::<PendingState>(cfg, "pending.json")? {
        ensure!(
            pending.schema == STATE_SCHEMA,
            "unsupported pending.json schema {}",
            pending.schema
        );
        validate_release_for_app(cfg, &pending.release)?;
        releases.push(pending.release.clone());
    }

    if let Some(transaction) = read_state_file::<Transaction>(cfg, "transaction.json")? {
        ensure!(
            transaction.schema == STATE_SCHEMA,
            "unsupported transaction.json schema {}",
            transaction.schema
        );
        if matches!(
            transaction.phase,
            TxPhase::Prepared | TxPhase::AwaitingHealth
        ) {
            validate_release_for_app(cfg, &transaction.from)?;
            validate_release_for_app(cfg, &transaction.to)?;
            releases.push(transaction.from);
            releases.push(transaction.to);
        }
    }

    let mut seen = HashSet::new();
    releases.retain(|release| seen.insert(release_key(release)));
    Ok(releases)
}

fn normalized_sha256(value: &str) -> Result<String> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "artifact SHA256 must be 64 hex characters"
    );
    Ok(value.to_ascii_lowercase())
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

fn safe_app_version(version: &str) -> Result<()> {
    let parsed = semver::Version::parse(version).context("invalid app release version")?;
    ensure!(
        parsed.to_string() == version,
        "app version is not canonical semver"
    );
    ensure!(
        !version.contains('/') && !version.contains('\\'),
        "app version cannot contain path separators"
    );
    Ok(())
}

fn release_resources_path(updates: &Path, version: &str, sha256: &str) -> PathBuf {
    updates
        .join("releases")
        .join(version)
        .join(sha256)
        .join("resources")
}

fn release_marker_path(resources_dir: &Path) -> PathBuf {
    resources_dir
        .parent()
        .unwrap_or(resources_dir)
        .join("release.json")
}

#[derive(Serialize, Deserialize)]
struct ReleaseMarker {
    schema: u32,
    app_version: String,
    runtime_key: RuntimeKey,
    artifact_sha256: String,
}

fn marker_matches(resources_dir: &Path, release: &Release) -> Result<bool> {
    let Some(marker) = read_optional::<ReleaseMarker>(&release_marker_path(resources_dir))? else {
        return Ok(false);
    };
    Ok(marker.schema == STATE_SCHEMA
        && marker.app_version == release.app_version
        && marker.runtime_key == release.runtime_key
        && marker
            .artifact_sha256
            .eq_ignore_ascii_case(&release.artifact_sha256))
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

fn verify_archive_layout(root: &Path) -> Result<()> {
    let asar = root.join("app.asar");
    ensure!(
        asar.is_file() && asar.metadata()?.len() > 0,
        "release zip must contain a non-empty root app.asar"
    );
    let unpacked = root.join("app.asar.unpacked");
    ensure!(
        !unpacked.exists() || unpacked.is_dir(),
        "app.asar.unpacked must be a directory"
    );
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        ensure!(
            name == "app.asar" || name == "app.asar.unpacked",
            "unexpected top-level release entry: {}",
            name.to_string_lossy()
        );
    }
    Ok(())
}

fn stage_payload(
    cfg: &ShellConfig,
    app_version: &str,
    runtime_key: &RuntimeKey,
    artifact: &Artifact,
    artifact_sha: &str,
    on_progress: ProgressFn,
) -> Result<Release> {
    let updates = updates_dir(cfg)?;
    let release_dir = updates
        .join("releases")
        .join(app_version)
        .join(artifact_sha);
    let resources_dir = release_dir.join("resources");
    let release = Release {
        app_version: app_version.to_owned(),
        runtime_key: runtime_key.clone(),
        resources_dir: resources_dir.clone(),
        artifact_sha256: artifact_sha.to_owned(),
    };

    if resources_dir.is_dir() && marker_matches(&resources_dir, &release)? {
        validate_release_for_app(cfg, &release)?;
        return Ok(release);
    }

    // Release paths are immutable, even when orphaned or incomplete. Never
    // replace an existing version/hash directory in place.
    ensure!(
        !release_dir.exists(),
        "release path already exists without a valid completion marker: {}",
        release_dir.display()
    );

    let work = updates
        .join("staging")
        .join(format!("release-{app_version}-{artifact_sha}"));
    fs::create_dir_all(&work)?;
    let normalized_artifact = Artifact {
        sha256: artifact_sha.to_owned(),
        ..artifact.clone()
    };
    let package_path = download::download(&normalized_artifact, &work, on_progress)?;
    ensure!(
        hash_file(&package_path)?.eq_ignore_ascii_case(artifact_sha),
        "downloaded release hash changed after verification"
    );

    let payload = work.join("payload");
    remove_dir_if_exists(&payload)?;
    let extracted = work.join("extracted");
    remove_dir_if_exists(&extracted)?;
    download::unzip(&package_path, &extracted).context("extract application release")?;
    verify_archive_layout(&extracted)?;
    let payload_resources = payload.join("resources");
    fs::create_dir_all(&payload)?;
    fs::rename(&extracted, &payload_resources).context("prepare immutable release directory")?;
    let marker = ReleaseMarker {
        schema: STATE_SCHEMA,
        app_version: app_version.to_owned(),
        runtime_key: runtime_key.clone(),
        artifact_sha256: artifact_sha.to_owned(),
    };
    write_json(&release_marker_path(&payload_resources), &marker)?;
    let staged = Release {
        resources_dir: payload_resources,
        ..release.clone()
    };
    // The payload is intentionally under updates/staging while being built;
    // only its release metadata path is permitted to remain there temporarily.
    staged.validate()?;

    if let Some(parent) = release_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&payload, &release_dir).context("publish immutable application release")?;
    let _ = fs::remove_dir_all(&work);
    validate_release_for_app(cfg, &release)?;
    ensure!(
        marker_matches(&resources_dir, &release)?,
        "published release marker missing"
    );
    Ok(release)
}

/// Download, verify and stage the manifest's application release. This never
/// changes active.json or files used by a running Electron process.
pub fn stage(cfg: &ShellConfig, manifest: &Manifest, on_progress: ProgressFn) -> Result<()> {
    let updates = updates_dir(cfg)?;
    let _staging_lock = FileLock::exclusive(&updates.join("staging.lock"))?;
    ensure!(manifest.app_id == cfg.app_id, "manifest app_id mismatch");

    let (active, pending_at_start) = {
        let _state = FileLock::shared(&updates.join("state.lock"))?;
        (
            read_active(cfg)?.active,
            read_state_file::<PendingState>(cfg, "pending.json")?,
        )
    };
    safe_app_version(&manifest.app.version)?;
    let candidate_version = semver::Version::parse(&manifest.app.version)?;
    let active_version = semver::Version::parse(&active.app_version)?;
    if candidate_version < active_version {
        bail!(
            "manifest app version {} is older than active {}",
            manifest.app.version,
            active.app_version
        );
    }

    let runtime_key = manifest.runtime_key();
    runtime_key.validate()?;
    let artifact_sha = normalized_sha256(&manifest.app.asar.sha256)?;
    if is_same_immutable_release(&active, &manifest.app.version, &runtime_key, &artifact_sha)? {
        return Ok(());
    }

    if let Some(pending) = pending_at_start {
        let pending_version = semver::Version::parse(&pending.release.app_version)?;
        if pending_version > candidate_version {
            return Ok(()); // Do not replace a newer staged release with a stale manifest.
        }
    }

    let runtime_artifact = manifest.runtime_artifact_for(&runtime_key)?;
    crate::runtime::ensure_for(cfg, &runtime_key, runtime_artifact, Box::new(|_, _| {}))
        .context("ensure release Electron runtime")?;

    let release = stage_payload(
        cfg,
        &manifest.app.version,
        &runtime_key,
        &manifest.app.asar,
        &artifact_sha,
        on_progress,
    )?;
    validate_release_for_app(cfg, &release)?;

    // Serialize the runtime-reference update with launch-side registration
    // and activation. Downloads and extraction intentionally happen outside
    // this lock so a long network transfer never blocks startup.
    let _state = state_lock(cfg)?;
    let active = read_active(cfg)?.active;
    let active_version = semver::Version::parse(&active.app_version)?;
    ensure!(
        candidate_version >= active_version,
        "active release advanced while staging"
    );
    if is_same_immutable_release(&active, &manifest.app.version, &runtime_key, &artifact_sha)? {
        return Ok(());
    }
    let previous_pending = read_optional::<PendingState>(&pending_path(cfg)?)?;
    if let Some(pending) = &previous_pending {
        let pending_version = semver::Version::parse(&pending.release.app_version)?;
        if pending_version > candidate_version {
            return Ok(());
        }
        if pending.release.app_version == manifest.app.version {
            ensure!(
                pending.release.runtime_key == runtime_key,
                "same app version cannot change runtime"
            );
            ensure!(
                pending
                    .release
                    .artifact_sha256
                    .eq_ignore_ascii_case(&artifact_sha),
                "same app version has a conflicting immutable release hash"
            );
        }
    }

    // Commit the new pending pointer first so retained_releases computes the
    // exact post-commit set (excluding a superseded pending release). If
    // registration fails, restore both metadata and the references derived
    // from that restored state before returning the error.
    let pending = PendingState {
        schema: STATE_SCHEMA,
        release,
    };
    let pending_file = pending_path(cfg)?;
    write_json(&pending_file, &pending)?;
    if let Err(register_error) = register_current_releases(cfg) {
        let restore_result = (|| -> Result<()> {
            restore_pending(cfg, previous_pending.as_ref())?;
            register_current_releases(cfg)
                .context("restore runtime references for previous pending release")?;
            Ok(())
        })();
        return match restore_result {
            Ok(()) => Err(register_error).context("register staged release runtimes; previous pending state restored"),
            Err(restore_error) => Err(anyhow::anyhow!(
                "register staged release runtimes failed: {register_error:#}; restoring previous pending state also failed: {restore_error:#}"
            )),
        };
    }
    Ok(())
}

fn next_txid() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

fn ready_file(cfg: &ShellConfig, txid: &str) -> Result<PathBuf> {
    Ok(updates_dir(cfg)?
        .join("attempts")
        .join(format!("{txid}.ready.json")))
}

fn read_ready(transaction: &Transaction) -> bool {
    #[derive(Deserialize)]
    struct Ready {
        txid: String,
        ready: bool,
    }
    fs::read(&transaction.ready_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Ready>(&bytes).ok())
        .is_some_and(|ready| ready.ready && ready.txid == transaction.txid)
}

fn attempt_should_commit(status_code: i32, ready: bool) -> bool {
    // An explicit marker is authoritative even if Electron later exits nonzero.
    // Without the protocol, zero exit is only a weak success signal: ordinary
    // Electron apps cannot tell the shell when business health is established.
    ready || status_code == 0
}

fn same_process_alive(transaction: &Transaction) -> bool {
    let Some(pid) = transaction.attempt_pid else {
        return false;
    };
    if !process::is_alive(pid) {
        return false;
    }
    match (transaction.attempt_start_time, process::start_time(pid)) {
        (Some(expected), Ok(actual)) if expected != 0 && actual != 0 => expected == actual,
        _ => true, // Unknown identity is treated conservatively; never roll back a possibly live app.
    }
}

fn write_active(cfg: &ShellConfig, state: &ActiveState) -> Result<()> {
    write_json(&active_path(cfg)?, state)
}

fn commit_transaction(cfg: &ShellConfig, transaction: &mut Transaction) -> Result<()> {
    let mut active = read_active(cfg)?;
    if active.active != transaction.to {
        ensure!(
            active.active == transaction.from,
            "active release changed during update transaction"
        );
        active = ActiveState {
            schema: STATE_SCHEMA,
            active: transaction.to.clone(),
            previous: Some(transaction.from.clone()),
            txid: Some(transaction.txid.clone()),
        };
        write_active(cfg, &active)?;
    }
    transaction.phase = TxPhase::Committed;
    write_json(&transaction_path(cfg)?, transaction)?;
    remove_pending_if(cfg, &transaction.to)?;
    Ok(())
}

fn remove_pending_if(cfg: &ShellConfig, release: &Release) -> Result<()> {
    let path = pending_path(cfg)?;
    if let Some(pending) = read_optional::<PendingState>(&path)? {
        if pending.release == *release {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("remove {}", path.display()))
                }
            }
        }
    }
    Ok(())
}

fn rollback_transaction(cfg: &ShellConfig, transaction: &mut Transaction) -> Result<Release> {
    let mut active = read_active(cfg)?;
    ensure!(
        active.active == transaction.to || active.active == transaction.from,
        "cannot roll back an unrelated active release"
    );
    active.active = transaction.from.clone();
    active.previous = None;
    active.txid = None;
    write_active(cfg, &active)?;
    transaction.phase = TxPhase::RolledBack;
    write_json(&transaction_path(cfg)?, transaction)?;
    remove_pending_if(cfg, &transaction.to)?;
    let retained = retained_releases(cfg)?;
    crate::runtime::register(cfg, &retained).context("refresh runtime refs after rollback")?;
    Ok(transaction.from.clone())
}

fn recover_transaction(cfg: &ShellConfig) -> Result<Option<Release>> {
    let Some(mut transaction) = read_optional::<Transaction>(&transaction_path(cfg)?)? else {
        return Ok(None);
    };
    ensure!(
        transaction.schema == STATE_SCHEMA,
        "unsupported transaction.json schema {}",
        transaction.schema
    );
    validate_release_for_app(cfg, &transaction.from)?;
    validate_release_for_app(cfg, &transaction.to)?;
    let active = read_active(cfg)?;

    match transaction.phase {
        TxPhase::Prepared => {
            if active.active == transaction.to {
                // Crash after active.json was replaced but before phase update.
                transaction.phase = TxPhase::AwaitingHealth;
                write_json(&transaction_path(cfg)?, &transaction)?;
                Ok(None)
            } else if active.active == transaction.from {
                transaction.phase = TxPhase::RolledBack;
                write_json(&transaction_path(cfg)?, &transaction)?;
                Ok(None)
            } else {
                bail!("prepared transaction does not match active release");
            }
        }
        TxPhase::AwaitingHealth => {
            if read_ready(&transaction) {
                commit_transaction(cfg, &mut transaction)?;
                return Ok(None);
            }
            if transaction.attempt_pid.is_none() {
                return Ok(None);
            }
            if same_process_alive(&transaction) {
                bail!(
                    "release attempt {} is still running without a readiness marker; refusing a duplicate launch",
                    transaction.txid
                );
            }
            Ok(Some(rollback_transaction(cfg, &mut transaction)?))
        }
        TxPhase::Committed => {
            if active.active == transaction.to {
                remove_pending_if(cfg, &transaction.to)?;
            }
            Ok(None)
        }
        TxPhase::RolledBack => {
            remove_pending_if(cfg, &transaction.to)?;
            Ok(None)
        }
    }
}

/// Activate the latest staged release. The caller must hold the app's
/// application.lock while this function runs and while Electron is launched.
pub fn activate_pending(cfg: &ShellConfig) -> Result<Option<Release>> {
    let _state = state_lock(cfg)?;
    if let Some(rolled_back) = recover_transaction(cfg)? {
        return Ok(Some(rolled_back));
    }

    let Some(pending) = read_optional::<PendingState>(&pending_path(cfg)?)? else {
        return Ok(None);
    };
    ensure!(
        pending.schema == STATE_SCHEMA,
        "unsupported pending.json schema {}",
        pending.schema
    );
    validate_release_for_app(cfg, &pending.release)?;
    let active = read_active(cfg)?;
    if pending.release == active.active {
        remove_pending_if(cfg, &pending.release)?;
        return Ok(None);
    }
    // Runtime installation may have been cleaned up since staging. Never point
    // active.json at a release whose exact runtime cannot be located.
    crate::runtime::locate_for(cfg, &pending.release.runtime_key)
        .context("locate pending release runtime")?;

    let txid = next_txid();
    let mut transaction = Transaction {
        schema: STATE_SCHEMA,
        txid: txid.clone(),
        from: active.active.clone(),
        to: pending.release.clone(),
        phase: TxPhase::Prepared,
        ready_file: ready_file(cfg, &txid)?,
        attempt_pid: None,
        attempt_start_time: None,
        exit_code: None,
    };
    write_json(&transaction_path(cfg)?, &transaction)?;

    let next_active = ActiveState {
        schema: STATE_SCHEMA,
        active: pending.release.clone(),
        previous: Some(active.active),
        txid: Some(txid),
    };
    write_active(cfg, &next_active)?;
    transaction.phase = TxPhase::AwaitingHealth;
    write_json(&transaction_path(cfg)?, &transaction)?;
    Ok(Some(pending.release))
}

/// Record the update attempt immediately after spawning Electron. The caller
/// passes the returned path to the app as ERS_READY_FILE and txid as
/// ERS_RELEASE_TXID.
pub fn mark_started(cfg: &ShellConfig, pid: u32) -> Result<Option<PathBuf>> {
    let _state = state_lock(cfg)?;
    let path = transaction_path(cfg)?;
    let Some(mut transaction) = read_optional::<Transaction>(&path)? else {
        return Ok(None);
    };
    if transaction.phase != TxPhase::AwaitingHealth || read_active(cfg)?.active != transaction.to {
        return Ok(None);
    }
    if let Some(parent) = transaction.ready_file.parent() {
        fs::create_dir_all(parent)?;
    }
    // The launcher calls once before spawn to get the path, then once with the
    // child PID. Preserve a marker written during that short handoff window.
    let provisional_parent_pid = transaction.attempt_pid == Some(std::process::id());
    if !provisional_parent_pid && !read_ready(&transaction) {
        match fs::remove_file(&transaction.ready_file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "clear readiness marker {}",
                        transaction.ready_file.display()
                    )
                })
            }
        }
    }
    transaction.attempt_pid = Some(pid);
    transaction.attempt_start_time = process::start_time(pid).ok();
    transaction.exit_code = None;
    write_json(&path, &transaction)?;
    Ok(Some(transaction.ready_file))
}

/// Current probation transaction id, if the active release is awaiting health.
pub fn attempt_id(cfg: &ShellConfig) -> Result<Option<String>> {
    let _state = FileLock::shared(&updates_dir(cfg)?.join("state.lock"))?;
    let Some(transaction) = read_optional::<Transaction>(&transaction_path(cfg)?)? else {
        return Ok(None);
    };
    if transaction.phase == TxPhase::AwaitingHealth && read_active(cfg)?.active == transaction.to {
        Ok(Some(transaction.txid))
    } else {
        Ok(None)
    }
}

/// Finish the current app attempt. A ready marker commits the new release even
/// if Electron later exits non-zero. A zero exit without a marker is a weak
/// success signal for ordinary Electron apps that cannot report readiness;
/// nonzero exits before readiness restore the previous release.
pub fn finish_attempt(cfg: &ShellConfig, status_code: i32, ready: bool) -> Result<()> {
    let _state = state_lock(cfg)?;
    let path = transaction_path(cfg)?;
    let Some(mut transaction) = read_optional::<Transaction>(&path)? else {
        return Ok(());
    };
    if transaction.phase != TxPhase::AwaitingHealth {
        return Ok(());
    }
    transaction.exit_code = Some(status_code);
    if attempt_should_commit(status_code, ready || read_ready(&transaction)) {
        commit_transaction(cfg, &mut transaction)
    } else {
        let _ = rollback_transaction(cfg, &mut transaction)?;
        Ok(())
    }
}

/// Roll back to the last retained release by atomically changing metadata only.
pub fn rollback(cfg: &ShellConfig) -> Result<Release> {
    let _state = state_lock(cfg)?;
    let mut active = read_active(cfg)?;
    let previous = active
        .previous
        .clone()
        .context("no previous release to roll back to")?;
    let failed = active.active.clone();
    active.active = previous.clone();
    active.previous = None;
    active.txid = None;
    write_active(cfg, &active)?;
    remove_pending_if(cfg, &failed)?;
    if let Some(mut transaction) = read_optional::<Transaction>(&transaction_path(cfg)?)? {
        if transaction.to == failed {
            transaction.phase = TxPhase::RolledBack;
            write_json(&transaction_path(cfg)?, &transaction)?;
        }
    }
    crate::runtime::register(cfg, &retained_releases(cfg)?)
        .context("refresh runtime refs after rollback")?;
    Ok(previous)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn first_installer_baseline_preserves_an_existing_downloaded_release() {
        let temp = tempfile::tempdir().unwrap();
        let config_path = temp.path().join("minitron.toml");
        std::fs::write(&config_path, "app_id='test.legacy-base'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n").unwrap();
        let cfg = ShellConfig::load_from(&config_path).unwrap();
        let updates = cfg.updates_dir().unwrap();
        let resources = updates
            .join("releases/2.0.0")
            .join("a".repeat(64))
            .join("resources");
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(resources.join("app.asar"), b"downloaded app").unwrap();
        let active = ActiveState {
            schema: STATE_SCHEMA,
            active: Release {
                app_version: "2.0.0".into(),
                runtime_key: RuntimeKey::current("32.2.0"),
                resources_dir: resources.canonicalize().unwrap(),
                artifact_sha256: "a".repeat(64),
            },
            previous: None,
            txid: None,
        };
        write_active(&cfg, &active).unwrap();
        reconcile_installed_base(&cfg).unwrap();
        assert_eq!(read_active(&cfg).unwrap().active, active.active);
        let base: InstalledBase = read_optional(&updates.join(INSTALLED_BASE_FILE))
            .unwrap()
            .unwrap();
        assert_eq!(base.app_version, "1.0.0");
        std::fs::remove_dir_all(updates.parent().unwrap()).unwrap();
    }

    #[test]
    fn release_paths_are_version_and_hash_scoped() {
        let root = Path::new("app-root");
        let updates = root.join("updates");
        let path = release_resources_path(&updates, "1.2.3", &"a".repeat(64));
        assert_eq!(
            path,
            root.join("updates")
                .join("releases")
                .join("1.2.3")
                .join("a".repeat(64))
                .join("resources")
        );
    }

    #[test]
    fn sha256_requires_exact_hex_digest() {
        assert_eq!(normalized_sha256(&"A".repeat(64)).unwrap(), "a".repeat(64));
        assert!(normalized_sha256("xyz").is_err());
        assert!(normalized_sha256(&"g".repeat(64)).is_err());
    }

    #[test]
    fn rejects_path_versions_before_staging() {
        assert!(safe_app_version("../1.2.3").is_err());
        assert!(safe_app_version("1.2.3").is_ok());
    }

    #[test]
    fn same_release_identity_handles_legacy_and_immutable_hashes() {
        let runtime_key = RuntimeKey {
            platform: "win32-x64".into(),
            version: "32.2.0".into(),
        };
        let legacy = Release {
            app_version: "1.2.3".into(),
            runtime_key: runtime_key.clone(),
            resources_dir: PathBuf::from(r"C:\App\resources"),
            artifact_sha256: String::new(),
        };
        assert!(
            is_same_immutable_release(&legacy, "1.2.3", &runtime_key, &"a".repeat(64)).unwrap()
        );

        let managed = Release {
            artifact_sha256: "a".repeat(64),
            ..legacy
        };
        assert!(
            is_same_immutable_release(&managed, "1.2.3", &runtime_key, &"A".repeat(64)).unwrap()
        );
        assert!(
            is_same_immutable_release(&managed, "1.2.3", &runtime_key, &"b".repeat(64)).is_err()
        );
        let other_runtime = RuntimeKey {
            version: "33.0.0".into(),
            ..runtime_key.clone()
        };
        assert!(
            is_same_immutable_release(&managed, "1.2.3", &other_runtime, &"a".repeat(64)).is_err()
        );
    }

    #[test]
    fn readiness_or_zero_exit_commits_but_failed_unready_attempt_rolls_back() {
        assert!(attempt_should_commit(0, false));
        assert!(attempt_should_commit(1, true));
        assert!(!attempt_should_commit(1, false));
    }
}
