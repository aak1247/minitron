//! Preview the actual launcher without networking or touching the runtime cache.
//! cargo run --example launcher-preview -- downloading [snapshot.ppm]
//! States: checking, downloading, verifying, error, done.
use slint::ComponentHandle;
use std::io::Write;
use std::time::Duration;

slint::include_modules!();

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stage = args.first().map(String::as_str).unwrap_or("downloading");
    if !matches!(
        stage,
        "checking" | "downloading" | "verifying" | "error" | "done"
    ) {
        return Err("expected checking, downloading, verifying, error, or done".into());
    }
    let ui = ShellWindow::new()?;
    ui.set_stage(stage.into());
    ui.set_runtime_label("Electron 32.2.0 · win32-x64".into());
    ui.set_progress(if stage == "done" || stage == "verifying" {
        1.0
    } else {
        0.64
    });
    ui.set_indeterminate(stage == "checking" || stage == "verifying");
    ui.set_message(if stage == "error" {
        "下载运行环境失败：连接已中断。\n\n示例诊断信息：\nread artifact response: connection reset by peer\n\n已下载的部分文件会保留，重试时将尝试断点续传。".into()
    } else if stage == "checking" {
        "正在连接并检查运行环境…".into()
    } else {
        "正在下载所需运行环境，请保持网络连接。".into()
    });
    if stage != "checking" {
        ui.set_transfer_label(
            if stage == "downloading" {
                "67.8 / 105.9 MiB"
            } else {
                "105.9 / 105.9 MiB"
            }
            .into(),
        );
    }
    let weak = ui.as_weak();
    ui.on_retry(move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_stage("checking".into());
            ui.set_progress(0.0);
            ui.set_transfer_label("".into());
            ui.set_message("正在重新连接并检查运行环境…".into());
            ui.set_indeterminate(true);
        }
    });

    // Optional snapshot is rendered by Slint, not an HTML reconstruction.
    let timer = slint::Timer::default();
    if let Some(path) = args.get(1).cloned() {
        let weak = ui.as_weak();
        let action = args.get(2).cloned().unwrap_or_default();
        let exercised = std::cell::Cell::new(false);
        timer.start(
            slint::TimerMode::Repeated,
            Duration::from_millis(300),
            move || {
                let ui = weak.upgrade().unwrap();
                if !exercised.replace(true) {
                    if action == "compact" {
                        ui.window().set_size(slint::LogicalSize::new(620.0, 500.0));
                    } else if action == "details" || action == "retry" {
                        // Exercise actual controls at the default logical window size.
                        assert_eq!(ui.get_stage(), "error");
                        let position = slint::LogicalPosition::new(
                            if action == "details" { 150.0 } else { 75.0 },
                            350.0,
                        );
                        ui.window()
                            .dispatch_event(slint::platform::WindowEvent::PointerPressed {
                                position,
                                button: slint::platform::PointerEventButton::Left,
                            });
                        ui.window()
                            .dispatch_event(slint::platform::WindowEvent::PointerReleased {
                                position,
                                button: slint::platform::PointerEventButton::Left,
                            });
                        if action == "retry" {
                            assert_eq!(ui.get_stage(), "checking");
                            assert_eq!(ui.get_progress(), 0.0);
                            assert!(ui.get_transfer_label().is_empty());
                            assert!(ui.get_indeterminate());
                        }
                    } else if !action.is_empty() {
                        panic!("expected compact, details, or retry snapshot action");
                    }
                    // Let the native resize and conditional controls settle before capture.
                    return;
                }
                let snapshot = ui.window().take_snapshot().expect("render snapshot");
                let mut file = std::fs::File::create(&path).expect("create snapshot");
                write!(
                    file,
                    "P6\n{} {}\n255\n",
                    snapshot.width(),
                    snapshot.height()
                )
                .unwrap();
                for pixel in snapshot.as_slice() {
                    file.write_all(&[pixel.r, pixel.g, pixel.b]).unwrap();
                }
                slint::quit_event_loop().unwrap();
            },
        );
    }
    ui.run()?;
    Ok(())
}
