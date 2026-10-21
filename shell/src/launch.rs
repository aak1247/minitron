use crate::config::ShellConfig;
use crate::release::Release;
use crate::runtime::Runtime;
use anyhow::{Context, Result};
use std::ffi::OsString;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// Rust canonicalization produces verbatim Windows paths. Electron's default
// app loader treats that prefix as a URL/path switch and cannot load the asar.
fn electron_app_argument(path: &std::path::Path) -> OsString {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
            return OsString::from_wide(&[vec![92, 92], wide[8..].to_vec()].concat());
        }
        if wide.starts_with(&[92, 92, 63, 92]) {
            return OsString::from_wide(&wide[4..]);
        }
    }
    path.as_os_str().to_owned()
}

pub fn launch(
    rt: &Runtime,
    cfg: &ShellConfig,
    release: &Release,
    args: &[OsString],
    update_args: Option<Vec<OsString>>,
) -> Result<i32> {
    release.validate()?;
    let mut lease = crate::runtime::acquire_usage(cfg, rt)?;
    let ready_path = crate::updater::mark_started(cfg, std::process::id())?;
    let txid = crate::updater::attempt_id(cfg)?;
    #[cfg(target_os = "macos")]
    let electron_executable = if cfg.is_macos_app_bundle()? {
        crate::runtime::prepare_macos_host(cfg, rt, release)?
    } else {
        rt.electron_bin.clone()
    };
    #[cfg(not(target_os = "macos"))]
    let electron_executable = rt.electron_bin.clone();
    let mut command = Command::new(&electron_executable);
    command
        .arg(electron_app_argument(
            &release.resources_dir.join("app.asar"),
        ))
        .args(args)
        .current_dir(cfg.app_dir()?)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("ERS_READY_FILE")
        .env_remove("ERS_RELEASE_TXID")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
        .env(
            "MINITRON_LAUNCHER",
            ordinary_absolute_path(&std::env::current_exe()?)?,
        )
        .env(
            "MINITRON_RESOURCES_DIR",
            ordinary_absolute_path(&release.resources_dir)?,
        )
        .env("MINITRON_APP_ID", &cfg.app_id);
    if let Some(path) = &ready_path {
        command.env("ERS_READY_FILE", path);
    }
    if let Some(txid) = &txid {
        command.env("ERS_RELEASE_TXID", txid);
    }
    let mut process_record = crate::lifecycle::ProcessRecordGuard::begin(cfg)?;
    let mut child = match command.spawn().context("spawn shared Electron") {
        Ok(child) => child,
        Err(error) => {
            crate::updater::finish_attempt(cfg, 1, false)?;
            process_record.finish()?;
            return Err(error);
        }
    };
    if let Err(error) = process_record.record_child(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = process_record.finish();
        return Err(error);
    }
    if let Err(error) = lease.record_child(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    if ready_path.is_some() {
        crate::updater::mark_started(cfg, child.id())?;
    }
    if let Some(args) = update_args {
        crate::background_update(cfg.clone(), args);
    }
    let started = Instant::now();
    let mut healthy = false;
    let code = loop {
        if !healthy {
            healthy = ready_path.as_ref().is_some_and(|path| {
                std::fs::read(path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .is_some_and(|value| {
                        value.get("ready").and_then(|v| v.as_bool()) == Some(true)
                            && value.get("txid").and_then(|v| v.as_str()) == txid.as_deref()
                    })
            });
            // Unmodified apps use this weak bootstrap check, never a business-health assertion.
            if started.elapsed() >= Duration::from_secs(10) {
                healthy = true;
            }
        }
        if let Some(status) = child.try_wait()? {
            break status.code().unwrap_or(1);
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    crate::updater::finish_attempt(cfg, code, healthy)?;
    process_record.finish()?;
    {
        let _state = crate::updater::state_lock(cfg)?;
        crate::runtime::register(cfg, &crate::updater::retained_releases(cfg)?)?;
    }
    eprintln!("ELECTRON_EXIT:{code}");
    Ok(code)
}

fn ordinary_absolute_path(path: &std::path::Path) -> Result<OsString> {
    let absolute = std::fs::canonicalize(path)
        .with_context(|| format!("resolve absolute path {}", path.display()))?;
    Ok(electron_app_argument(&absolute))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn electron_receives_standard_absolute_windows_paths() {
        assert_eq!(
            electron_app_argument(std::path::Path::new(r"\\?\C:\Apps\中文\app.asar")),
            OsString::from(r"C:\Apps\中文\app.asar")
        );
        assert_eq!(
            electron_app_argument(std::path::Path::new(r"\\?\UNC\server\Apps\app.asar")),
            OsString::from(r"\\server\Apps\app.asar")
        );
    }
}
