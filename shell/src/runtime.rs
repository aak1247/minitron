//! Shared Electron runtime lookup, transactional installation, references and leases.

use crate::config::{platform_triple, runtime_root, ShellConfig};
use crate::download::{self, ProgressFn};
use crate::fsutil::{atomic_write, FileLock};
use crate::manifest::Artifact;
use crate::process;
use crate::release::{Release, RuntimeKey};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const INSTALL_MARKER: &str = "install.json";
const INSTALL_MARKER_SCHEMA_VERSION: u32 = 2;
const REFS_FILE: &str = "refs.json";
#[cfg(unix)]
const INSTALLATIONS_FILE: &str = "installations.json";
#[cfg(unix)]
const INSTALLATIONS_SCHEMA: u32 = 1;

#[derive(Debug, Clone)]
pub struct Runtime {
    pub version: String,
    /// Electron executable path.
    pub electron_bin: PathBuf,
    pub root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct InstallMarker {
    schema_version: u32,
    platform: String,
    version: String,
    artifact_sha256: String,
    electron_bin_size: u64,
    default_app_asar_size: u64,
    electron_bin_sha256: String,
    default_app_asar_sha256: String,
}

#[derive(Default, Serialize, Deserialize)]
struct RefCounts {
    /// Runtime key -> canonical application installation directories.
    #[serde(default)]
    map: BTreeMap<String, BTreeSet<String>>,
}

#[cfg(unix)]
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct InstallationLocator {
    schema: u32,
    installations: Vec<InstallationLocatorEntry>,
}

#[cfg(unix)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct InstallationLocatorEntry {
    path: String,
    #[serde(rename = "runtimeRoot")]
    runtime_root: String,
}

/// Resolve this installation's configured root. Explicit overrides win; absent
/// one, a previously registered per-user locator preserves custom roots.
pub fn runtime_root_for_config(cfg: &ShellConfig) -> Result<PathBuf> {
    #[cfg(windows)]
    let _ = cfg;
    if std::env::var_os("ELECTRON_RUNTIME_ROOT").is_some_and(|value| !value.is_empty()) {
        let root = runtime_root();
        ensure!(root.is_absolute(), "ELECTRON_RUNTIME_ROOT must be absolute");
        return Ok(root);
    }
    #[cfg(unix)]
    {
        if let Some(root) = locator_root_for_config(cfg)? {
            return Ok(root);
        }
    }
    Ok(runtime_root())
}

/// Read-only discovery entry used by system installer/uninstaller scripts.
/// It never falls back to another user's or root's cache.
pub fn runtime_root_for_installation(cfg: &ShellConfig) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let _ = cfg;
        return Ok(runtime_root());
    }
    #[cfg(unix)]
    {
        if let Some(root) = locator_root_for_config(cfg)? {
            return Ok(root);
        }
        let install = canonical_install_path(&cfg.installation_dir()?)?;
        let default_root = runtime_root();
        ensure!(
            refs_contain_installation(&default_root, &install)?,
            "no runtime root is recorded for this installation"
        );
        Ok(default_root)
    }
}

#[cfg(unix)]
fn locator_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("cannot resolve current user's home directory")?;
    #[cfg(target_os = "macos")]
    let directory = home.join("Library/Application Support/SharedElectron");
    #[cfg(not(target_os = "macos"))]
    let directory = home.join(".local/share/SharedElectron");
    Ok(directory.join(INSTALLATIONS_FILE))
}

#[cfg(unix)]
fn read_locator() -> Result<InstallationLocator> {
    let path = locator_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            let locator: InstallationLocator = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse installation locator {}", path.display()))?;
            ensure!(
                locator.schema == INSTALLATIONS_SCHEMA,
                "unsupported installation locator schema"
            );
            Ok(locator)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(InstallationLocator {
            schema: INSTALLATIONS_SCHEMA,
            installations: Vec::new(),
        }),
        Err(error) => {
            Err(error).with_context(|| format!("read installation locator {}", path.display()))
        }
    }
}

#[cfg(unix)]
fn locator_root_for_config(cfg: &ShellConfig) -> Result<Option<PathBuf>> {
    let install = canonical_install_path(&cfg.installation_dir()?)?;
    locator_root_for_path(&read_locator()?, &install)
}

#[cfg(unix)]
fn locator_root_for_path(locator: &InstallationLocator, install: &str) -> Result<Option<PathBuf>> {
    let Some(entry) = locator
        .installations
        .iter()
        .find(|entry| entry.path == install)
    else {
        return Ok(None);
    };
    let root = PathBuf::from(&entry.runtime_root);
    ensure!(
        root.is_absolute(),
        "installation locator runtimeRoot must be absolute"
    );
    Ok(Some(root))
}

#[cfg(unix)]
fn upsert_locator(install: &str, root: &Path) -> Result<()> {
    let path = locator_path()?;
    let lock_path = path.with_extension("lock");
    let _lock = FileLock::exclusive(&lock_path)?;
    let canonical_root = std::fs::canonicalize(root)
        .with_context(|| format!("canonicalize runtime root {}", root.display()))?;
    let mut locator = read_locator()?;
    locator.installations.retain(|entry| entry.path != install);
    locator.installations.push(InstallationLocatorEntry {
        path: install.to_owned(),
        runtime_root: canonical_root.to_string_lossy().into_owned(),
    });
    locator.installations.sort_by(|a, b| a.path.cmp(&b.path));
    atomic_write(&path, &serde_json::to_vec_pretty(&locator)?)
}

#[cfg(unix)]
fn remove_locator(install: &str) -> Result<()> {
    let path = locator_path()?;
    if !path.exists() {
        return Ok(());
    }
    let lock_path = path.with_extension("lock");
    let _lock = FileLock::exclusive(&lock_path)?;
    let mut locator = read_locator()?;
    locator.installations.retain(|entry| entry.path != install);
    atomic_write(&path, &serde_json::to_vec_pretty(&locator)?)
}

#[cfg(unix)]
fn refs_contain_installation(root: &Path, install: &str) -> Result<bool> {
    let refs = read_refs(root)?;
    Ok(refs
        .map
        .values()
        .any(|installations| installations.contains(install)))
}

#[derive(Debug, Serialize, Deserialize)]
struct LeaseRecord {
    owner_pid: u32,
    owner_start_time: u64,
    child_pid: Option<u32>,
    child_start_time: Option<u64>,
}

pub fn locate_for(cfg: &ShellConfig, key: &RuntimeKey) -> Result<Runtime> {
    locate_at(&runtime_root_for_config(cfg)?, key)
}

pub fn ensure_for(
    cfg: &ShellConfig,
    key: &RuntimeKey,
    artifact: &Artifact,
    on_progress: ProgressFn,
) -> Result<Runtime> {
    ensure_at(&runtime_root_for_config(cfg)?, key, artifact, on_progress)
}

fn ensure_at(
    root: &Path,
    key: &RuntimeKey,
    artifact: &Artifact,
    on_progress: ProgressFn,
) -> Result<Runtime> {
    let result = ensure_inner(root, key, artifact, on_progress);
    if let Err(error) = &result {
        // GUI preparation keeps its retry window open, so the main error handler
        // may not run. Retain the underlying failure in redirected diagnostics.
        eprintln!("RUNTIME_INSTALL_ERROR: {error:#}");
    }
    result
}

