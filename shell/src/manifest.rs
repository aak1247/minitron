//! Release manifest loading, validation, canonical signature verification and lookup.

use crate::config::ShellConfig;
use crate::release::RuntimeKey;
use anyhow::{bail, ensure, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::io::Read;
use url::{Host, Url};

const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub app_id: String,
    pub channel: String,
    /// Runtime selected by this manifest's `app` release.
    pub runtime: RuntimeEntry,
    pub app: AppEntry,
    /// Ed25519 signature over the canonical JSON object without this field.
    pub signature: Option<String>,
    /// Additional runtime versions retained for currently installed releases.
    #[serde(default)]
    pub runtimes: Vec<RuntimeEntry>,
    /// Optional platform-specific shell update package.
    #[serde(default)]
    pub shell: Option<ShellEntry>,
}

#[derive(Debug, Deserialize)]
pub struct RuntimeEntry {
    pub version: String,
    pub platforms: HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize)]
pub struct ShellEntry {
    pub version: String,
    pub platforms: HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize)]
pub struct AppEntry {
    pub version: String,
    pub asar: Artifact,
    /// Minimum shell version required by this app release.
    pub min_stub_version: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

impl Manifest {
    /// Runtime key associated with this manifest's candidate application release.
    pub fn runtime_key(&self) -> RuntimeKey {
        RuntimeKey::current(&self.runtime.version)
    }

    /// Find an artifact for an exact runtime key, first in the candidate entry,
    /// then in the retained runtime catalog for installed/rollback releases.
    pub fn runtime_artifact_for(&self, key: &RuntimeKey) -> Result<&Artifact> {
        key.validate()?;
        let mut matches = Vec::new();
        if self.runtime.version == key.version {
            if let Some(artifact) = self.runtime.platforms.get(&key.platform) {
                matches.push(artifact);
            }
        }
        for entry in &self.runtimes {
            if entry.version == key.version {
                if let Some(artifact) = entry.platforms.get(&key.platform) {
                    matches.push(artifact);
                }
            }
        }
        let first = matches.first().copied().with_context(|| {
            format!(
                "manifest has no runtime artifact for {} v{}",
                key.platform, key.version
            )
        })?;
        ensure!(
            matches.iter().all(|artifact| *artifact == first),
            "manifest has conflicting artifacts for runtime {} v{}",
            key.platform,
            key.version
        );
        Ok(first)
    }

    /// Compatibility helper for callers which only need the candidate release runtime.
    pub fn runtime_artifact(&self) -> Result<&Artifact> {
        self.runtime_artifact_for(&self.runtime_key())
    }
}

/// Fetch, authenticate and validate the manifest. Cleartext HTTP is only
/// accepted when explicitly enabled and the URL host is loopback.
pub fn fetch(cfg: &ShellConfig) -> Result<Manifest> {
    ensure!(
        !cfg.manifest_url.trim().is_empty(),
        "manifest_url is not configured"
    );
    let url = validate_url(&cfg.manifest_url, cfg.allow_localhost_http)?;
    // Localhost development manifests must reach the loopback listener
    // directly, even if another dependency later enables proxy-from-env.
    // HTTP is loopback-only and does not follow redirects; HTTPS cannot
    // downgrade to HTTP.
    let builder = ureq::AgentBuilder::new()
        .https_only(url.scheme() == "https")
        .redirects(if url.scheme() == "http" { 0 } else { 5 });
    let agent = if url.scheme() == "http" {
        // Do not send a loopback-only development URL through an environment
        // proxy. Keep the normal proxy behavior for HTTPS release servers.
        builder.try_proxy_from_env(false).build()
    } else {
        builder.build()
    };
    let response = agent
        .get(url.as_str())
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .context("fetch update manifest")?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut body)
        .context("read update manifest")?;
    ensure!(
        body.len() as u64 <= MAX_MANIFEST_BYTES,
        "manifest exceeds 4 MiB limit"
    );
    parse_manifest(cfg, &body)
}

