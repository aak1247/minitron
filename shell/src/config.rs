//! minitron.toml parsing and per-user runtime paths.

use anyhow::{Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct ShellConfig {
    /// Application identifier, normally a reverse-DNS name.
    pub app_id: String,
    /// Exact Electron version for the initially installed release.
    pub required_runtime: String,
    /// Update manifest URL.
    pub manifest_url: String,
    /// Version of the initially installed application resources.
    pub app_version: String,
    /// Permit cleartext HTTP only for loopback development servers.
    #[serde(default)]
    pub allow_localhost_http: bool,
    /// Optional base64-encoded Ed25519 public key used to verify manifests.
    #[serde(default)]
    pub manifest_public_key: Option<String>,
    /// Directory used to locate this installation's config and updates.
    /// `None` is retained only for callers constructing the config directly.
    #[serde(skip)]
    pub(crate) app_directory: Option<PathBuf>,
}

impl ShellConfig {
    pub fn load() -> Result<Self> {
        let exe_dir = std::env::current_exe()?
            .parent()
            .context("no exe dir")?
            .to_path_buf();
        Self::load_from(&Self::config_path(&exe_dir))
    }

    /// Load an installation's configuration when invoked from an external
    /// helper, such as the NSIS uninstaller copied into `$PLUGINSDIR`.
    pub fn load_for_app_dir(directory: &Path) -> Result<Self> {
        anyhow::ensure!(directory.is_absolute(), "--app-dir must be absolute");
        let directory = Self::config_directory(directory);
        Self::load_from(&Self::config_path(&directory))
    }

    fn config_directory(directory: &Path) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            if directory
                .extension()
                .is_some_and(|extension| extension == "app")
            {
                return directory.join("Contents/MacOS");
            }
        }
        directory.to_path_buf()
    }

    // Prefer the branded name while retaining existing installations.
    fn config_path(directory: &Path) -> PathBuf {
        let preferred = directory.join("minitron.toml");
        if preferred.exists() {
            preferred
        } else {
            let legacy = directory.join("shell.toml");
            if legacy.exists() {
                legacy
            } else {
                preferred
            }
        }
    }

    /// Load configuration from an explicit path. The production loader uses
    /// the shell executable's directory; this entry point also keeps parsing
    /// independently testable.
    pub fn load_from(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read shell config {}", path.display()))?;
        let mut config: Self = toml::from_str(&text).context("parse minitron configuration")?;
        anyhow::ensure!(!config.app_id.trim().is_empty(), "app_id must not be empty");
        anyhow::ensure!(
            !config.required_runtime.trim().is_empty(),
            "required_runtime must not be empty"
        );
        anyhow::ensure!(
            !config.app_version.trim().is_empty(),
            "app_version must not be empty"
        );
        config.app_directory = Some(
            path.parent()
                .context("configuration path has no parent")?
                .to_path_buf(),
        );
        Ok(config)
    }

    /// Application directory containing the shell executable and resources.
    pub fn app_dir(&self) -> Result<PathBuf> {
        if let Some(directory) = &self.app_directory {
            return Ok(directory.clone());
        }
        Ok(std::env::current_exe()?
            .parent()
            .context("no exe dir")?
            .to_path_buf())
    }

    pub fn resources_dir(&self) -> Result<PathBuf> {
        let app_dir = self.app_dir()?;
        #[cfg(target_os = "macos")]
        {
            return Ok(app_dir
                .parent()
                .context("macOS launcher directory has no Contents parent")?
                .join("Resources"));
        }
        #[cfg(not(target_os = "macos"))]
        Ok(app_dir.join("resources"))
    }

    /// Canonical installation identity used for locks, refs, and per-install state.
    /// On macOS this is the bundle root, regardless of whether --app-dir named
    /// the .app or Contents/MacOS.
    pub fn installation_dir(&self) -> Result<PathBuf> {
        let app_dir = self.app_dir()?;
        #[cfg(target_os = "macos")]
        {
            let contents = app_dir
                .parent()
                .context("macOS launcher directory has no Contents parent")?;
            return Ok(contents
                .parent()
                .context("macOS Contents directory has no bundle parent")?
                .to_path_buf());
        }
        #[cfg(not(target_os = "macos"))]
        Ok(app_dir)
    }

    /// Persistent mutable state is external to Unix installations so signed
    /// app bundles and root-owned system installs remain read-only.
    pub fn updates_dir(&self) -> Result<PathBuf> {
        #[cfg(windows)]
        {
            return Ok(self.app_dir()?.join("updates"));
        }
        #[cfg(not(windows))]
        {
            Ok(crate::runtime::runtime_root_for_config(self)?
                .join("installations")
                .join(installation_state_id(&self.installation_dir()?)?)
                .join("updates"))
        }
    }

    /// Previous Unix releases kept mutable state under the installation. It is
    /// retained as a read-only migration source for existing installations.
    pub fn legacy_updates_dir(&self) -> Result<PathBuf> {
        Ok(self.app_dir()?.join("updates"))
    }
}