fn ensure_inner(
    root: &Path,
    key: &RuntimeKey,
    artifact: &Artifact,
    on_progress: ProgressFn,
) -> Result<Runtime> {
    validate_host_key(key)?;
    validate_artifact(artifact)?;

    let root = root.to_path_buf();
    let locks = root.join("locks");
    std::fs::create_dir_all(&locks).context("create runtime lock directory")?;
    let install_lock_path = locks.join(format!("install-{}.lock", key_id(key)));
    let _install_lock = FileLock::exclusive(&install_lock_path)?;

    if let Ok(runtime) = locate_at(&root, key) {
        return Ok(runtime);
    }

    let versions_dir = root.join("versions").join(&key.platform);
    let dest = version_dir(&root, key);
    std::fs::create_dir_all(&versions_dir).context("create runtime versions directory")?;

    // A broken runtime can only be replaced after every shell and Electron child
    // has released it. Never remove a directory which may still be in use.
    let lease_lock_path = usage_lock_path(&root, key);
    let _exclusive_usage = FileLock::try_exclusive(&lease_lock_path)?
        .context("runtime is in use and cannot be repaired safely")?;
    ensure!(
        ensure_no_live_lease_records(&root, key)?,
        "runtime has a live process lease and cannot be repaired safely"
    );

    // Keep partial downloads across failed calls. Extraction remains isolated
    // in a unique temporary directory and is removed on every exit path.
    let artifact_hash = normalize_sha256(&artifact.sha256)?;
    let download_dir = root
        .join("staging")
        .join(key_id(key))
        .join(&artifact_hash)
        .join("download");
    std::fs::create_dir_all(&download_dir).context("create persistent download directory")?;
    let package = download::download(artifact, &download_dir, on_progress)?;
    eprintln!("RUNTIME_ARCHIVE_VERIFIED:{}", key_id(key));

    let stage = unique_staging_path(&root, key);
    std::fs::create_dir_all(&stage).context("create runtime staging directory")?;
    let extracted = stage.join("runtime");
    let _cleanup = RemoveDirOnDrop(stage.clone());

    download::unzip(&package, &extracted).context("extract Electron runtime")?;
    eprintln!("RUNTIME_EXTRACTED:{}", key_id(key));

    let (electron_bin, default_app_asar, bin_meta, asar_meta) =
        validate_runtime_structure(&extracted, key)?;

    let marker = InstallMarker {
        schema_version: INSTALL_MARKER_SCHEMA_VERSION,
        platform: key.platform.clone(),
        version: key.version.clone(),
        artifact_sha256: artifact_hash,
        electron_bin_size: bin_meta.len(),
        default_app_asar_size: asar_meta.len(),
        electron_bin_sha256: sha256_file(&electron_bin)?,
        default_app_asar_sha256: sha256_file(&default_app_asar)?,
    };
    atomic_write(
        &extracted.join(INSTALL_MARKER),
        &serde_json::to_vec_pretty(&marker)?,
    )?;

    // Keep the previously committed directory recoverable until the staged
    // runtime is in place. Both directories live on the same filesystem.
    let backup = unique_backup_path(&dest);
    let had_old = dest.exists();
    if had_old {
        std::fs::rename(&dest, &backup).context("move incomplete runtime aside")?;
    }
    if let Err(error) = std::fs::rename(&extracted, &dest) {
        if had_old {
            let _ = std::fs::rename(&backup, &dest);
        }
        return Err(error).context("commit staged runtime");
    }
    if had_old {
        // Failure to remove a stale backup does not invalidate the committed runtime.
        let _ = std::fs::remove_dir_all(backup);
    }

    let runtime = locate_at(&root, key).context("validate committed runtime")?;
    // A verified archive is reproducible from the committed runtime. Drop the
    // persistent partial/complete download only after the commit marker passes.
    let _ = std::fs::remove_dir_all(download_dir);
    eprintln!("RUNTIME_READY:{}", key_id(key));
    Ok(runtime)
}

/// Register every runtime used by the active/previous/pending releases. Repeated
/// calls for the same installation and release set are idempotent.
pub fn register(cfg: &ShellConfig, releases: &[Release]) -> Result<()> {
    let install_path = canonical_install_path(&cfg.installation_dir()?)?;
    let root = runtime_root_for_config(cfg)?;
    std::fs::create_dir_all(&root).context("create runtime root")?;
    #[cfg(unix)]
    upsert_locator(&install_path, &root)?;
    register_at(&root, &install_path, releases)
}

/// Remove this installation's references. A runtime is reclaimed only after its
/// final reference is gone and no shell/Electron process holds a usage lease.
pub fn unregister_and_maybe_cleanup(cfg: &ShellConfig) -> Result<()> {
    let install_path = canonical_install_path(&cfg.installation_dir()?)?;
    let root = runtime_root_for_config(cfg)?;
    #[cfg(not(windows))]
    let state_id = crate::config::installation_state_id(&cfg.installation_dir()?)?;
    #[cfg(not(windows))]
    ensure!(
        cfg.updates_dir()? == root.join("installations").join(&state_id).join("updates"),
        "installation state path does not match its runtime root and identity"
    );
    unregister_at(&root, &install_path)?;
    #[cfg(not(windows))]
    {
        let canonical_root = std::fs::canonicalize(&root)
            .with_context(|| format!("canonicalize runtime root {}", root.display()))?;
        remove_installation_state(&canonical_root, &state_id)?;
    }
    #[cfg(unix)]
    remove_locator(&install_path)?;
    Ok(())
}

#[cfg(not(windows))]
fn remove_installation_state(root: &Path, state_id: &str) -> Result<()> {
    ensure!(
        state_id.len() == 64 && state_id.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid installation state identity"
    );
    let installations = root.join("installations");
    let installations_metadata = match std::fs::symlink_metadata(&installations) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", installations.display()))
        }
    };
    ensure!(
        installations_metadata.file_type().is_dir()
            && !installations_metadata.file_type().is_symlink(),
        "installation state root is not a plain directory: {}",
        installations.display()
    );
    let state = installations.join(state_id);
    let state_metadata = match std::fs::symlink_metadata(&state) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("inspect {}", state.display())),
    };
    ensure!(
        state_metadata.file_type().is_dir() && !state_metadata.file_type().is_symlink(),
        "installation state is not a plain directory: {}",
        state.display()
    );
    std::fs::remove_dir_all(&state)
        .with_context(|| format!("remove installation state {}", state.display()))
}

/// Hold a shared OS lock for the duration of the shell's wait for Electron.
/// Persisted PID metadata lets cleanup remain conservative if the shell crashes.
pub fn acquire_usage(cfg: &ShellConfig, rt: &Runtime) -> Result<RuntimeLease> {
    let root = runtime_root_for_config(cfg)?;
    let key = key_for_runtime(rt, &root)?;
    acquire_usage_at(&root, &key)
}

pub struct RuntimeLease {
    _lock: FileLock,
    record_path: PathBuf,
    record: LeaseRecord,
}

