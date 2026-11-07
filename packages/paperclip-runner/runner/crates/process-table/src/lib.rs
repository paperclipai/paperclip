//! Reads the host process table: PID, parent, process group and start time.
//!
//! `paperclip-runner-core` forbids unsafe code. macOS exposes this table only
//! through libproc, so the two libproc calls live here, each checked against
//! the size the kernel reports. Linux reads `/proc` without unsafe code.

#![deny(unsafe_op_in_unsafe_fn)]

/// One process as the kernel reported it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ProcessEntry {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// Start time in a platform unit (macOS: microseconds since the epoch;
    /// Linux: clock ticks since boot). Compare only with the same host.
    pub started: u64,
    pub zombie: bool,
}

/// Lists every process the caller can inspect. `None` when the table cannot
/// be read at all, or on an unsupported platform.
pub fn list() -> Option<Vec<ProcessEntry>> {
    platform::list()
}

/// Reads one process. `None` when it does not exist or cannot be inspected.
pub fn read(pid: i32) -> Option<ProcessEntry> {
    if pid <= 0 {
        return None;
    }
    platform::read(pid)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ProcessEntry;
    use std::mem::{size_of, MaybeUninit};

    /// `SZOMB` from <sys/proc.h>.
    const SZOMB: u32 = 5;
    /// Room for processes started between counting and listing.
    const LIST_HEADROOM: usize = 256;

    pub(super) fn list() -> Option<Vec<ProcessEntry>> {
        // SAFETY: a null buffer of size zero asks only for the PID count.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        let capacity = usize::try_from(count).ok()?.checked_add(LIST_HEADROOM)?;
        let mut pids: Vec<libc::pid_t> = vec![0; capacity];
        let bytes = i32::try_from(capacity.checked_mul(size_of::<libc::pid_t>())?).ok()?;
        // SAFETY: `pids` owns `bytes` writable bytes for the call's duration.
        let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        let listed = usize::try_from(listed).ok()?;
        if listed == 0 {
            return None;
        }
        pids.truncate(listed.min(capacity));
        Some(pids.into_iter().filter_map(super::read).collect())
    }

    pub(super) fn read(pid: i32) -> Option<ProcessEntry> {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
        // SAFETY: `info` is a zeroed `proc_bsdinfo` of exactly `size` bytes.
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read != size {
            return None;
        }
        // SAFETY: the kernel filled all `size` bytes, and every field is a
        // plain integer or byte array for which any bit pattern is valid.
        let info = unsafe { info.assume_init() };
        Some(ProcessEntry {
            pid,
            ppid: i32::try_from(info.pbi_ppid).ok()?,
            pgid: i32::try_from(info.pbi_pgid).ok()?,
            started: info
                .pbi_start_tvsec
                .saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec),
            zombie: info.pbi_status == SZOMB,
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::ProcessEntry;

    pub(super) fn list() -> Option<Vec<ProcessEntry>> {
        let entries = std::fs::read_dir("/proc").ok()?;
        Some(
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
                .filter_map(read)
                .collect(),
        )
    }

    pub(super) fn read(pid: i32) -> Option<ProcessEntry> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        parse_stat(pid, &stat)
    }

    /// `/proc/<pid>/stat` fields after the parenthesized command name, which
    /// may itself contain spaces and parentheses.
    pub(super) fn parse_stat(pid: i32, stat: &str) -> Option<ProcessEntry> {
        let rest = &stat[stat.rfind(')')? + 1..];
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let state = *fields.first()?;
        Some(ProcessEntry {
            pid,
            ppid: fields.get(1)?.parse().ok()?,
            pgid: fields.get(2)?.parse().ok()?,
            started: fields.get(19)?.parse().ok()?,
            zombie: state == "Z" || state == "X",
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::ProcessEntry;

    pub(super) fn list() -> Option<Vec<ProcessEntry>> {
        None
    }

    pub(super) fn read(_pid: i32) -> Option<ProcessEntry> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn lists_this_process_with_its_parent_and_group() {
        let me = i32::try_from(std::process::id()).unwrap();
        let listed = list().expect("process table");
        let entry = listed.iter().find(|entry| entry.pid == me).expect("self");
        assert_eq!(Some(*entry), read(me));
        assert!(entry.ppid > 0);
        assert!(entry.pgid > 0);
        assert!(entry.started > 0);
        assert!(!entry.zombie);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parses_linux_stat_with_spaces_and_parentheses_in_the_name() {
        let stat = "4242 (a (b) c) S 1 4200 4200 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0";
        let parsed = platform::parse_stat(4242, stat).unwrap();
        assert_eq!(
            (parsed.ppid, parsed.pgid, parsed.started, parsed.zombie),
            (1, 4200, 987654, false)
        );
    }
}
