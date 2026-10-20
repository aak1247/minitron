use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct RuntimeKey {
    pub platform: String,
    pub version: String,
}

impl RuntimeKey {
    pub fn current(version: &str) -> Self {
        Self {
            platform: crate::config::platform_triple().into(),
            version: version.into(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        let version =
            semver::Version::parse(&self.version).context("invalid exact Electron version")?;
        if version.to_string() != self.version
            || !version.pre.is_empty()
            || !version.build.is_empty()
        {
            bail!("Electron version must be an exact stable x.y.z version");
        }
        if !matches!(
            self.platform.as_str(),
            "win32-x64"
                | "win32-arm64"
                | "win32-ia32"
                | "linux-x64"
                | "linux-arm64"
                | "linux-armv7l"
                | "darwin-x64"
                | "darwin-arm64"
        ) {
            bail!("unsupported runtime platform: {}", self.platform);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Release {
    pub app_version: String,
    pub runtime_key: RuntimeKey,
    pub resources_dir: PathBuf,
    pub artifact_sha256: String,
}

impl Release {
    pub fn validate(&self) -> Result<()> {
        self.runtime_key.validate()?;
        semver::Version::parse(&self.app_version).context("invalid application version")?;
        if !self.resources_dir.is_absolute() {
            bail!("release resources path must be absolute");
        }
        let asar = self.resources_dir.join("app.asar");
        if !asar.is_file() || asar.metadata()?.len() == 0 {
            bail!("application archive missing or empty: {}", asar.display());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_fuzzy_and_path_versions() {
        for bad in [
            ">=32.2.0",
            "32.2",
            "../32.2.0",
            "32.2.0-beta.1",
            "32.2.0+local",
        ] {
            assert!(RuntimeKey::current(bad).validate().is_err());
        }
        assert!(RuntimeKey::current("32.2.0").validate().is_ok());
    }
}