/// Build an external branded app-bundle host for macOS. The installed bundle
/// remains immutable; only the shared Electron frameworks and active resources
/// are linked into per-installation state.
#[cfg(target_os = "macos")]
pub fn prepare_macos_host(cfg: &ShellConfig, rt: &Runtime, release: &Release) -> Result<PathBuf> {
    use std::os::unix::fs::symlink;

    let installed_bundle = cfg.installation_dir()?;
    let installed_contents = installed_bundle.join("Contents");
    let info_plist = installed_contents.join("Info.plist");
    ensure!(
        info_plist.is_file(),
        "installed macOS app is missing Contents/Info.plist"
    );
    let installed_plist = std::fs::read_to_string(&info_plist)?;
    let executable_name = plist_string_value(&installed_plist, "CFBundleExecutable")
        .or_else(|| {
            std::env::current_exe()
                .ok()?
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .context("cannot determine the app bundle's CFBundleExecutable")?;
    let product_name = plist_string_value(&installed_plist, "CFBundleName")
        .context("cannot determine the app bundle's CFBundleName")?;
    let helper_bundle_name = sanitize_macos_bundle_name(&product_name)?;
    let display_name = product_name;
    let bundle_identifier = plist_string_value(&installed_plist, "CFBundleIdentifier")
        .context("cannot determine the app bundle's CFBundleIdentifier")?;
    let bundle_version = plist_string_value(&installed_plist, "CFBundleVersion")
        .unwrap_or_else(|| release.app_version.clone());
    let icon_file = cfg.resources_dir()?.join("icon.icns");
    let icon_hash = if icon_file.is_file() {
        sha256_file(&icon_file)?
    } else {
        String::new()
    };
    ensure!(
        !executable_name.is_empty()
            && !executable_name.contains('/')
            && !executable_name.contains('\\'),
        "invalid CFBundleExecutable in app Info.plist"
    );
    let runtime_contents = rt.root.join("Electron.app/Contents");
    let runtime_executable = runtime_contents.join("MacOS/Electron");
    ensure!(
        runtime_executable.is_file(),
        "shared Electron executable is missing"
    );
    let runtime_plist = std::fs::read_to_string(runtime_contents.join("Info.plist"))
        .context("read shared Electron Info.plist")?;
    let runtime_bundle_name =
        plist_string_value(&runtime_plist, "CFBundleName").unwrap_or_else(|| "Electron".to_owned());
    let runtime_executable_hash = sha256_file(&runtime_executable)?;
    let bundle_name = installed_bundle
        .file_name()
        .context("installed app bundle has no name")?;
    let identity = format!(
        "{}:{}:{}:{}:{}:{}:{}",
        canonical_install_path(&installed_bundle)?,
        release.app_version,
        release.runtime_key.version,
        release.resources_dir.canonicalize()?.display(),
        sha256_file(&info_plist)?,
        icon_hash,
        runtime_executable_hash
    );
    let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let host_bundle = cfg
        .updates_dir()?
        .join("mac-hosts")
        .join(hash)
        .join(bundle_name);
    let host_executable = host_bundle.join("Contents/MacOS").join(&executable_name);
    let host_info_plist = host_bundle.join("Contents/Info.plist");
    let host_resources = host_bundle.join("Contents/Resources");
    let active_asar = release.resources_dir.join("app.asar");
    let runtime_frameworks = runtime_contents.join("Frameworks");
    let host_frameworks = host_bundle.join("Contents/Frameworks");
    let helper_layout_matches = macos_host_helper_layout_matches(
        &runtime_contents,
        &host_bundle.join("Contents"),
        &runtime_bundle_name,
        &helper_bundle_name,
        &display_name,
        &bundle_identifier,
        &bundle_version,
    )
    .unwrap_or(false);
    let reusable = std::fs::symlink_metadata(&host_executable)
        .is_ok_and(|metadata| metadata.file_type().is_file())
        && host_info_plist.is_file()
        && std::fs::read(&host_info_plist).ok() == std::fs::read(&info_plist).ok()
        && host_resources.join("app.asar").canonicalize().ok() == active_asar.canonicalize().ok()
        && std::fs::symlink_metadata(&host_frameworks)
            .is_ok_and(|metadata| metadata.file_type().is_dir())
        && std::fs::read_link(host_frameworks.join("Electron Framework.framework"))
            .ok()
            .as_deref()
            == Some(
                runtime_frameworks
                    .join("Electron Framework.framework")
                    .as_path(),
            )
        && helper_layout_matches;
    if reusable && verify_macos_host_signature(&host_bundle).is_ok() {
        return Ok(host_executable);
    }
    if host_bundle.exists() {
        std::fs::remove_dir_all(&host_bundle).context("replace stale macOS runtime host")?;
    }
    let host_contents = host_bundle.join("Contents");
    let host_macos = host_contents.join("MacOS");
    let host_resources = host_contents.join("Resources");
    std::fs::create_dir_all(&host_macos)?;
    std::fs::create_dir_all(&host_resources)?;

    std::fs::copy(&info_plist, host_contents.join("Info.plist"))?;
    for directory in ["PlugIns", "XPCServices", "SharedFrameworks"] {
        let source = runtime_contents.join(directory);
        if source.exists() {
            symlink(source, host_contents.join(directory))?;
        }
    }
    create_macos_host_helper_layout(
        &runtime_contents,
        &host_contents,
        &runtime_bundle_name,
        &helper_bundle_name,
        &display_name,
        &bundle_identifier,
        &bundle_version,
    )?;
    let copied_executable = host_macos.join(&executable_name);
    std::fs::copy(&runtime_executable, &copied_executable)
        .context("copy Electron executable into branded runtime host")?;
    ensure!(
        sha256_file(&copied_executable)?.eq_ignore_ascii_case(&runtime_executable_hash),
        "copied Electron executable hash does not match shared runtime"
    );

    let runtime_resources = runtime_contents.join("Resources");
    link_directory_entries(&runtime_resources, &host_resources, &[])?;
    link_directory_entries(
        &cfg.resources_dir()?,
        &host_resources,
        &["app.asar", "app.asar.unpacked"],
    )?;
    link_directory_entries(&release.resources_dir, &host_resources, &[])?;
    let pkg_info = installed_contents.join("PkgInfo");
    if pkg_info.is_file() {
        std::fs::copy(pkg_info, host_contents.join("PkgInfo"))?;
    }
    sign_macos_host(&host_bundle)?;
    Ok(host_macos.join(executable_name))
}

#[cfg(target_os = "macos")]
fn sign_macos_host(bundle: &Path) -> Result<()> {
    use std::process::Command;

    let output = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(bundle)
        .output()
        .context("start ad-hoc code signing for branded runtime host")?;
    ensure!(
        output.status.success(),
        "ad-hoc signing branded runtime host failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    verify_macos_host_signature(bundle)
}

#[cfg(target_os = "macos")]
fn verify_macos_host_signature(bundle: &Path) -> Result<()> {
    use std::process::Command;

    // This per-user host deliberately links the shared runtime and app resources
    // from outside its bundle. `codesign --strict` rejects those valid external
    // symlink destinations as a non-self-contained bundle. Keep normal signature
    // verification here; the distributed installed app remains builder-signed
    // and is verified under its normal strict signing policy.
    let output = Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg(bundle)
        .output()
        .context("start branded runtime host signature verification")?;
    ensure!(
        output.status.success(),
        "branded runtime host signature verification failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_macos_host_helper_layout(
    runtime_contents: &Path,
    host_contents: &Path,
    runtime_bundle_name: &str,
    helper_bundle_name: &str,
    display_name: &str,
    bundle_identifier: &str,
    bundle_version: &str,
) -> Result<()> {
    use std::os::unix::fs::symlink;

    let runtime_frameworks = runtime_contents.join("Frameworks");
    let host_frameworks = host_contents.join("Frameworks");
    std::fs::create_dir_all(&host_frameworks)?;
    let mut found_default_helper = false;
    for entry in std::fs::read_dir(&runtime_frameworks)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            bail!("Electron Frameworks contains a non-UTF-8 entry name");
        };
        let source = entry.path();
        if let Some(suffix) = macos_helper_suffix(name_text, runtime_bundle_name) {
            if !entry.metadata()?.is_dir() {
                bail!(
                    "Electron helper bundle is not a directory: {}",
                    source.display()
                );
            }
            found_default_helper |= suffix == " Helper";
            let branded_name = format!("{helper_bundle_name}{suffix}.app");
            create_macos_branded_helper(
                &source,
                &host_frameworks.join(branded_name),
                helper_bundle_name,
                display_name,
                bundle_identifier,
                bundle_version,
                &suffix,
                false,
            )?;
        } else {
            symlink(source, host_frameworks.join(name))?;
        }
    }
    ensure!(
        found_default_helper,
        "shared Electron runtime is missing its generic Helper.app bundle"
    );

    let runtime_login_items = runtime_contents.join("Library/LoginItems");
    if runtime_login_items.exists() {
        let host_login_items = host_contents.join("Library/LoginItems");
        std::fs::create_dir_all(&host_login_items)?;
        for entry in std::fs::read_dir(&runtime_login_items)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name_text) = name.to_str() else {
                bail!("Electron LoginItems contains a non-UTF-8 entry name");
            };
            let source = entry.path();
            if let Some(suffix) = macos_login_helper_suffix(name_text, runtime_bundle_name) {
                if !entry.metadata()?.is_dir() {
                    bail!(
                        "Electron Login Helper is not a directory: {}",
                        source.display()
                    );
                }
                let branded_name = format!("{helper_bundle_name}{suffix}.app");
                create_macos_branded_helper(
                    &source,
                    &host_login_items.join(branded_name),
                    helper_bundle_name,
                    display_name,
                    bundle_identifier,
                    bundle_version,
                    &suffix,
                    true,
                )?;
            } else {
                symlink(source, host_login_items.join(name))?;
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_helper_suffix(bundle_name: &str, runtime_bundle_name: &str) -> Option<String> {
    let stem = bundle_name.strip_suffix(".app")?;
    let suffix = stem.strip_prefix(runtime_bundle_name)?;
    matches!(
        suffix,
        " Helper"
            | " Helper EH"
            | " Helper NP"
            | " Helper (Renderer)"
            | " Helper (Plugin)"
            | " Helper (GPU)"
    )
    .then(|| suffix.to_owned())
}

#[cfg(target_os = "macos")]
fn macos_login_helper_suffix(bundle_name: &str, runtime_bundle_name: &str) -> Option<String> {
    let stem = bundle_name.strip_suffix(".app")?;
    let suffix = stem.strip_prefix(runtime_bundle_name)?;
    (suffix == " Login Helper").then(|| suffix.to_owned())
}

#[cfg(target_os = "macos")]
fn create_macos_branded_helper(
    source_bundle: &Path,
    destination_bundle: &Path,
    helper_bundle_name: &str,
    display_name: &str,
    bundle_identifier: &str,
    bundle_version: &str,
    suffix: &str,
    login_helper: bool,
) -> Result<()> {
    use std::os::unix::fs::symlink;

    let source_contents = source_bundle.join("Contents");
    let source_info = source_contents.join("Info.plist");
    let source_plist = std::fs::read_to_string(&source_info)
        .with_context(|| format!("read Electron helper plist {}", source_info.display()))?;
    let source_executable = source_macos_helper_executable(source_bundle, &source_plist)?;
    let executable_name = format!("{helper_bundle_name}{suffix}");
    let mut branded_plist = source_plist;
    branded_plist = set_plist_string_value(&branded_plist, "CFBundleExecutable", &executable_name)?;
    branded_plist = set_plist_string_value(
        &branded_plist,
        "CFBundleDisplayName",
        &format!("{display_name}{suffix}"),
    )?;
    branded_plist = set_plist_string_value(
        &branded_plist,
        "CFBundleIdentifier",
        &macos_helper_bundle_identifier(bundle_identifier, suffix, login_helper),
    )?;
    branded_plist = set_plist_string_value(&branded_plist, "CFBundleVersion", bundle_version)?;

    let destination_contents = destination_bundle.join("Contents");
    let destination_macos = destination_contents.join("MacOS");
    std::fs::create_dir_all(&destination_macos)?;
    let mut copied_info = false;
    let mut copied_executable = false;
    for entry in std::fs::read_dir(&source_contents)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            bail!("Electron helper Contents contains a non-UTF-8 entry name");
        };
        let source = entry.path();
        if name_text == "Info.plist" {
            std::fs::write(destination_contents.join(name), &branded_plist)?;
            copied_info = true;
        } else if name_text == "MacOS" {
            for executable in std::fs::read_dir(&source)? {
                let executable = executable?;
                let executable_name_os = executable.file_name();
                let Some(executable_name_text) = executable_name_os.to_str() else {
                    bail!("Electron helper MacOS contains a non-UTF-8 entry name");
                };
                let target = destination_macos.join(&executable_name_os);
                if executable_name_text == source_executable {
                    std::fs::copy(executable.path(), destination_macos.join(&executable_name))
                        .context("copy Electron helper executable into branded helper bundle")?;
                    copied_executable = true;
                } else {
                    symlink(executable.path(), target)?;
                }
            }
        } else if name_text != "_CodeSignature" {
            symlink(source, destination_contents.join(name))?;
        }
    }
    ensure!(
        copied_info,
        "Electron helper bundle is missing Contents/Info.plist"
    );
    ensure!(
        copied_executable,
        "Electron helper executable listed in Info.plist was not found"
    );
    sign_macos_host(destination_bundle)
}

#[cfg(target_os = "macos")]
fn macos_helper_bundle_identifier(
    bundle_identifier: &str,
    suffix: &str,
    login_helper: bool,
) -> String {
    if login_helper {
        return filter_macos_bundle_identifier(&format!("{bundle_identifier}.loginhelper"));
    }
    let helper_identifier = format!("{bundle_identifier}.helper");
    let component = suffix.strip_prefix(" Helper").unwrap_or_default().trim();
    if component.is_empty() {
        filter_macos_bundle_identifier(&helper_identifier)
    } else {
        filter_macos_bundle_identifier(&format!("{helper_identifier}.{component}"))
    }
}

#[cfg(target_os = "macos")]
fn source_macos_helper_executable(source_bundle: &Path, source_plist: &str) -> Result<String> {
    let source_executable = plist_string_value(source_plist, "CFBundleExecutable")
        .or_else(|| {
            source_bundle
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .context("Electron helper has no CFBundleExecutable or bundle basename")?;
    ensure!(
        !source_executable.is_empty()
            && !source_executable.contains('/')
            && !source_executable.contains('\\'),
        "invalid CFBundleExecutable in Electron helper Info.plist"
    );
    let executable_path = source_bundle
        .join("Contents/MacOS")
        .join(&source_executable);
    ensure!(
        executable_path.is_file(),
        "Electron helper executable is missing: {}",
        executable_path.display()
    );
    Ok(source_executable)
}

#[cfg(target_os = "macos")]
fn filter_macos_bundle_identifier(value: &str) -> String {
    value
        .chars()
        .map(|character| if character == ' ' { '-' } else { character })
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_host_helper_layout_matches(
    runtime_contents: &Path,
    host_contents: &Path,
    runtime_bundle_name: &str,
    helper_bundle_name: &str,
    display_name: &str,
    bundle_identifier: &str,
    bundle_version: &str,
) -> Result<bool> {
    use std::collections::BTreeSet;

    let runtime_frameworks = runtime_contents.join("Frameworks");
    let host_frameworks = host_contents.join("Frameworks");
    if !runtime_frameworks.is_dir() || !host_frameworks.is_dir() {
        return Ok(false);
    }
    let mut expected_framework_entries = BTreeSet::new();
    for entry in std::fs::read_dir(&runtime_frameworks)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            return Ok(false);
        };
        let source = entry.path();
        let destination_name =
            if let Some(suffix) = macos_helper_suffix(name_text, runtime_bundle_name) {
                let branded_name = format!("{helper_bundle_name}{suffix}.app");
                if !macos_branded_helper_matches(
                    &source,
                    &host_frameworks.join(&branded_name),
                    helper_bundle_name,
                    display_name,
                    bundle_identifier,
                    bundle_version,
                    &suffix,
                    false,
                )? {
                    return Ok(false);
                }
                std::ffi::OsString::from(branded_name)
            } else {
                let destination = host_frameworks.join(&name);
                if std::fs::read_link(&destination).ok().as_deref() != Some(source.as_path()) {
                    return Ok(false);
                }
                name
            };
        expected_framework_entries.insert(destination_name);
    }
    if directory_entry_names(&host_frameworks)? != expected_framework_entries {
        return Ok(false);
    }

    let runtime_login_items = runtime_contents.join("Library/LoginItems");
    let host_login_items = host_contents.join("Library/LoginItems");
    if !runtime_login_items.exists() {
        return Ok(!host_contents.join("Library").exists());
    }
    if !host_login_items.is_dir() {
        return Ok(false);
    }
    let mut expected_login_entries = BTreeSet::new();
    for entry in std::fs::read_dir(&runtime_login_items)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            return Ok(false);
        };
        let source = entry.path();
        let destination_name =
            if let Some(suffix) = macos_login_helper_suffix(name_text, runtime_bundle_name) {
                let branded_name = format!("{helper_bundle_name}{suffix}.app");
                if !macos_branded_helper_matches(
                    &source,
                    &host_login_items.join(&branded_name),
                    helper_bundle_name,
                    display_name,
                    bundle_identifier,
                    bundle_version,
                    &suffix,
                    true,
                )? {
                    return Ok(false);
                }
                std::ffi::OsString::from(branded_name)
            } else {
                let destination = host_login_items.join(&name);
                if std::fs::read_link(&destination).ok().as_deref() != Some(source.as_path()) {
                    return Ok(false);
                }
                name
            };
        expected_login_entries.insert(destination_name);
    }
    Ok(directory_entry_names(&host_login_items)? == expected_login_entries)
}

#[cfg(target_os = "macos")]
fn macos_branded_helper_matches(
    source_bundle: &Path,
    destination_bundle: &Path,
    helper_bundle_name: &str,
    display_name: &str,
    bundle_identifier: &str,
    bundle_version: &str,
    suffix: &str,
    login_helper: bool,
) -> Result<bool> {
    let source_contents = source_bundle.join("Contents");
    let source_info = source_contents.join("Info.plist");
    let source_plist = std::fs::read_to_string(&source_info)?;
    let source_executable = match source_macos_helper_executable(source_bundle, &source_plist) {
        Ok(executable) => executable,
        Err(_) => return Ok(false),
    };
    let executable_name = format!("{helper_bundle_name}{suffix}");
    let expected_plist =
        set_plist_string_value(&source_plist, "CFBundleExecutable", &executable_name)?;
    let expected_plist = set_plist_string_value(
        &expected_plist,
        "CFBundleDisplayName",
        &format!("{display_name}{suffix}"),
    )?;
    let expected_plist = set_plist_string_value(
        &expected_plist,
        "CFBundleIdentifier",
        &macos_helper_bundle_identifier(bundle_identifier, suffix, login_helper),
    )?;
    let expected_plist =
        set_plist_string_value(&expected_plist, "CFBundleVersion", bundle_version)?;
    let destination_contents = destination_bundle.join("Contents");
    if std::fs::read(destination_contents.join("Info.plist"))
        .ok()
        .as_deref()
        != Some(expected_plist.as_bytes())
    {
        return Ok(false);
    }
    let source_executable_path = source_contents.join("MacOS").join(&source_executable);
    let destination_executable_path = destination_contents.join("MacOS").join(&executable_name);
    if !std::fs::symlink_metadata(&destination_executable_path)
        .is_ok_and(|metadata| metadata.file_type().is_file())
        || sha256_file(&source_executable_path)? != sha256_file(&destination_executable_path)?
    {
        return Ok(false);
    }
    Ok(verify_macos_host_signature(destination_bundle).is_ok())
}

#[cfg(target_os = "macos")]
fn directory_entry_names(path: &Path) -> Result<std::collections::BTreeSet<std::ffi::OsString>> {
    Ok(std::fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<_>>()?)
}

#[cfg(target_os = "macos")]
fn sanitize_macos_bundle_name(value: &str) -> Result<String> {
    let sanitized = value
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(*character as u32, 0x80..=0x9f)
                && !matches!(
                    *character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        .collect::<String>();
    let mut sanitized = sanitized.trim_end_matches([' ', '.']).to_owned();
    let reserved_name = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if sanitized.chars().all(|character| character == '.')
        || matches!(
            reserved_name.as_str(),
            "con"
                | "prn"
                | "aux"
                | "nul"
                | "com1"
                | "com2"
                | "com3"
                | "com4"
                | "com5"
                | "com6"
                | "com7"
                | "com8"
                | "com9"
                | "lpt1"
                | "lpt2"
                | "lpt3"
                | "lpt4"
                | "lpt5"
                | "lpt6"
                | "lpt7"
                | "lpt8"
                | "lpt9"
        )
    {
        sanitized.clear();
    }
    if sanitized.len() > 255 {
        let mut end = 255;
        while !sanitized.is_char_boundary(end) {
            end -= 1;
        }
        sanitized.truncate(end);
    }
    ensure!(
        !sanitized.is_empty() && sanitized != "." && sanitized != "..",
        "invalid CFBundleName for helper bundle paths"
    );
    Ok(sanitized)
}

#[cfg(target_os = "macos")]
fn plist_string_value(plist: &str, key: &str) -> Option<String> {
    let marker = format!("<key>{key}</key>");
    let rest = plist.split_once(&marker)?.1;
    let value = rest.split_once("<string>")?.1.split_once("</string>")?.0;
    let value = value
        .trim()
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
fn set_plist_string_value(plist: &str, key: &str, value: &str) -> Result<String> {
    let marker = format!("<key>{key}</key>");
    ensure!(
        plist.matches(&marker).count() <= 1,
        "Electron helper Info.plist contains duplicate {key} keys"
    );
    let escaped = value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");

    if let Some(key_position) = plist.find(&marker) {
        let key_start = key_position + marker.len();
        let value_start = plist[key_start..]
            .find("<string>")
            .map(|offset| key_start + offset + "<string>".len())
            .context("expected a string value in Electron helper Info.plist")?;
        let value_end = plist[value_start..]
            .find("</string>")
            .map(|offset| value_start + offset)
            .context("unterminated string in Electron helper Info.plist")?;
        let mut result = String::with_capacity(plist.len() + escaped.len());
        result.push_str(&plist[..value_start]);
        result.push_str(&escaped);
        result.push_str(&plist[value_end..]);
        return Ok(result);
    }

    let dictionary_end = plist
        .rfind("</dict>")
        .context("Electron helper Info.plist has no top-level dictionary")?;
    ensure!(
        plist[..dictionary_end].contains("<dict>"),
        "Electron helper Info.plist has no top-level dictionary"
    );
    let mut result = String::with_capacity(plist.len() + escaped.len());
    result.push_str(&plist[..dictionary_end]);
    result.push_str("\n<key>");
    result.push_str(key);
    result.push_str("</key>\n<string>");
    result.push_str(&escaped);
    result.push_str("</string>\n");
    result.push_str(&plist[dictionary_end..]);
    Ok(result)
}

#[cfg(target_os = "macos")]
fn link_directory_entries(source: &Path, destination: &Path, excluded: &[&str]) -> Result<()> {
    use std::os::unix::fs::symlink;
    ensure!(
        source.is_dir(),
        "missing app resources directory: {}",
        source.display()
    );
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        if excluded.iter().any(|excluded| name == *excluded) {
            continue;
        }
        let target = destination.join(name);
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
                std::fs::remove_dir_all(&target)?;
            } else {
                std::fs::remove_file(&target)?;
            }
        }
        symlink(entry.path(), target)?;
    }
    Ok(())
}

