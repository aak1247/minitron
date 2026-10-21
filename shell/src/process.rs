#[cfg(any(target_os = "linux", target_os = "macos"))]
use anyhow::Context;
use anyhow::{bail, ensure, Result};
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
    #[cfg(target_os = "linux")]
    {
        if pid > i32::MAX as u32 {
            return false;
        }
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            if let Some(state) = stat
                .rfind(')')
                .and_then(|close| stat[close + 1..].split_whitespace().next())
                .and_then(|state| state.chars().next())
            {
                return !matches!(state, 'Z' | 'X');
            }
        }
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(all(not(windows), not(target_os = "linux")))]
    {
        // kill() interprets negative values as process groups, not process IDs.
        // A stale or malformed u32 lease must never become kill(-1, 0).
        if pid > i32::MAX as u32 {
            return false;
        }
        unsafe {
            libc::kill(pid as i32, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn current_process_is_alive_but_invalid_ids_are_not() {
        assert!(super::is_alive(std::process::id()));
        assert!(!super::is_alive(0));
        assert!(!super::is_alive(u32::MAX));
        #[cfg(target_os = "macos")]
        assert!(super::start_time(std::process::id()).unwrap() > 0);
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
    #[cfg(target_os = "linux")]
    {
        // Linux field 22 is the kernel start tick count, which distinguishes
        // a process from a later process that reused its PID.
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        let close = stat
            .rfind(')')
            .context("malformed /proc process stat command")?;
        let start = stat[close + 1..]
            .split_whitespace()
            .nth(19)
            .context("missing /proc process start time")?
            .parse::<u64>()?;
        Ok(start)
    }
    #[cfg(target_os = "macos")]
    {
        let info = macos_process_info(pid)?;
        Ok(info.pbi_start_tvsec.saturating_mul(1_000_000) + info.pbi_start_tvusec)
    }
    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    {
        // Keep non-Linux Unix launch/runtime bookkeeping compatible. A zero
        // identity is deliberately rejected by terminate_identity, so these
        // platforms never signal a process using a PID alone.
        let _ = pid;
        Ok(0)
    }
}

/// Stop only the process instance whose creation time was recorded by this
/// installation. Returns false when that process has already exited or its
/// PID now refers to a different instance.
pub fn terminate_identity(pid: u32, expected_start_time: u64) -> Result<bool> {
    if pid == 0 || pid == std::process::id() {
        bail!("refusing to terminate invalid or current process id {pid}");
    }
    if expected_start_time == 0 {
        bail!("process {pid} has no reliable creation time; refusing to signal by PID alone");
    }

    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };

        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            let error = GetLastError();
            if error == ERROR_INVALID_PARAMETER {
                return Ok(false);
            }
            return Err(std::io::Error::from_raw_os_error(error as i32).into());
        }
        let mut created: windows_sys::Win32::Foundation::FILETIME = std::mem::zeroed();
        let mut exit = created;
        let mut kernel = created;
        let mut user = created;
        if GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            return Err(error.into());
        }
        let actual = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        if actual != expected_start_time {
            CloseHandle(handle);
            return Ok(false);
        }
        if TerminateProcess(handle, 1) == 0 {
            let result = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            if result == WAIT_OBJECT_0 {
                return Ok(true);
            }
            return Err(std::io::Error::last_os_error().into());
        }
        let result = WaitForSingleObject(handle, 5_000);
        CloseHandle(handle);
        match result {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => bail!("process {pid} did not exit after termination"),
            _ => Err(std::io::Error::last_os_error().into()),
        }
    }

    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::time::Instant;

        // pidfds pin the process object, so PID reuse between identity check
        // and signal delivery cannot redirect the signal to an unrelated app.
        const SYS_PIDFD_SEND_SIGNAL: libc::c_long = 424;
        const SYS_PIDFD_OPEN: libc::c_long = 434;
        let fd = libc::syscall(SYS_PIDFD_OPEN, pid as libc::pid_t, 0) as i32;
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let pidfd = std::os::fd::OwnedFd::from_raw_fd(fd);

        match start_time(pid) {
            Ok(actual) if actual == expected_start_time => {}
            Ok(_) => return Ok(false),
            Err(error) => {
                if pidfd_exited(pidfd.as_raw_fd(), 0)? {
                    return Ok(false);
                }
                return Err(error).context("verify process identity before signaling");
            }
        }

        send_pidfd_signal(SYS_PIDFD_SEND_SIGNAL, pidfd.as_raw_fd(), libc::SIGTERM)?;
        if pidfd_exited(pidfd.as_raw_fd(), 2_000)? {
            return Ok(true);
        }
        send_pidfd_signal(SYS_PIDFD_SEND_SIGNAL, pidfd.as_raw_fd(), libc::SIGKILL)?;
        if pidfd_exited(pidfd.as_raw_fd(), 2_000)? {
            Ok(true)
        } else {
            bail!("process {pid} did not exit after SIGKILL")
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::time::Instant;
        if !is_alive(pid) {
            return Ok(false);
        }
        match start_time(pid) {
            Ok(actual) if actual == expected_start_time => {}
            Ok(_) => return Ok(false),
            Err(_error) if !is_alive(pid) => return Ok(false),
            Err(error) => {
                return Err(error).context("verify macOS process identity before signaling")
            }
        }

        macos_signal(pid, libc::SIGTERM)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        if wait_for_identity_change(pid, expected_start_time, deadline)? {
            return Ok(true);
        }
        // Recheck immediately before SIGKILL. macOS has no pidfd; if the PID
        // has changed identity, do not send the escalation signal.
        match start_time(pid) {
            Ok(actual) if actual == expected_start_time => {}
            Ok(_) => return Ok(true),
            Err(_error) if !is_alive(pid) => return Ok(true),
            Err(error) => {
                return Err(error).context("recheck macOS process identity before SIGKILL")
            }
        }
        macos_signal(pid, libc::SIGKILL)?;
        if wait_for_identity_change(
            pid,
            expected_start_time,
            Instant::now() + Duration::from_secs(2),
        )? {
            Ok(true)
        } else {
            bail!("process {pid} did not exit after SIGKILL")
        }
    }

    #[cfg(all(not(windows), not(target_os = "linux"), not(target_os = "macos")))]
    {
        let _ = (pid, expected_start_time);
        bail!("safe process termination is unsupported on this platform")
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcBsdInfo {
    pbi_flags: u32,
    pbi_status: u32,
    pbi_xstatus: u32,
    pbi_pid: u32,
    pbi_ppid: u32,
    pbi_uid: u32,
    pbi_gid: u32,
    pbi_ruid: u32,
    pbi_rgid: u32,
    pbi_svuid: u32,
    pbi_svgid: u32,
    rfu_1: u32,
    pbi_comm: [libc::c_char; 16],
    pbi_name: [libc::c_char; 32],
    pbi_nfiles: u32,
    pbi_pgid: u32,
    pbi_pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    pbi_nice: i32,
    pbi_start_tvsec: u64,
    pbi_start_tvusec: u64,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        buffersize: libc::c_int,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn macos_process_info(pid: u32) -> Result<ProcBsdInfo> {
    if pid == 0 || pid > i32::MAX as u32 {
        bail!("invalid macOS process id {pid}");
    }
    let mut info: ProcBsdInfo = unsafe { std::mem::zeroed() };
    let size = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            3, // PROC_PIDTBSDINFO
            0,
            &mut info as *mut _ as *mut libc::c_void,
            std::mem::size_of::<ProcBsdInfo>() as libc::c_int,
        )
    };
    if size != std::mem::size_of::<ProcBsdInfo>() as libc::c_int {
        return Err(std::io::Error::last_os_error().into());
    }
    ensure!(
        info.pbi_pid == pid,
        "macOS process PID changed while reading identity"
    );
    Ok(info)
}

#[cfg(target_os = "macos")]
fn macos_signal(pid: u32, signal: i32) -> Result<()> {
    if pid == 0 || pid > i32::MAX as u32 {
        bail!("invalid macOS process id {pid}");
    }
    if unsafe { libc::kill(pid as libc::pid_t, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error.into())
}

#[cfg(target_os = "macos")]
fn wait_for_identity_change(pid: u32, expected: u64, deadline: Instant) -> Result<bool> {
    while Instant::now() < deadline {
        match start_time(pid) {
            Ok(actual) if actual == expected => {}
            Ok(_) => return Ok(true),
            Err(_error) if !is_alive(pid) => return Ok(true),
            Err(error) => {
                return Err(error).context("inspect macOS process while waiting for exit")
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn pidfd_exited(fd: std::os::fd::RawFd, timeout_ms: i32) -> Result<bool> {
    let mut pollfd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut pollfd, 1, timeout_ms) };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(result > 0 && (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR)) != 0)
}

#[cfg(target_os = "linux")]
fn send_pidfd_signal(
    syscall_number: libc::c_long,
    fd: std::os::fd::RawFd,
    signal: i32,
) -> Result<()> {
    let result = unsafe {
        libc::syscall(
            syscall_number,
            fd,
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
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
