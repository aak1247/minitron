//! Download UI owns preparation only; the main coordinator launches Electron after UI exit.
use crate::{download, manifest::Artifact, release::RuntimeKey, runtime, ShellWindow};
use anyhow::{bail, Result};
use slint::ComponentHandle;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

type Outcome = Arc<Mutex<Option<Result<runtime::Runtime>>>>;

fn begin(
    window: slint::Weak<ShellWindow>,
    key: RuntimeKey,
    artifact: Artifact,
    busy: Arc<AtomicBool>,
    outcome: Outcome,
) {
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = window.upgrade() {
        w.set_stage("downloading".into());
        w.set_message("正在准备共享 Electron 运行时…".into());
        w.set_indeterminate(true);
    }
    std::thread::spawn(move || {
        let progress_window = window.clone();
        let progress: download::ProgressFn = Box::new(move |got, total| {
            let weak = progress_window.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(w) = weak.upgrade() {
                    w.set_indeterminate(total == 0);
                    w.set_progress(if total == 0 {
                        0.0
                    } else {
                        got as f32 / total as f32
                    });
                    w.set_message(
                        format!(
                            "下载运行时：{:.1} / {:.1} MiB",
                            got as f64 / 1_048_576.0,
                            total as f64 / 1_048_576.0
                        )
                        .into(),
                    );
                }
            });
        });
        let result = runtime::ensure(&key, &artifact, progress);
        let succeeded = result.is_ok();
        let message = result.as_ref().err().map(|error| format!("{error:#}"));
        if let Ok(mut slot) = outcome.lock() {
            *slot = Some(result);
        }
        busy.store(false, Ordering::SeqCst);
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(w) = window.upgrade() {
                if succeeded {
                    let _ = w.hide();
                    let _ = slint::quit_event_loop();
                } else {
                    w.set_stage("error".into());
                    w.set_indeterminate(false);
                    w.set_message(message.unwrap_or_default().into());
                }
            }
        });
    });
}

pub fn install_runtime(key: &RuntimeKey, artifact: &Artifact) -> Result<runtime::Runtime> {
    let window = ShellWindow::new()?;
    let busy = Arc::new(AtomicBool::new(false));
    let outcome: Outcome = Arc::new(Mutex::new(None));
    let weak = window.as_weak();
    let retry_weak = weak.clone();
    let retry_key = key.clone();
    let retry_artifact = artifact.clone();
    let retry_busy = busy.clone();
    let retry_outcome = outcome.clone();
    window.on_retry(move || {
        begin(
            retry_weak.clone(),
            retry_key.clone(),
            retry_artifact.clone(),
            retry_busy.clone(),
            retry_outcome.clone(),
        )
    });
    begin(weak, key.clone(), artifact.clone(), busy, outcome.clone());
    window.run()?;
    let result = outcome
        .lock()
        .map_err(|_| anyhow::anyhow!("runtime worker failed"))?
        .take();
    match result {
        Some(result) => result,
        None => bail!("runtime installation cancelled"),
    }
}