impl RuntimeLease {
    /// Record the spawned Electron child before waiting for it. If the shell
    /// exits unexpectedly, cleanup can still see that the child is alive.
    pub fn record_child(&mut self, pid: u32) -> Result<()> {
        ensure!(pid != 0, "invalid Electron process id");
        self.record.child_pid = Some(pid);
        // A PID-only lease still protects the runtime when Windows cannot
        // inspect creation time immediately; cleanup treats missing identity
        // metadata conservatively.
        self.record.child_start_time = process::start_time(pid).ok();
        atomic_write(&self.record_path, &serde_json::to_vec(&self.record)?)
    }
}

impl Drop for RuntimeLease {
    fn drop(&mut self) {
        if let Some(pid) = self.record.child_pid {
            if process::is_alive(pid) {
                let identity_matches = match self.record.child_start_time {
                    Some(expected) => process::start_time(pid)
                        .map(|actual| expected == 0 || actual == 0 || actual == expected)
                        .unwrap_or(true),
                    None => true,
                };
                if identity_matches {
                    // The shell may be exiting after an error while Electron
                    // remains alive. Keep the durable child record so a later
                    // uninstall defers GC until that process exits.
                    return;
                }
            }
        }
        let _ = std::fs::remove_file(&self.record_path);
    }
}

