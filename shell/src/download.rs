//! Resumable artifact downloads and confined ZIP extraction.

use crate::fsutil::FileLock;
use crate::manifest::Artifact;
use anyhow::{bail, ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use url::Url;

pub type ProgressFn = Box<dyn Fn(u64, u64) + Send>;

/// Download an artifact to a deterministic, non-user-controlled filename.
/// A partial file is appended only after a correct 206/Content-Range response.
pub fn download(artifact: &Artifact, dir: &Path, on_progress: ProgressFn) -> Result<PathBuf> {
    validate_artifact(artifact)?;
    std::fs::create_dir_all(dir)?;
    let url = Url::parse(&artifact.url).context("parse artifact URL")?;
    let artifact_id = artifact_id(artifact);
    let dest = dir.join(format!("artifact-{artifact_id}.bin"));
    let part = dir.join(format!("artifact-{artifact_id}.part"));
    let lock_path = dir.join(format!("artifact-{artifact_id}.lock"));
    let _lock = FileLock::exclusive(&lock_path)?;

    if is_complete_file(&dest, artifact)? {
        return Ok(dest);
    }
    if dest.exists() {
        std::fs::remove_file(&dest).context("remove invalid cached artifact")?;
    }

    let mut existing = part.metadata().map(|meta| meta.len()).unwrap_or(0);
    if existing > artifact.size {
        std::fs::remove_file(&part).ok();
        existing = 0;
    }

    let response = request_artifact(&url, &part, existing)?;
    let status = response.status();
    let mut range_length = None;
    let append = if status == 206 {
        ensure!(existing > 0, "server returned unsolicited partial content");
        match validate_content_range(response.header("Content-Range"), existing, artifact.size) {
            Ok(length) => range_length = Some(length),
            Err(error) => {
                let _ = std::fs::remove_file(&part);
                return Err(error);
            }
        }
        true
    } else if status == 200 {
        // Some servers ignore Range. Start over and never append the full body
        // to an older partial file.
        existing = 0;
        false
    } else {
        bail!("unexpected HTTP status {status} for artifact download");
    };
    if let Some(length) = response.header("Content-Length") {
        let length: u64 = length.parse().context("invalid Content-Length")?;
        if append {
            ensure!(
                Some(length) == range_length,
                "partial response Content-Length does not match Content-Range"
            );
        } else {
            ensure!(
                length == artifact.size,
                "response Content-Length does not match manifest size"
            );
        }
    }

    let mut hasher = Sha256::new();
    if append {
        let mut old = std::fs::File::open(&part)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = old.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
    }

    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options.open(&part)?;
    let mut reader = response.into_reader();
    let mut buffer = [0u8; 64 * 1024];
    let mut downloaded = existing;
    loop {
        let count = reader.read(&mut buffer).context("read artifact response")?;
        if count == 0 {
            break;
        }
        downloaded = downloaded
            .checked_add(count as u64)
            .context("artifact size overflow")?;
        if downloaded > artifact.size {
            drop(file);
            let _ = std::fs::remove_file(&part);
            bail!("artifact response exceeds manifest size");
        }
        file.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
        on_progress(downloaded, artifact.size);
    }
    file.flush()?;
    file.sync_all()?;
    drop(file);

    if let Some(expected_range_length) = range_length {
        ensure!(
            downloaded - existing == expected_range_length,
            "partial response body length does not match Content-Range"
        );
    }
    ensure!(
        downloaded == artifact.size,
        "incomplete artifact: got {downloaded} of {} bytes",
        artifact.size
    );
    let actual = format!("{:x}", hasher.finalize());
    if actual != artifact.sha256.to_ascii_lowercase() {
        let _ = std::fs::remove_file(&part);
        bail!(
            "sha256 mismatch: got {actual}, expected {}",
            artifact.sha256
        );
    }

    std::fs::rename(&part, &dest).context("commit downloaded artifact")?;
    Ok(dest)
}

fn request_artifact(url: &Url, part: &Path, mut offset: u64) -> Result<ureq::Response> {
    for attempt in 0..2 {
        let builder = ureq::AgentBuilder::new()
            .https_only(url.scheme() == "https")
            .redirects(if url.scheme() == "http" { 0 } else { 5 });
        let agent = if url.scheme() == "http" {
            builder.try_proxy_from_env(false).build()
        } else {
            builder.build()
        };
        let mut request = agent
            .get(url.as_str())
            .timeout(std::time::Duration::from_secs(90));
        if offset > 0 {
            request = request.set("Range", &format!("bytes={offset}-"));
        }
        match request.call() {
            Ok(response) => return Ok(response),
            Err(ureq::Error::Status(416, _)) if offset > 0 && attempt == 0 => {
                std::fs::remove_file(part).context("discard rejected partial artifact")?;
                offset = 0;
            }
            Err(error) => return Err(error).context("http artifact download"),
        }
    }
    bail!("server rejected artifact range after restart")
}

fn validate_content_range(
    value: Option<&str>,
    expected_start: u64,
    expected_total: u64,
) -> Result<u64> {
    let value = value.context("206 response is missing Content-Range")?;
    let value = value
        .strip_prefix("bytes ")
        .context("invalid Content-Range unit")?;
    let (range, total) = value.split_once('/').context("invalid Content-Range")?;
    let (start, end) = range.split_once('-').context("invalid Content-Range")?;
    let start: u64 = start.parse().context("invalid Content-Range start")?;
    let end: u64 = end.parse().context("invalid Content-Range end")?;
    let total: u64 = total.parse().context("invalid Content-Range total")?;
    ensure!(
        start == expected_start,
        "Content-Range starts at {start}, expected {expected_start}"
    );
    ensure!(end >= start && end < total, "invalid Content-Range bounds");
    ensure!(
        total == expected_total,
        "Content-Range total does not match manifest size"
    );
    Ok(end - start + 1)
}

fn validate_artifact(artifact: &Artifact) -> Result<()> {
    ensure!(artifact.size > 0, "artifact size must be positive");
    ensure!(
        artifact.sha256.len() == 64 && artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "artifact SHA256 must contain exactly 64 hexadecimal characters"
    );
    let url = Url::parse(&artifact.url).context("parse artifact URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "artifact URL must use HTTP or HTTPS"
    );
    ensure!(url.host_str().is_some(), "artifact URL must have a host");
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "artifact URL must not contain credentials"
    );
    ensure!(
        url.fragment().is_none(),
        "artifact URL must not contain a fragment"
    );
    if url.scheme() == "http" {
        ensure!(
            matches!(
                url.host(),
                Some(url::Host::Ipv4(address)) if address.is_loopback()
            ) || matches!(
                url.host(),
                Some(url::Host::Ipv6(address)) if address.is_loopback()
            ) || matches!(
                url.host(),
                Some(url::Host::Domain(name)) if name.eq_ignore_ascii_case("localhost") || name.eq_ignore_ascii_case("localhost.")
            ),
            "HTTP artifacts are only permitted from loopback hosts"
        );
    }
    Ok(())
}