/// Return the build-time-pinned runtime artifact only for the exact runtime
/// configured by this installation. It is validated by the same URL, size,
/// and SHA rules used for artifacts inside an authenticated manifest.
pub fn configured_runtime_artifact<'a>(
    cfg: &'a ShellConfig,
    key: &RuntimeKey,
) -> Result<Option<&'a Artifact>> {
    let configured_key = RuntimeKey::current(&cfg.required_runtime);
    configured_key
        .validate()
        .context("invalid configured required_runtime")?;
    if key != &configured_key {
        return Ok(None);
    }
    let Some(artifact) = cfg.runtime_download.as_ref() else {
        return Ok(None);
    };
    validate_artifact(artifact, cfg.allow_localhost_http)
        .context("validate configured runtime_download")?;
    Ok(Some(artifact))
}

fn parse_manifest(cfg: &ShellConfig, body: &[u8]) -> Result<Manifest> {
    let mut strict: StrictValue =
        serde_json::from_slice(body).context("parse strict manifest JSON")?;
    verify_signature(&mut strict, cfg.manifest_public_key.as_deref())?;

    let manifest: Manifest = serde_json::from_slice(body).context("parse manifest")?;
    validate_manifest(cfg, &manifest)?;
    Ok(manifest)
}

fn validate_manifest(cfg: &ShellConfig, manifest: &Manifest) -> Result<()> {
    ensure!(manifest.app_id == cfg.app_id, "manifest app_id mismatch");
    ensure!(
        !manifest.channel.trim().is_empty(),
        "manifest channel is empty"
    );
    validate_version(&manifest.app.version, "app.version")?;
    validate_version(&manifest.runtime.version, "runtime.version")?;
    validate_artifact(&manifest.app.asar, cfg.allow_localhost_http)?;
    validate_runtime_entry(&manifest.runtime, cfg.allow_localhost_http)?;

    let mut versions = std::collections::BTreeSet::new();
    versions.insert(manifest.runtime.version.as_str());
    for runtime in &manifest.runtimes {
        validate_version(&runtime.version, "runtimes[].version")?;
        ensure!(
            versions.insert(runtime.version.as_str()),
            "duplicate runtime version {}",
            runtime.version
        );
        validate_runtime_entry(runtime, cfg.allow_localhost_http)?;
    }

    // The candidate app's runtime must be available for this build. The key is
    // deliberately not compared with cfg.required_runtime: that value describes
    // the installed release and may differ during an update.
    let candidate_key = manifest.runtime_key();
    manifest
        .runtime_artifact_for(&candidate_key)
        .context("candidate release has no matching runtime artifact")?;

    if let Some(minimum) = &manifest.app.min_stub_version {
        validate_version(minimum, "app.min_stub_version")?;
    }
    if let Some(shell) = &manifest.shell {
        validate_version(&shell.version, "shell.version")?;
        ensure!(
            !shell.platforms.is_empty(),
            "shell update has no platform artifacts"
        );
        for (platform, artifact) in &shell.platforms {
            validate_platform(platform)?;
            validate_artifact(artifact, cfg.allow_localhost_http)?;
        }
    }
    Ok(())
}

fn validate_runtime_entry(entry: &RuntimeEntry, allow_http: bool) -> Result<()> {
    ensure!(
        !entry.platforms.is_empty(),
        "runtime {} has no platform artifacts",
        entry.version
    );
    for (platform, artifact) in &entry.platforms {
        validate_platform(platform)?;
        validate_artifact(artifact, allow_http)?;
    }
    Ok(())
}

fn validate_platform(platform: &str) -> Result<()> {
    ensure!(
        matches!(
            platform,
            "win32-x64"
                | "win32-arm64"
                | "win32-ia32"
                | "darwin-x64"
                | "darwin-arm64"
                | "linux-x64"
                | "linux-arm64"
                | "linux-armv7l"
        ),
        "unsupported manifest platform: {platform}"
    );
    Ok(())
}

pub(crate) fn validate_artifact(artifact: &Artifact, allow_http: bool) -> Result<()> {
    ensure!(artifact.size > 0, "artifact size must be positive");
    ensure!(
        artifact.sha256.len() == 64 && artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "artifact SHA256 must contain exactly 64 hexadecimal characters"
    );
    validate_url(&artifact.url, allow_http)?;
    Ok(())
}