fn locate_at(root: &Path, key: &RuntimeKey) -> Result<Runtime> {
    validate_host_key(key)?;
    let dir = version_dir(root, key);
    let marker_path = dir.join(INSTALL_MARKER);
    let marker_text = std::fs::read_to_string(&marker_path).with_context(|| {
        format!(
            "runtime completion marker missing: {}",
            marker_path.display()
        )
    })?;
    let marker: InstallMarker =
        serde_json::from_str(&marker_text).context("parse runtime completion marker")?;
    ensure!(
        marker.schema_version == INSTALL_MARKER_SCHEMA_VERSION,
        "unsupported runtime marker schema"
    );
    ensure!(
        marker.platform == key.platform,
        "runtime marker platform mismatch"
    );
    ensure!(
        marker.version == key.version,
        "runtime marker version mismatch"
    );
    ensure!(
        is_sha256(&marker.artifact_sha256),
        "invalid runtime marker hash"
    );
    ensure!(
        is_sha256(&marker.electron_bin_sha256),
        "invalid runtime executable marker hash"
    );
    ensure!(
        is_sha256(&marker.default_app_asar_sha256),
        "invalid default app archive marker hash"
    );

    let (electron_bin, default_app_asar, bin_meta, asar_meta) =
        validate_runtime_structure(&dir, key)?;
    ensure!(
        bin_meta.len() == marker.electron_bin_size,
        "runtime executable size mismatch"
    );
    ensure!(
        asar_meta.len() == marker.default_app_asar_size,
        "runtime default_app.asar size mismatch"
    );
    ensure!(
        bin_meta.len() > 0 && asar_meta.len() > 0,
        "runtime files are empty"
    );
    ensure!(
        sha256_file(&electron_bin)? == marker.electron_bin_sha256,
        "runtime executable hash mismatch"
    );
    ensure!(
        sha256_file(&default_app_asar)? == marker.default_app_asar_sha256,
        "runtime default_app.asar hash mismatch"
    );

    Ok(Runtime {
        version: key.version.clone(),
        electron_bin,
        root: dir,
    })
}

fn validate_host_key(key: &RuntimeKey) -> Result<()> {
    key.validate()?;
    ensure!(
        key.platform == platform_triple(),
        "runtime platform {} does not match this shell ({})",
        key.platform,
        platform_triple()
    );
    Ok(())
}

