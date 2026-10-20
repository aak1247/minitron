//! Download UI owns preparation only; the main coordinator launches Electron after UI exit.
use crate::{download, manifest::Artifact, release::RuntimeKey, runtime, ShellWindow};
use anyhow::{bail, Result};
use slint::ComponentHandle;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

type Outcome = Arc<Mutex<Option<Result<runtime::Runtime>>>>;
type Progress = Arc<Mutex<Option<(u64, u64)>>>;

fn begin(
    window: slint::Weak<ShellWindow>,
    key: RuntimeKey,
    artifact: Artifact,
    busy: Arc<AtomicBool>,
    outcome: Outcome,
    progress: Progress,
) {
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut slot) = outcome.lock() {
        *slot = None;
    }
    if let Ok(mut slot) = progress.lock() {
        *slot = None;
    }
    if let Some(w) = window.upgrade() {
        w.set_stage("checking".into());
        w.set_message("正在连接并检查运行环境…".into());
        w.set_progress(0.0);
        w.set_transfer_label("".into());
        w.set_indeterminate(true);
    }
    std::thread::spawn(move || {
        // Keep only the latest progress sample. Posting one UI event for every
        // network chunk can flood a slow/virtual Windows message queue and lose
        // the completion handoff. The UI thread owns all rendering and exit.
        let callback: download::ProgressFn = Box::new(move |got, total| {
            if let Ok(mut slot) = progress.lock() {
                *slot = Some((got, total));
            }
        });
        let result = runtime::ensure(&key, &artifact, callback);
        if let Ok(mut slot) = outcome.lock() {
            *slot = Some(result);
        }
        busy.store(false, Ordering::SeqCst);
    });
}

pub fn install_runtime(key: &RuntimeKey, artifact: &Artifact) -> Result<runtime::Runtime> {
    let window = ShellWindow::new()?;
    window.set_runtime_label(format!("Electron {} · {}", key.version, key.platform).into());
    let busy = Arc::new(AtomicBool::new(false));
    let outcome: Outcome = Arc::new(Mutex::new(None));
    let progress: Progress = Arc::new(Mutex::new(None));
    let weak = window.as_weak();
    let retry_weak = weak.clone();
    let retry_key = key.clone();
    let retry_artifact = artifact.clone();
    let retry_busy = busy.clone();
    let retry_outcome = outcome.clone();
    let retry_progress = progress.clone();
    window.on_retry(move || {
        begin(
            retry_weak.clone(),
            retry_key.clone(),
            retry_artifact.clone(),
            retry_busy.clone(),
            retry_outcome.clone(),
            retry_progress.clone(),
        )
    });
    let refresh = slint::Timer::default();
    let refresh_window = weak.clone();
    let refresh_busy = busy.clone();
    let refresh_outcome = outcome.clone();
    let refresh_progress = progress.clone();
    refresh.start(
        slint::TimerMode::Repeated,
        Duration::from_millis(100),
        move || {
            let Some(w) = refresh_window.upgrade() else {
                return;
            };
            let preparing = refresh_busy.load(Ordering::SeqCst);
            let sample = if preparing {
                refresh_progress.lock().ok().and_then(|slot| *slot)
            } else {
                None
            };
            if let Some((got, total)) = sample {
                let verifying = total > 0 && got >= total;
                w.set_stage(
                    if verifying {
                        "verifying"
                    } else {
                        "downloading"
                    }
                    .into(),
                );
                w.set_indeterminate(total == 0 || verifying);
                w.set_progress(if total == 0 {
                    0.0
                } else {
                    got as f32 / total as f32
                });
                w.set_transfer_label(
                    format!(
                        "{:.1} / {:.1} MiB",
                        got as f64 / 1_048_576.0,
                        total as f64 / 1_048_576.0
                    )
                    .into(),
                );
                w.set_message("正在下载所需运行环境，请保持网络连接。".into());
            }
            if preparing {
                return;
            }
            let status = refresh_outcome.lock().ok().and_then(|slot| {
                slot.as_ref().map(|result| {
                    result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|error| format!("{error:#}"))
                })
            });
            match status {
                Some(Ok(())) => {
                    // ComponentHandle::run hides the window after the loop returns.
                    // Request exit before changing visibility or dropping the proxy.
                    if let Err(error) = slint::quit_event_loop() {
                        eprintln!("RUNTIME_UI_QUIT_ERROR: {error}");
                    }
                }
                Some(Err(message)) => {
                    w.set_stage("error".into());
                    w.set_indeterminate(false);
                    w.set_message(message.into());
                }
                None => {}
            }
        },
    );
    let initial_key = key.clone();
    let initial_artifact = artifact.clone();
    let initial_outcome = outcome.clone();
    slint::Timer::single_shot(Duration::ZERO, move || {
        begin(
            weak,
            initial_key,
            initial_artifact,
            busy,
            initial_outcome,
            progress,
        );
    });
    window.run()?;
    eprintln!("RUNTIME_UI_CLOSED");
    let result = outcome
        .lock()
        .map_err(|_| anyhow::anyhow!("runtime worker failed"))?
        .take();
    match result {
        Some(result) => result,
        None => bail!("runtime installation cancelled"),
    }
}
