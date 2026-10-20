//! Release launchers do not create a console window on Windows. Explicit CLI
//! invocations may attach to an existing parent console; redirected handles
//! (including E2E pipes and copier logs) are always preserved.
pub fn prepare_cli_console() {
    #[cfg(all(windows, not(debug_assertions)))]
    if std::env::args_os()
        .skip(1)
        .any(|arg| arg.to_string_lossy().starts_with("--"))
        && !windows::has_stderr()
    {
        unsafe {
            windows::AttachConsole(u32::MAX);
        }
    }
}

pub fn show_unredirected_error(message: &str) {
    #[cfg(all(windows, not(debug_assertions)))]
    if !windows::has_stderr() && !std::env::args_os().any(|arg| arg == "--headless") {
        let language = crate::i18n::detect();
        let message: Vec<u16> = format!(
            "{}\n\n{message}",
            language.text("Unable to start the application.", "无法启动应用。")
        )
        .encode_utf16()
        .chain(Some(0))
        .collect();
        let title: Vec<u16> = format!("minitron · {}", language.text("Startup error", "启动错误"))
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            windows::MessageBoxW(std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), 0x10);
        }
    }
    #[cfg(not(all(windows, not(debug_assertions))))]
    let _ = message;
}

#[cfg(all(windows, not(debug_assertions)))]
mod windows {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        pub fn AttachConsole(process_id: u32) -> i32;
        fn GetStdHandle(handle: u32) -> *mut c_void;
    }
    #[link(name = "user32")]
    extern "system" {
        pub fn MessageBoxW(
            parent: *mut c_void,
            text: *const u16,
            title: *const u16,
            flags: u32,
        ) -> i32;
    }
    pub fn has_stderr() -> bool {
        let handle = unsafe { GetStdHandle((-12i32) as u32) };
        !handle.is_null() && handle as isize != -1
    }
}