fn validate_artifact(artifact: &Artifact) -> Result<()> {
    ensure!(artifact.size > 0, "runtime artifact size must be positive");
    normalize_sha256(&artifact.sha256)?;
    ensure!(
        !artifact.url.trim().is_empty(),
        "runtime artifact URL is empty"
    );
    Ok(())
}

fn normalize_sha256(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    ensure!(
        is_sha256(&normalized),
        "invalid SHA256 value in runtime artifact"
    );
    Ok(normalized)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn version_dir(root: &Path, key: &RuntimeKey) -> PathBuf {
    root.join("versions")
        .join(&key.platform)
        .join(format!("v{}", key.version))
}

fn key_id(key: &RuntimeKey) -> String {
    format!("{}-v{}", key.platform, key.version)
}

fn electron_bin_path(root: &Path, platform: &str) -> Result<PathBuf> {
    if platform.starts_with("win32-") {
        Ok(root.join("electron.exe"))
    } else if platform.starts_with("darwin-") {
        Ok(root.join("Electron.app/Contents/MacOS/Electron"))
    } else if platform.starts_with("linux-") {
        Ok(root.join("electron"))
    } else {
        bail!("unsupported runtime platform: {platform}")
    }
}

fn runtime_resource_dir(root: &Path, platform: &str) -> PathBuf {
    if platform.starts_with("darwin-") {
        root.join(
            "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources",
        )
    } else {
        root.to_path_buf()
    }
}

fn default_app_asar_path(root: &Path, platform: &str) -> PathBuf {
    if platform.starts_with("darwin-") {
        root.join("Electron.app/Contents/Resources/default_app.asar")
    } else {
        root.join("resources/default_app.asar")
    }
}

fn required_runtime_files(root: &Path, platform: &str) -> Result<Vec<PathBuf>> {
    let mut files = vec![
        electron_bin_path(root, platform)?,
        default_app_asar_path(root, platform),
    ];
    let resources = runtime_resource_dir(root, platform);
    files.push(resources.join("icudtl.dat"));
    files.push(resources.join("resources.pak"));
    if platform.starts_with("win32-") {
        // These DLLs are present in supported Electron Windows archives and
        // are needed to initialize its renderer/media stack.
        for name in [
            "d3dcompiler_47.dll",
            "ffmpeg.dll",
            "libEGL.dll",
            "libGLESv2.dll",
        ] {
            files.push(root.join(name));
        }
    }
    Ok(files)
}

fn validate_runtime_structure(
    root: &Path,
    key: &RuntimeKey,
) -> Result<(PathBuf, PathBuf, std::fs::Metadata, std::fs::Metadata)> {
    let required = required_runtime_files(root, &key.platform)?;
    let mut metadata = Vec::with_capacity(required.len());
    for path in &required {
        let file_metadata = regular_file_metadata(path)
            .with_context(|| format!("required runtime file missing: {}", path.display()))?;
        ensure!(
            file_metadata.len() > 0,
            "required runtime file is empty: {}",
            path.display()
        );
        metadata.push(file_metadata);
    }
    Ok((
        required[0].clone(),
        required[1].clone(),
        metadata[0].clone(),
        metadata[1].clone(),
    ))
}

fn regular_file_metadata(path: &Path) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.file_type().is_file(),
        "expected regular file: {}",
        path.display()
    );
    Ok(metadata)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        use std::io::Read;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn refs_path(root: &Path) -> PathBuf {
    root.join(REFS_FILE)
}

fn registry_lock(root: &Path) -> PathBuf {
    root.join("locks").join("refs.lock")
}

fn usage_lock_path(root: &Path, key: &RuntimeKey) -> PathBuf {
    root.join("locks")
        .join(format!("usage-{}.lock", key_id(key)))
}

fn lease_dir(root: &Path, key: &RuntimeKey) -> PathBuf {
    root.join("leases").join(key_id(key))
}

fn read_refs(root: &Path) -> Result<RefCounts> {
    let path = refs_path(root);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).context("parse runtime reference registry"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RefCounts::default()),
        Err(error) => Err(error).context("read runtime reference registry"),
    }
}

fn write_refs(root: &Path, refs: &RefCounts) -> Result<()> {
    atomic_write(&refs_path(root), &serde_json::to_vec_pretty(refs)?)
}

fn register_at(root: &Path, install_path: &str, releases: &[Release]) -> Result<()> {
    std::fs::create_dir_all(root.join("locks"))?;
    let _guard = FileLock::exclusive(&registry_lock(root))?;
    let mut refs = read_refs(root)?;
    let mut desired = BTreeSet::new();
    for release in releases {
        release.runtime_key.validate()?;
        desired.insert(key_id(&release.runtime_key));
    }

    // The caller supplies the complete retained release set, so replace this
    // installation's references atomically instead of leaking obsolete versions.
    for (id, installations) in &mut refs.map {
        if !desired.contains(id) {
            installations.remove(install_path);
        }
    }
    for id in desired {
        refs.map
            .entry(id)
            .or_default()
            .insert(install_path.to_owned());
    }
    write_refs(root, &refs)?;
    retry_unreferenced_cleanup(root, &mut refs)?;
    Ok(())
}

fn unregister_at(root: &Path, install_path: &str) -> Result<()> {
    std::fs::create_dir_all(root.join("locks"))?;
    let _guard = FileLock::exclusive(&registry_lock(root))?;
    let mut refs = read_refs(root)?;
    for installations in refs.map.values_mut() {
        installations.remove(install_path);
    }
    write_refs(root, &refs)?;
    retry_unreferenced_cleanup(root, &mut refs)
}

/// Empty reference sets are durable cleanup work items. Keep them in refs.json
/// while a live shell/child lease defers removal, and retry them on each later
/// registration or unregistration.
fn retry_unreferenced_cleanup(root: &Path, refs: &mut RefCounts) -> Result<()> {
    let unreferenced = refs
        .map
        .iter()
        .filter_map(|(id, installations)| installations.is_empty().then_some(id.clone()))
        .collect::<Vec<_>>();
    let mut cleaned = Vec::new();
    for id in unreferenced {
        if let Some(key) = parse_key_id(&id)? {
            if cleanup_unreferenced_runtime(root, &key)? {
                cleaned.push(id);
            }
        }
    }
    for id in cleaned {
        refs.map.remove(&id);
    }
    write_refs(root, refs)
}

fn parse_key_id(id: &str) -> Result<Option<RuntimeKey>> {
    let Some((platform, version)) = id.split_once("-v") else {
        bail!("invalid runtime key in reference registry: {id}");
    };
    if platform.is_empty() || version.is_empty() {
        bail!("invalid runtime key in reference registry: {id}");
    }
    let key = RuntimeKey {
        platform: platform.to_owned(),
        version: version.to_owned(),
    };
    key.validate()
        .with_context(|| format!("invalid runtime key in reference registry: {id}"))?;
    Ok(Some(key))
}

fn acquire_usage_at(root: &Path, key: &RuntimeKey) -> Result<RuntimeLease> {
    validate_host_key(key)?;
    std::fs::create_dir_all(root.join("locks"))?;
    let _lock = FileLock::shared(&usage_lock_path(root, key))?;
    // ensure() and registration may interleave with an uninstall. Revalidate
    // the committed runtime under the shared usage lock before handing it to
    // the launcher so cleanup cannot win between lookup and lease acquisition.
    locate_at(root, key).context("runtime is unavailable before launch")?;
    let dir = lease_dir(root, key);
    std::fs::create_dir_all(&dir)?;
    let owner_pid = std::process::id();
    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let record_path = dir.join(format!("{owner_pid}-{token}.json"));
    let record = LeaseRecord {
        owner_pid,
        owner_start_time: process::start_time(owner_pid)?,
        child_pid: None,
        child_start_time: None,
    };
    atomic_write(&record_path, &serde_json::to_vec(&record)?)?;
    Ok(RuntimeLease {
        _lock,
        record_path,
        record,
    })
}

fn cleanup_unreferenced_runtime(root: &Path, key: &RuntimeKey) -> Result<bool> {
    let _guard = match FileLock::try_exclusive(&usage_lock_path(root, key))? {
        Some(guard) => guard,
        None => return Ok(false),
    };
    if !ensure_no_live_lease_records(root, key)? {
        return Ok(false);
    }
    let dir = version_dir(root, key);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).context("remove unreferenced shared runtime")?;
    }
    Ok(true)
}