fn artifact_id(artifact: &Artifact) -> String {
    let mut hasher = Sha256::new();
    hasher.update(artifact.url.as_bytes());
    hasher.update([0]);
    hasher.update(artifact.size.to_le_bytes());
    hasher.update([0]);
    hasher.update(artifact.sha256.to_ascii_lowercase().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn is_complete_file(path: &Path, artifact: &Artifact) -> Result<bool> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("inspect cached artifact"),
    };
    if !metadata.is_file() || metadata.len() != artifact.size {
        return Ok(false);
    }
    Ok(sha256_file(path)? == artifact.sha256.to_ascii_lowercase())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Extract ZIP entries without allowing path traversal. Unix symlinks are
/// deferred until regular files are written, then recreated only when their
/// lexical target remains within the extraction root.
pub fn unzip(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    std::fs::create_dir_all(dest)?;
    let root = std::fs::canonicalize(dest)?;
    let mut links = Vec::<(PathBuf, PathBuf)>::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .context("ZIP entry has an unsafe path")?
            .to_path_buf();
        ensure!(
            relative
                .components()
                .all(|component| matches!(component, Component::Normal(_) | Component::CurDir)),
            "ZIP entry contains a non-relative path"
        );
        let output = root.join(&relative);
        ensure!(
            output.starts_with(&root),
            "ZIP entry escapes extraction root"
        );

        let is_symlink = entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if is_symlink {
            let mut target_bytes = Vec::new();
            entry.read_to_end(&mut target_bytes)?;
            let target =
                String::from_utf8(target_bytes).context("ZIP symlink target is not UTF-8")?;
            validate_symlink_target(&relative, Path::new(&target))?;
            links.push((relative, PathBuf::from(target)));
            continue;
        }

        if entry.is_dir() {
            std::fs::create_dir_all(&output)?;
            continue;
        }

        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .with_context(|| format!("create extracted file {}", output.display()))?;
        std::io::copy(&mut entry, &mut out)?;
        out.sync_all()?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&output, std::fs::Permissions::from_mode(mode & 0o777))?;
        }
    }

    for (relative, target) in links {
        let output = root.join(&relative);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        ensure!(
            !output.exists(),
            "ZIP symlink conflicts with an existing entry"
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &output)
            .with_context(|| format!("create ZIP symlink {}", output.display()))?;
        #[cfg(not(unix))]
        {
            let _ = target;
            bail!("ZIP symlinks are unsupported on this platform");
        }
    }
    Ok(())
}