fn validate_version(version: &str, field: &str) -> Result<()> {
    let parsed = semver::Version::parse(version).with_context(|| format!("invalid {field}"))?;
    ensure!(
        parsed.to_string() == version && parsed.pre.is_empty() && parsed.build.is_empty(),
        "{field} must be an exact stable x.y.z version"
    );
    Ok(())
}

fn validate_url(value: &str, allow_http: bool) -> Result<Url> {
    let url = Url::parse(value).context("parse manifest/artifact URL")?;
    ensure!(
        matches!(url.scheme(), "https" | "http"),
        "URL must use HTTPS"
    );
    ensure!(url.host_str().is_some(), "URL must have a host");
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "URL must not contain credentials"
    );
    ensure!(url.fragment().is_none(), "URL must not contain a fragment");
    if url.scheme() == "http" {
        ensure!(
            allow_http,
            "HTTP is disabled; configure HTTPS or explicitly enable loopback development HTTP"
        );
        ensure!(
            is_loopback_host(&url),
            "HTTP is only permitted for loopback hosts"
        );
    }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(name)) => {
            name.eq_ignore_ascii_case("localhost") || name.eq_ignore_ascii_case("localhost.")
        }
        None => false,
    }
}

fn verify_signature(value: &mut StrictValue, public_key: Option<&str>) -> Result<()> {
    let StrictValue::Object(object) = value else {
        bail!("manifest must be a JSON object");
    };
    let signature = match object.remove("signature") {
        None | Some(StrictValue::Null) => None,
        Some(StrictValue::String(value)) => Some(value),
        Some(_) => bail!("manifest signature must be a base64 string or null"),
    };
    let canonical = canonical_json(&StrictValue::Object(object.clone()))?;
    match (public_key, signature) {
        (None, None) => Ok(()),
        (None, Some(_)) => bail!("manifest is signed but no trusted public key is configured"),
        (Some(_), None) => bail!("manifest signature is required by configuration"),
        (Some(public_key), Some(signature)) => {
            let public_key = BASE64
                .decode(public_key)
                .context("decode manifest public key base64")?;
            let public_key: [u8; 32] = public_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("Ed25519 public key must decode to 32 bytes"))?;
            let verifying_key =
                VerifyingKey::from_bytes(&public_key).context("parse manifest public key")?;
            let signature = BASE64
                .decode(signature)
                .context("decode manifest signature base64")?;
            let signature =
                Signature::from_slice(&signature).context("parse Ed25519 manifest signature")?;
            verifying_key
                .verify(&canonical, &signature)
                .context("manifest signature verification failed")
        }
    }
}

fn canonical_json(value: &StrictValue) -> Result<Vec<u8>> {
    fn write(value: &StrictValue, output: &mut String) -> Result<()> {
        match value {
            StrictValue::Null => output.push_str("null"),
            StrictValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            StrictValue::Number(value) => output.push_str(&value.to_string()),
            StrictValue::String(value) => output.push_str(&serde_json::to_string(value)?),
            StrictValue::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write(value, output)?;
                }
                output.push(']');
            }
            StrictValue::Object(values) => {
                output.push('{');
                for (index, (key, value)) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    write(value, output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }

    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output.into_bytes())
}

/// Strict JSON tree used for canonical signing. It rejects duplicate object
/// keys and floating point numbers before serde's manifest structs are read.
#[derive(Debug, Clone)]
enum StrictValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<StrictValue>),
    Object(BTreeMap<String, StrictValue>),
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value containing only unique keys and integer numbers")
    }

    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue::Null)
    }

    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(StrictValue::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Ok(StrictValue::Number(value.into()))
    }

    fn visit_f64<E>(self, _value: f64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        Err(E::custom(
            "floating point numbers are not allowed in signed manifests",
        ))
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(StrictValue::String(value))
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element()? {
            values.push(value);
        }
        Ok(StrictValue::Array(values))
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, StrictValue>()? {
            ensure_unique_key(&mut values, key, value).map_err(serde::de::Error::custom)?;
        }
        Ok(StrictValue::Object(values))
    }
}

