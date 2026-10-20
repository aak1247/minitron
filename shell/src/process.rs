use anyhow::{bail, Result};
use std::time::{Duration, Instant};

/// Access-denied and unknown states are treated as alive: cleanup must be conservative.
pub fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let result = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        result == WAIT_TIMEOUT || result == u32::MAX
    }
    #[cfg(not(windows))]
    {
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

pub fn start_time(pid: u32) -> Result<u64> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exit = created;
        let mut kernel = created;
        let mut user = created;
        let result = GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if result == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Ok(0)
    }
}

pub fn wait_for_exit(pid: u32, timeout: Duration) -> Result<()> {
    if pid == 0 || pid == std::process::id() {
        bail!("invalid process to wait for");
    }
    let until = Instant::now() + timeout;
    while is_alive(pid) {
        if Instant::now() >= until {
            bail!("process {pid} did not exit before timeout");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