/// Returns false when a live process record requires preserving the runtime.
fn ensure_no_live_lease_records(root: &Path, key: &RuntimeKey) -> Result<bool> {
    let dir = lease_dir(root, key);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error).context("read runtime leases"),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let record: LeaseRecord = serde_json::from_slice(
            &std::fs::read(&path).with_context(|| format!("read lease {}", path.display()))?,
        )
        .with_context(|| format!("parse lease {}", path.display()))?;
        if process_identity_alive(record.owner_pid, record.owner_start_time)?
            || match (record.child_pid, record.child_start_time) {
                (Some(pid), Some(start_time)) => process_identity_alive(pid, start_time)?,
                (Some(pid), None) => process::is_alive(pid),
                (None, _) => false,
            }
        {
            return Ok(false);
        }
        std::fs::remove_file(path).context("remove stale runtime lease")?;
    }
    Ok(true)
}

fn process_identity_alive(pid: u32, expected_start_time: u64) -> Result<bool> {
    if !process::is_alive(pid) {
        return Ok(false);
    }
    let actual_start_time = process::start_time(pid)
        .with_context(|| format!("inspect process identity for pid {pid}"))?;
    // Non-Windows implementations currently return zero; keep conservative
    // PID-only detection there until a platform start-time source is available.
    Ok(expected_start_time == 0 || actual_start_time == expected_start_time)
}

fn key_for_runtime(rt: &Runtime, root: &Path) -> Result<RuntimeKey> {
    let platform = platform_triple().to_owned();
    let key = RuntimeKey {
        platform,
        version: rt.version.clone(),
    };
    key.validate()?;
    ensure!(
        version_dir(root, &key) == rt.root,
        "runtime root does not match the configured runtime cache"
    );
    Ok(key)
}

fn canonical_install_path(path: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("canonicalize installation directory {}", path.display()))?;
    let mut value = canonical.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    Ok(value)
}

fn unique_staging_path(root: &Path, key: &RuntimeKey) -> PathBuf {
    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    root.join("staging")
        .join(format!("{}-{}-{token}", key_id(key), std::process::id()))
}

fn unique_backup_path(dest: &Path) -> PathBuf {
    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    dest.with_file_name(format!(
        "{}.old-{token}",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ))
}

struct RemoveDirOnDrop(PathBuf);

impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let token = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "electron-runtime-{tag}-{}-{token}",
            std::process::id()
        ))
    }

    fn test_key() -> RuntimeKey {
        RuntimeKey::current("32.2.0")
    }

    #[cfg(unix)]
    #[test]
    fn installation_locator_requires_an_exact_path_and_absolute_root() {
        let root = std::env::temp_dir().join("runtime-root");
        let locator = InstallationLocator {
            schema: INSTALLATIONS_SCHEMA,
            installations: vec![InstallationLocatorEntry {
                path: "/opt/apps/karvis".to_owned(),
                runtime_root: root.to_string_lossy().into_owned(),
            }],
        };
        assert_eq!(
            locator_root_for_path(&locator, "/opt/apps/karvis").unwrap(),
            Some(root)
        );
        assert!(locator_root_for_path(&locator, "/opt/apps/karvis-copy")
            .unwrap()
            .is_none());

        let mut invalid = locator;
        invalid.installations[0].runtime_root = "relative/cache".to_owned();
        assert!(locator_root_for_path(&invalid, "/opt/apps/karvis").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn removing_installation_state_keeps_sibling_installations() {
        let root = temp_root("uninstall-state");
        let state_a = "a".repeat(64);
        let state_b = "b".repeat(64);
        let install_a = root.join("installations").join(&state_a);
        let install_b = root.join("installations").join(&state_b);
        std::fs::create_dir_all(install_a.join("updates/releases")).unwrap();
        std::fs::create_dir_all(install_b.join("updates")).unwrap();
        std::fs::write(install_a.join("updates/releases/payload"), b"a").unwrap();
        std::fs::write(install_b.join("updates/active.json"), b"b").unwrap();

        remove_installation_state(&root, &state_a).unwrap();

        assert!(!install_a.exists());
        assert_eq!(
            std::fs::read(install_b.join("updates/active.json")).unwrap(),
            b"b"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn write_valid_runtime(root: &Path, key: &RuntimeKey) {
        let dir = version_dir(root, key);
        let required = required_runtime_files(&dir, &key.platform).unwrap();
        for (index, path) in required.iter().enumerate() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("runtime fixture {index}")).unwrap();
        }
        let electron_bin = electron_bin_path(&dir, &key.platform).unwrap();
        let default_app_asar = default_app_asar_path(&dir, &key.platform);
        let marker = InstallMarker {
            schema_version: INSTALL_MARKER_SCHEMA_VERSION,
            platform: key.platform.clone(),
            version: key.version.clone(),
            artifact_sha256: "a".repeat(64),
            electron_bin_size: std::fs::metadata(&electron_bin).unwrap().len(),
            default_app_asar_size: std::fs::metadata(&default_app_asar).unwrap().len(),
            electron_bin_sha256: sha256_file(&electron_bin).unwrap(),
            default_app_asar_sha256: sha256_file(&default_app_asar).unwrap(),
        };
        std::fs::write(
            dir.join(INSTALL_MARKER),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
    }

    fn test_release(key: RuntimeKey, installation: &Path) -> Release {
        Release {
            app_version: "1.0.0".to_owned(),
            runtime_key: key,
            resources_dir: installation.join("resources"),
            artifact_sha256: "a".repeat(64),
        }
    }

    #[test]
    fn locate_requires_complete_matching_marker_and_files() {
        let root = temp_root("locate");
        let key = test_key();
        write_valid_runtime(&root, &key);
        assert!(locate_at(&root, &key).is_ok());

        std::fs::remove_file(default_app_asar_path(
            &version_dir(&root, &key),
            &key.platform,
        ))
        .unwrap();
        assert!(locate_at(&root, &key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_app_archive_paths_match_official_electron_bundle_layouts() {
        let root = Path::new("runtime-root");
        assert_eq!(
            default_app_asar_path(root, "win32-x64"),
            root.join("resources/default_app.asar")
        );
        assert_eq!(
            default_app_asar_path(root, "linux-x64"),
            root.join("resources/default_app.asar")
        );
        assert_eq!(
            default_app_asar_path(root, "darwin-arm64"),
            root.join("Electron.app/Contents/Resources/default_app.asar")
        );
        assert_eq!(
            runtime_resource_dir(root, "darwin-arm64"),
            root.join(
                "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
            )
        );
    }

    #[test]
    fn locate_rejects_runtime_missing_required_support_files() {
        let root = temp_root("structure");
        let key = test_key();
        write_valid_runtime(&root, &key);
        let support_file = required_runtime_files(&version_dir(&root, &key), &key.platform)
            .unwrap()
            .into_iter()
            .nth(2)
            .unwrap();
        std::fs::remove_file(support_file).unwrap();
        assert!(locate_at(&root, &key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locate_rejects_runtime_missing_windows_dll() {
        let root = temp_root("windows-dll");
        let key = test_key();
        if !key.platform.starts_with("win32-") {
            return;
        }
        write_valid_runtime(&root, &key);
        let dll = version_dir(&root, &key).join("d3dcompiler_47.dll");
        std::fs::remove_file(&dll).unwrap();
        assert!(locate_at(&root, &key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registration_is_idempotent_and_installation_scoped() {
        let root = temp_root("refs");
        let path_a = root.join("apps/a");
        let path_b = root.join("apps/b");
        std::fs::create_dir_all(&path_a).unwrap();
        std::fs::create_dir_all(&path_b).unwrap();
        let install_a = canonical_install_path(&path_a).unwrap();
        let install_b = canonical_install_path(&path_b).unwrap();
        let release_a = test_release(test_key(), &path_a);
        let release_b = test_release(test_key(), &path_b);

        register_at(&root, &install_a, &[release_a.clone()]).unwrap();
        register_at(&root, &install_a, &[release_a]).unwrap();
        register_at(&root, &install_b, &[release_b]).unwrap();
        let refs = read_refs(&root).unwrap();
        let apps = refs.map.get(&key_id(&test_key())).unwrap();
        assert_eq!(apps.len(), 2);

        unregister_at(&root, &install_a).unwrap();
        let refs = read_refs(&root).unwrap();
        assert_eq!(refs.map.get(&key_id(&test_key())).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registration_replaces_only_this_installations_retained_keys() {
        let root = temp_root("replace-refs");
        let path_a = root.join("apps/a");
        let path_b = root.join("apps/b");
        std::fs::create_dir_all(&path_a).unwrap();
        std::fs::create_dir_all(&path_b).unwrap();
        let install_a = canonical_install_path(&path_a).unwrap();
        let install_b = canonical_install_path(&path_b).unwrap();
        let old_key = RuntimeKey::current("32.2.0");
        let new_key = RuntimeKey::current("34.1.0");
        register_at(&root, &install_a, &[test_release(old_key.clone(), &path_a)]).unwrap();
        register_at(&root, &install_b, &[test_release(old_key.clone(), &path_b)]).unwrap();
        register_at(&root, &install_a, &[test_release(new_key.clone(), &path_a)]).unwrap();

        let refs = read_refs(&root).unwrap();
        assert_eq!(refs.map.get(&key_id(&old_key)).unwrap().len(), 1);
        assert!(refs
            .map
            .get(&key_id(&old_key))
            .unwrap()
            .contains(&install_b));
        assert!(refs
            .map
            .get(&key_id(&new_key))
            .unwrap()
            .contains(&install_a));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deferred_cleanup_keeps_key_until_child_lease_is_gone() {
        let root = temp_root("deferred-cleanup");
        let key = test_key();
        write_valid_runtime(&root, &key);
        let install = root.join("apps/a").to_string_lossy().into_owned();
        register_at(
            &root,
            &install,
            &[test_release(key.clone(), Path::new(&install))],
        )
        .unwrap();

        let leases = lease_dir(&root, &key);
        std::fs::create_dir_all(&leases).unwrap();
        let lease_path = leases.join("orphaned-shell.json");
        let live_child = LeaseRecord {
            owner_pid: u32::MAX,
            owner_start_time: 0,
            child_pid: Some(std::process::id()),
            child_start_time: Some(0),
        };
        std::fs::write(&lease_path, serde_json::to_vec(&live_child).unwrap()).unwrap();

        unregister_at(&root, &install).unwrap();
        let refs = read_refs(&root).unwrap();
        assert_eq!(refs.map.get(&key_id(&key)).unwrap().len(), 0);
        assert!(version_dir(&root, &key).exists());
        assert!(lease_path.exists());

        let exited_child = LeaseRecord {
            owner_pid: u32::MAX,
            owner_start_time: 0,
            child_pid: Some(u32::MAX),
            child_start_time: Some(0),
        };
        std::fs::write(&lease_path, serde_json::to_vec(&exited_child).unwrap()).unwrap();
        unregister_at(&root, &install).unwrap();
        let refs = read_refs(&root).unwrap();
        assert!(!refs.map.contains_key(&key_id(&key)));
        assert!(!version_dir(&root, &key).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_lease_defers_cleanup_without_deleting_lease_or_runtime() {
        let root = temp_root("corrupt-lease");
        let key = test_key();
        write_valid_runtime(&root, &key);
        let install = root.join("apps/a").to_string_lossy().into_owned();
        register_at(
            &root,
            &install,
            &[test_release(key.clone(), Path::new(&install))],
        )
        .unwrap();
        let leases = lease_dir(&root, &key);
        std::fs::create_dir_all(&leases).unwrap();
        let lease_path = leases.join("corrupt.json");
        std::fs::write(&lease_path, b"not json").unwrap();

        assert!(unregister_at(&root, &install).is_err());
        assert!(lease_path.exists());
        assert!(version_dir(&root, &key).exists());
        assert_eq!(
            read_refs(&root)
                .unwrap()
                .map
                .get(&key_id(&key))
                .unwrap()
                .len(),
            0
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupted_reference_registry_fails_closed() {
        let root = temp_root("corrupt-refs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(refs_path(&root), b"not json").unwrap();
        assert!(read_refs(&root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn live_child_lease_prevents_cleanup() {
        let root = temp_root("lease");
        let key = test_key();
        write_valid_runtime(&root, &key);
        let rt = locate_at(&root, &key).unwrap();
        let mut lease = acquire_usage_at(&root, &key).unwrap();
        lease.record_child(std::process::id()).unwrap();
        assert!(!ensure_no_live_lease_records(&root, &key).unwrap());
        let record_path = lease.record_path.clone();
        drop(lease);
        assert!(record_path.exists());
        let saved: LeaseRecord =
            serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
        assert_eq!(saved.child_pid, Some(std::process::id()));
        std::fs::remove_file(record_path).unwrap();
        assert!(ensure_no_live_lease_records(&root, &key).unwrap());
        assert!(rt.root.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_lease_revalidates_runtime_before_launch() {
        let root = temp_root("lease-revalidate");
        let key = test_key();
        std::fs::create_dir_all(root.join("locks")).unwrap();
        assert!(acquire_usage_at(&root, &key).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn key_id_round_trips() {
        let key = test_key();
        assert_eq!(parse_key_id(&key_id(&key)).unwrap(), Some(key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_helper_names_and_info_plists_follow_builder_branding() {
        let app_id = "com.example.karvis";
        assert_eq!(
            macos_helper_suffix("Electron Helper (Renderer).app", "Electron"),
            Some(" Helper (Renderer)".to_owned())
        );
        assert_eq!(
            macos_login_helper_suffix("Electron Login Helper.app", "Electron"),
            Some(" Login Helper".to_owned())
        );
        assert_eq!(
            macos_helper_bundle_identifier(app_id, " Helper (GPU)", false),
            "com.example.karvis.helper.GPU"
        );
        assert_eq!(
            macos_helper_bundle_identifier(app_id, " Login Helper", true),
            "com.example.karvis.loginhelper"
        );

        let source = "<plist><dict><key>CFBundleExecutable</key><string>Electron Helper</string><key>CFBundleDisplayName</key><string>Electron Helper</string><key>CFBundleIdentifier</key><string>com.electron.helper</string><key>CFBundleVersion</key><string>1</string></dict></plist>";
        let changed =
            set_plist_string_value(source, "CFBundleDisplayName", "Karvis & Co Helper").unwrap();
        assert!(changed.contains("<string>Karvis &amp; Co Helper</string>"));
        assert_eq!(
            plist_string_value(&changed, "CFBundleDisplayName").as_deref(),
            Some("Karvis & Co Helper")
        );
        assert_eq!(
            sanitize_macos_bundle_name("Karvis: AI. ").unwrap(),
            "Karvis AI"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_official_helper_plists_can_omit_builder_fields() {
        let root = temp_root("macos-helper-template");
        let helper_bundle = root.join("Electron Helper.app");
        let helper_executable = helper_bundle.join("Contents/MacOS/Electron Helper");
        std::fs::create_dir_all(helper_executable.parent().unwrap()).unwrap();
        std::fs::write(&helper_executable, b"helper executable fixture").unwrap();

        // Electron 28's official helper plists only include this identifier;
        // electron-builder fills the other fields later during packaging.
        let source_plist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.github.Electron.helper</string><key>UnknownRuntimeField</key><string>preserve-me</string></dict></plist>";
        assert_eq!(
            source_macos_helper_executable(&helper_bundle, source_plist).unwrap(),
            "Electron Helper"
        );
        assert_eq!(plist_string_value(source_plist, "CFBundleExecutable"), None);

        let branded =
            set_plist_string_value(source_plist, "CFBundleExecutable", "Karvis AI Helper").unwrap();
        let branded =
            set_plist_string_value(&branded, "CFBundleDisplayName", "Karvis AI Helper").unwrap();
        let branded =
            set_plist_string_value(&branded, "CFBundleIdentifier", "com.karvis.helper").unwrap();
        let branded = set_plist_string_value(&branded, "CFBundleVersion", "2.0.0").unwrap();
        assert_eq!(
            plist_string_value(&branded, "CFBundleExecutable").as_deref(),
            Some("Karvis AI Helper")
        );
        assert_eq!(
            plist_string_value(&branded, "CFBundleDisplayName").as_deref(),
            Some("Karvis AI Helper")
        );
        assert_eq!(
            plist_string_value(&branded, "CFBundleIdentifier").as_deref(),
            Some("com.karvis.helper")
        );
        assert_eq!(
            plist_string_value(&branded, "CFBundleVersion").as_deref(),
            Some("2.0.0")
        );
        assert!(branded.contains("<key>UnknownRuntimeField</key><string>preserve-me</string>"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn critical_file_hash_is_stable() {
        let root = temp_root("hash");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("fixture.bin");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_file(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