fn ensure_unique_key(
    map: &mut BTreeMap<String, StrictValue>,
    key: String,
    value: StrictValue,
) -> std::result::Result<(), String> {
    if map.contains_key(&key) {
        return Err(format!("duplicate JSON key: {key}"));
    }
    map.insert(key, value);
    Ok(())
}

/// Semver comparison for app and shell release checks.
pub fn version_lt(a: &str, b: &str) -> bool {
    match (semver::Version::parse(a), semver::Version::parse(b)) {
        (Ok(a), Ok(b)) => a < b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::platform_triple;
    use ed25519_dalek::{Signer, SigningKey};
    use std::net::TcpListener;
    use std::thread;

    fn test_config() -> ShellConfig {
        ShellConfig {
            app_id: "example.app".into(),
            required_runtime: "32.2.0".into(),
            manifest_url: "https://example.invalid/manifest.json".into(),
            runtime_download: None,
            app_version: "1.0.0".into(),
            allow_localhost_http: false,
            manifest_public_key: None,
            app_directory: None,
        }
    }

    #[test]
    fn configured_runtime_artifact_is_only_available_for_exact_runtime_key() {
        let mut cfg = test_config();
        cfg.runtime_download = Some(Artifact {
            url: "https://cdn.example.invalid/electron.zip".into(),
            sha256: "a".repeat(64),
            size: 1234,
        });
        let configured = RuntimeKey::current(&cfg.required_runtime);
        assert_eq!(
            configured_runtime_artifact(&cfg, &configured)
                .unwrap()
                .unwrap()
                .size,
            1234
        );
        assert!(
            configured_runtime_artifact(&cfg, &RuntimeKey::current("34.1.0"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn configured_runtime_artifact_uses_existing_manifest_artifact_validation() {
        let mut cfg = test_config();
        cfg.runtime_download = Some(Artifact {
            url: "http://example.invalid/electron.zip".into(),
            sha256: "a".repeat(64),
            size: 1234,
        });
        let key = RuntimeKey::current(&cfg.required_runtime);
        assert!(configured_runtime_artifact(&cfg, &key).is_err());

        cfg.allow_localhost_http = true;
        cfg.runtime_download.as_mut().unwrap().url = "http://127.0.0.1/electron.zip".into();
        assert!(configured_runtime_artifact(&cfg, &key).unwrap().is_some());
        cfg.runtime_download.as_mut().unwrap().size = 0;
        assert!(configured_runtime_artifact(&cfg, &key).is_err());
    }

    #[test]
    fn empty_manifest_url_fails_without_attempting_a_request() {
        let mut cfg = test_config();
        cfg.manifest_url.clear();
        let error = fetch(&cfg).unwrap_err().to_string();
        assert!(error.contains("manifest_url is not configured"));
    }

    fn artifact_json() -> String {
        format!(
            "{{\"url\":\"https://cdn.example.invalid/runtime.zip\",\"sha256\":\"{}\",\"size\":10}}",
            "a".repeat(64)
        )
    }

    fn manifest_json(runtime_version: &str, runtime_platform: &str) -> String {
        let artifact = artifact_json();
        format!(
            "{{\"app_id\":\"example.app\",\"channel\":\"stable\",\"runtime\":{{\"version\":\"{runtime_version}\",\"platforms\":{{\"{runtime_platform}\":{artifact}}}}},\"app\":{{\"version\":\"2.0.0\",\"asar\":{artifact}}}}}"
        )
    }

    fn sign_manifest(unsigned_json: &str, signing_key: &SigningKey) -> String {
        let mut value: serde_json::Value = serde_json::from_str(unsigned_json).unwrap();
        let canonical = canonical_json(&strict_value_from_value(value.clone())).unwrap();
        let signature = BASE64.encode(signing_key.sign(&canonical).to_bytes());
        value["signature"] = serde_json::Value::String(signature);
        serde_json::to_string(&value).unwrap()
    }

    fn strict_value_from_value(value: serde_json::Value) -> StrictValue {
        match value {
            serde_json::Value::Null => StrictValue::Null,
            serde_json::Value::Bool(value) => StrictValue::Bool(value),
            serde_json::Value::Number(value) => StrictValue::Number(value),
            serde_json::Value::String(value) => StrictValue::String(value),
            serde_json::Value::Array(values) => {
                StrictValue::Array(values.into_iter().map(strict_value_from_value).collect())
            }
            serde_json::Value::Object(values) => StrictValue::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, strict_value_from_value(value)))
                    .collect(),
            ),
        }
    }

    #[test]
    fn candidate_runtime_may_differ_from_installed_runtime() {
        let cfg = test_config();
        let body = manifest_json("34.1.0", platform_triple());
        let manifest = parse_manifest(&cfg, body.as_bytes()).unwrap();
        assert_eq!(manifest.runtime_key().version, "34.1.0");
        assert_eq!(manifest.runtime_artifact().unwrap().size, 10);
        assert_eq!(cfg.required_runtime, "32.2.0");
    }

    #[test]
    fn retained_runtime_lookup_is_exact_by_version_and_platform() {
        let cfg = test_config();
        let platform = platform_triple();
        let mut body: serde_json::Value =
            serde_json::from_str(&manifest_json("34.1.0", platform)).unwrap();
        body["runtimes"] = serde_json::json!([{
            "version": "32.2.0",
            "platforms": { platform: serde_json::from_str::<serde_json::Value>(&artifact_json()).unwrap() }
        }]);
        let manifest =
            parse_manifest(&cfg, serde_json::to_string(&body).unwrap().as_bytes()).unwrap();
        let key = RuntimeKey::current("32.2.0");
        assert_eq!(manifest.runtime_artifact_for(&key).unwrap().size, 10);
        assert!(manifest
            .runtime_artifact_for(&RuntimeKey::current("30.0.0"))
            .is_err());
    }

    #[test]
    fn signature_is_verified_and_tampering_is_rejected() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        let mut cfg = test_config();
        cfg.manifest_public_key = Some(public_key);
        let signed = sign_manifest(&manifest_json("34.1.0", platform_triple()), &signing_key);
        assert!(parse_manifest(&cfg, signed.as_bytes()).is_ok());
        let tampered = signed.replace("2.0.0", "2.0.1");
        assert!(parse_manifest(&cfg, tampered.as_bytes()).is_err());
    }

    #[test]
    fn rejects_duplicate_keys_and_float_numbers() {
        let cfg = test_config();
        assert!(parse_manifest(&cfg, br#"{"app_id":"x","app_id":"example.app"}"#).is_err());
        assert!(serde_json::from_slice::<StrictValue>(br#"{"size":1.5}"#).is_err());
    }

    #[test]
    fn localhost_http_must_be_explicit_and_loopback() {
        let mut cfg = test_config();
        assert!(validate_url(
            "http://127.0.0.1:9000/manifest.json",
            cfg.allow_localhost_http
        )
        .is_err());
        cfg.allow_localhost_http = true;
        assert!(validate_url(
            "http://localhost:9000/manifest.json",
            cfg.allow_localhost_http
        )
        .is_ok());
        assert!(
            validate_url("http://example.com/manifest.json", cfg.allow_localhost_http).is_err()
        );
    }

    #[test]
    fn fetch_reads_a_local_manifest_when_explicitly_enabled() {
        let body = manifest_json("34.1.0", platform_triple());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Drain the GET headers before closing the socket. Closing with
            // unread request bytes can reset the connection on Windows.
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            use std::io::Write;
            stream.write_all(response.as_bytes()).unwrap();
        });
        let mut cfg = test_config();
        cfg.manifest_url = format!("http://{address}/manifest.json");
        cfg.allow_localhost_http = true;
        fetch(&cfg).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn semantic_versions_compare_correctly() {
        assert!(version_lt("1.9.0", "1.10.0"));
        assert!(!version_lt("broken", "2.0.0"));
    }
}
