//! Shared Electron runtime launcher.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod config;
mod download;
mod fsutil;
mod i18n;
mod launch;
mod lifecycle;
mod manifest;
mod platform_ui;
mod process;
mod release;
mod runtime;
mod selfupdate;
mod state;
mod updater;

slint::include_modules!();

use anyhow::{Context, Result};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub const SHELL_VERSION: &str = match option_env!("ERS_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() {
    platform_ui::prepare_cli_console();
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("SHELL_ERROR: {error:#}");
            platform_ui::show_unredirected_error(&format!("{error:#}"));
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|x| x == "--version") {
        println!("{SHELL_VERSION}");
        return Ok(0);
    }
    if args.first().is_some_and(|x| x == "--help") {
        println!("minitron {SHELL_VERSION}\n{}", i18n::detect().text(
            "Usage: minitron [--offline] [--headless] [--no-update] [-- app arguments]\n       minitron --check-update | --rollback | --stop | --uninstall | --version\n       minitron --app-dir <absolute-dir> --stop | --uninstall\nSet ELECTRON_RUNTIME_ROOT to override the user runtime cache.\nSet MINITRON_LANG=en or zh to override the system display language.",
            "用法：minitron [--offline] [--headless] [--no-update] [-- 应用参数]\n      minitron --check-update | --rollback | --stop | --uninstall | --version\n      minitron --app-dir <绝对目录> --stop | --uninstall\n设置 ELECTRON_RUNTIME_ROOT 可指定共享运行时缓存目录。\n设置 MINITRON_LANG=en 或 zh 可覆盖系统显示语言。"
        ));
        return Ok(0);
    }
    if args.first().is_some_and(|x| x == "--apply-update") {
        let ticket = args
            .get(1)
            .context("--apply-update requires a ticket path")?;
        selfupdate::apply_ticket(Path::new(ticket))?;
        return Ok(0);
    }
    if let Some((action, app_dir)) = management_command(&args)? {
        let cfg = match app_dir {
            Some(directory) => config::ShellConfig::load_for_app_dir(&directory)?,
            None => config::ShellConfig::load()?,
        };
        match action {
            ManagementCommand::Stop => {
                let application = lifecycle::stop_and_lock(&cfg)?;
                drop(application);
                println!("STOPPED");
            }
            ManagementCommand::Uninstall => {
                let app_lock = cfg.app_dir()?.join("updates/application.lock");
                let _application = fsutil::FileLock::try_exclusive(&app_lock)?
                    .context("this application installation is already running; close it before updating or uninstalling")?;
                runtime::unregister_and_maybe_cleanup(&cfg)?;
                println!("UNINSTALLED");
            }
        }
        return Ok(0);
    }
    let cfg = config::ShellConfig::load()?;
    let app_lock = cfg.app_dir()?.join("updates/application.lock");
    let _application = fsutil::FileLock::try_exclusive(&app_lock)?
        .context("this application installation is already running; close it before updating or uninstalling")?;
    if args.first().is_some_and(|x| x == "--rollback") {
        let release = updater::rollback(&cfg)?;
        let _state = updater::state_lock(&cfg)?;
        runtime::register(&cfg, &updater::retained_releases(&cfg)?)?;
        println!("ROLLED_BACK:{}", release.app_version);
        return Ok(0);
    }
    if args.first().is_some_and(|x| x == "--check-update") {
        let m = manifest::fetch(&cfg)?;
        if selfupdate::maybe_stage(&cfg, &m, &[])? {
            return Ok(0);
        }
        updater::stage(
            &cfg,
            &m,
            Box::new(|got, total| eprintln!("APP_DOWNLOAD:{got}/{total}")),
        )?;
        println!("UPDATE_STAGED");
        return Ok(0);
    }

    let mut offline = false;
    let mut headless = false;
    let mut no_update = false;
    let mut forwarded = Vec::new();
    let mut passthrough = false;
    for arg in &args {
        if passthrough {
            forwarded.push(arg.clone());
            continue;
        }
        if arg == "--" {
            passthrough = true;
        } else if arg == "--offline" {
            offline = true;
        } else if arg == "--headless" {
            headless = true;
        } else if arg == "--no-update" {
            no_update = true;
        } else {
            forwarded.push(arg.clone());
        }
    }
    if updater::activate_pending(&cfg)?.is_some() {
        eprintln!("RELEASE_ACTIVATED");
    }
    let active = updater::resolve_active(&cfg)?;
    active.validate()?;
    let rt = match runtime::locate(&active.runtime_key) {
        Ok(rt) => rt,
        Err(error) if offline => return Err(error.context("runtime unavailable in offline mode")),
        Err(_) => {
            let m = manifest::fetch(&cfg)?;
            if selfupdate::maybe_stage(&cfg, &m, &args)? {
                return Ok(0);
            }
            let artifact = m.runtime_artifact_for(&active.runtime_key)?;
            if headless {
                runtime::ensure(
                    &active.runtime_key,
                    artifact,
                    Box::new(|got, total| eprintln!("RUNTIME_DOWNLOAD:{got}/{total}")),
                )?
            } else {
                state::install_runtime(&active.runtime_key, artifact)?
            }
        }
    };
    {
        let _state = updater::state_lock(&cfg)?;
        runtime::register(&cfg, &updater::retained_releases(&cfg)?)?;
    }
    launch::launch(
        &rt,
        &cfg,
        &active,
        &forwarded,
        if offline || no_update {
            None
        } else {
            Some(args)
        },
    )
}