pub fn installation_state_id(path: &Path) -> Result<String> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("canonicalize installation directory {}", path.display()))?;
    let text = canonical.to_string_lossy();
    #[cfg(windows)]
    let text = text.to_lowercase();
    let digest = Sha256::digest(text.as_bytes());
    Ok(format!("{:x}", digest))
}

/// Per-user shared runtime root. An override is useful for isolated tests and
/// explicit deployments; the default never requires machine-wide privileges.
pub fn runtime_root() -> PathBuf {
    let user_data = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    runtime_root_from_override(std::env::var_os("ELECTRON_RUNTIME_ROOT"), user_data)
}

fn runtime_root_from_override(override_path: Option<OsString>, user_data: PathBuf) -> PathBuf {
    if let Some(root) = override_path {
        if !root.is_empty() {
            return PathBuf::from(root);
        }
    }
    user_data.join("SharedElectron")
}

/// Manifest platform key for this build target.
pub fn platform_triple() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "win32-arm64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    {
        "win32-ia32"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-arm64"
    }
    #[cfg(all(target_os = "linux", target_arch = "arm"))]
    {
        "linux-armv7l"
    }
    #[cfg(not(any(
        all(
            target_os = "windows",
            any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86")
        ),
        all(
            target_os = "macos",
            any(target_arch = "aarch64", target_arch = "x86_64")
        ),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "arm")
        )
    )))]
    {
        "unsupported-platform"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_config_defaults_new_security_fields() {
        let dir = std::env::temp_dir().join(format!(
            "electron-shell-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shell.toml");
        std::fs::write(
            &path,
            "app_id='example.app'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n",
        )
        .unwrap();

        let cfg = ShellConfig::load_from(&path).unwrap();
        assert!(!cfg.allow_localhost_http);
        assert_eq!(cfg.manifest_public_key, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn branded_configuration_precedes_legacy_name() {
        let dir = tempfile::tempdir().unwrap();
        let preferred = dir.path().join("minitron.toml");
        let legacy = dir.path().join("shell.toml");
        assert_eq!(ShellConfig::config_path(dir.path()), preferred);
        std::fs::write(&legacy, "legacy").unwrap();
        assert_eq!(ShellConfig::config_path(dir.path()), legacy);
        std::fs::write(&preferred, "new").unwrap();
        assert_eq!(ShellConfig::config_path(dir.path()), preferred);
    }

    #[test]
    fn helper_configuration_keeps_the_requested_installation_directory() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("installed");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(
            install.join("minitron.toml"),
            "app_id='example.app'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n",
        )
        .unwrap();

        let config = ShellConfig::load_for_app_dir(&install).unwrap();
        assert_eq!(config.app_dir().unwrap(), install);
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_state_directory_is_hashed_and_external_to_the_installation() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("installed");
        std::fs::create_dir_all(&install).unwrap();
        let config_path = install.join("minitron.toml");
        std::fs::write(
            &config_path,
            "app_id='example.app'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n",
        )
        .unwrap();
        let config = ShellConfig::load_from(&config_path).unwrap();
        let state = config.updates_dir().unwrap();
        let id = installation_state_id(&install).unwrap();
        assert!(state.ends_with(Path::new(&format!("installations/{id}/updates"))));
        assert!(!state.starts_with(&install));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_bundle_and_macos_directory_resolve_to_the_same_installation() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("Karvis AI.app");
        let macos = bundle.join("Contents/MacOS");
        let resources = bundle.join("Contents/Resources");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::create_dir_all(&resources).unwrap();
        std::fs::write(
            macos.join("minitron.toml"),
            "app_id='example.app'\nrequired_runtime='32.2.0'\nmanifest_url='https://example.invalid/manifest.json'\napp_version='1.0.0'\n",
        )
        .unwrap();
        std::fs::write(resources.join("app.asar"), b"asar").unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), "plist").unwrap();

        let from_bundle = ShellConfig::load_for_app_dir(&bundle).unwrap();
        let from_macos = ShellConfig::load_for_app_dir(&macos).unwrap();
        assert_eq!(from_bundle.app_dir().unwrap(), macos);
        assert_eq!(from_bundle.resources_dir().unwrap(), resources);
        assert_eq!(
            from_bundle.installation_dir().unwrap(),
            from_macos.installation_dir().unwrap()
        );
        assert_eq!(
            from_bundle.updates_dir().unwrap(),
            from_macos.updates_dir().unwrap()
        );
    }

    #[test]
    fn runtime_root_honors_override() {
        let expected = std::env::temp_dir().join("runtime-root-config-test");
        assert_eq!(
            runtime_root_from_override(Some(expected.clone().into()), PathBuf::new()),
            expected
        );
        assert_eq!(
            runtime_root_from_override(None, PathBuf::from("user-data")),
            PathBuf::from("user-data/SharedElectron")
        );
    }

    #[test]
    fn platform_triple_is_nonempty() {
        assert!(!platform_triple().is_empty());
    }
}