fn validate_symlink_target(link: &Path, target: &Path) -> Result<()> {
    ensure!(
        !target.as_os_str().is_empty(),
        "ZIP symlink target is empty"
    );
    let mut resolved = PathBuf::new();
    for component in link.parent().unwrap_or_else(|| Path::new("")).components() {
        match component {
            Component::Normal(value) => resolved.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("ZIP symlink has an unsafe location")
            }
        }
    }
    for component in target.components() {
        match component {
            Component::Normal(value) => resolved.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                ensure!(resolved.pop(), "ZIP symlink target escapes extraction root");
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("ZIP symlink target must be relative")
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn artifact(url: String, bytes: &[u8]) -> Artifact {
        Artifact {
            url,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            size: bytes.len() as u64,
        }
    }

    fn serve_one(response: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        format!("http://{address}/artifact.bin")
    }

    fn response(status: &str, headers: &str, body: &[u8]) -> String {
        format!(
            "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            String::from_utf8_lossy(body)
        )
    }

    #[test]
    fn range_ignored_200_restarts_instead_of_appending() {
        let temp = temp_dir();
        let dir = temp.path();
        let bytes = b"complete artifact body";
        let art = artifact(
            serve_one(response(
                "200 OK",
                "Content-Type: application/octet-stream\r\n",
                bytes,
            )),
            bytes,
        );
        let id = artifact_id(&art);
        std::fs::write(dir.join(format!("artifact-{id}.part")), b"stale partial").unwrap();

        let path = download(&art, dir, Box::new(|_, _| {})).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn valid_206_range_is_appended_and_checked() {
        let temp = temp_dir();
        let dir = temp.path();
        let bytes = b"whole payload";
        let prefix = b"whole ";
        let suffix = &bytes[prefix.len()..];
        let headers = format!(
            "Content-Range: bytes {}-{}/{}\r\nContent-Type: application/octet-stream\r\n",
            prefix.len(),
            bytes.len() - 1,
            bytes.len()
        );
        let art = artifact(
            serve_one(response("206 Partial Content", &headers, suffix)),
            bytes,
        );
        let id = artifact_id(&art);
        std::fs::write(dir.join(format!("artifact-{id}.part")), prefix).unwrap();

        let path = download(&art, dir, Box::new(|_, _| {})).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn malformed_content_range_is_rejected() {
        let temp = temp_dir();
        let dir = temp.path();
        let bytes = b"whole payload";
        let art = artifact(
            serve_one(response(
                "206 Partial Content",
                "Content-Range: bytes 0-2/13\r\n",
                b"pay",
            )),
            bytes,
        );
        let id = artifact_id(&art);
        std::fs::write(dir.join(format!("artifact-{id}.part")), b"pre").unwrap();
        assert!(download(&art, dir, Box::new(|_, _| {})).is_err());
    }

    #[test]
    fn rejects_placeholder_hash_and_unsafe_archive_paths() {
        let invalid = Artifact {
            url: "https://example.invalid/a.zip".into(),
            sha256: "<fill-me>".into(),
            size: 10,
        };
        assert!(validate_artifact(&invalid).is_err());
        assert!(validate_symlink_target(
            Path::new("Frameworks/Current"),
            Path::new("../../outside")
        )
        .is_err());
        assert!(validate_symlink_target(Path::new("Frameworks/Current"), Path::new("A")).is_ok());
    }
}