#[derive(Clone, Copy)]
enum ManagementCommand {
    Stop,
    Uninstall,
}

fn management_command(args: &[OsString]) -> Result<Option<(ManagementCommand, Option<PathBuf>)>> {
    fn action(arg: &OsStr) -> Option<ManagementCommand> {
        if arg == "--stop" {
            Some(ManagementCommand::Stop)
        } else if arg == "--uninstall" {
            Some(ManagementCommand::Uninstall)
        } else {
            None
        }
    }

    if args.len() == 1 {
        return Ok(action(&args[0]).map(|command| (command, None)));
    }
    if args.len() == 3 {
        let parsed = if args[0] == "--app-dir" {
            action(&args[2]).map(|command| (command, &args[1]))
        } else if args[1] == "--app-dir" {
            action(&args[0]).map(|command| (command, &args[2]))
        } else {
            None
        };
        if let Some((command, directory)) = parsed {
            let directory = PathBuf::from(directory);
            anyhow::ensure!(directory.is_absolute(), "--app-dir must be absolute");
            return Ok(Some((command, Some(directory))));
        }
    }

    let has_app_dir = args.iter().any(|arg| arg == "--app-dir");
    let starts_with_management = args.first().and_then(|arg| action(arg)).is_some();
    if has_app_dir || starts_with_management {
        anyhow::bail!("--stop and --uninstall accept no application arguments; --app-dir must be paired with one of them");
    }
    Ok(None)
}

fn background_update(cfg: config::ShellConfig, restart_args: Vec<OsString>) {
    std::thread::spawn(move || {
        let result = (|| -> Result<()> {
            let m = manifest::fetch(&cfg)?;
            if selfupdate::maybe_stage(&cfg, &m, &restart_args)? {
                eprintln!("SHELL_UPDATE_STAGED: applies after application exit");
                return Ok(());
            }
            updater::stage(&cfg, &m, Box::new(|_, _| {}))
        })();
        if let Err(error) = result {
            eprintln!("UPDATE_DEFERRED: {error:#}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn management_commands_accept_app_dir_before_or_after_action() {
        let directory = std::env::temp_dir().join("minitron-install");
        let before = vec![
            OsString::from("--app-dir"),
            directory.as_os_str().to_owned(),
            OsString::from("--stop"),
        ];
        assert!(matches!(
            management_command(&before).unwrap(),
            Some((ManagementCommand::Stop, Some(path))) if path == directory
        ));

        let after = vec![
            OsString::from("--uninstall"),
            OsString::from("--app-dir"),
            directory.as_os_str().to_owned(),
        ];
        assert!(matches!(
            management_command(&after).unwrap(),
            Some((ManagementCommand::Uninstall, Some(path))) if path == directory
        ));
    }
}
