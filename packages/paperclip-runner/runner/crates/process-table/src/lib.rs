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

/// One read of the whole table.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub entries: Vec<ProcessEntry>,
    /// Listed processes that still exist but whose details could not be
    /// read. A caller must not treat them as exited.
    pub unreadable: Vec<i32>,
}

/// The result of reading one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Read {
    Present(ProcessEntry),
    /// The process does not exist.
    Gone,
    /// The process may exist, but its details could not be read.
    Unreadable,
}

impl Read {
    pub fn entry(self) -> Option<ProcessEntry> {
        match self {
            Self::Present(entry) => Some(entry),
            Self::Gone | Self::Unreadable => None,
        }
    }
}

/// Lists every process. `None` when the table cannot be read at all, or on
/// an unsupported platform.
pub fn list() -> Option<Snapshot> {
    let mut snapshot = Snapshot::default();
    for pid in platform::pids()? {
        match read(pid) {
            Read::Present(entry) => snapshot.entries.push(entry),
            Read::Gone => {}
            Read::Unreadable => snapshot.unreadable.push(pid),
        }
    }
    Some(snapshot)
}

/// Reads one process.
pub fn read(pid: i32) -> Read {
    if pid <= 0 {
        return Read::Gone;
    }
    platform::read(pid)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{ProcessEntry, Read};
    use std::mem::{size_of, MaybeUninit};

    /// `SZOMB` from <sys/proc.h>.
    const SZOMB: u32 = 5;
    /// Room for processes started between counting and listing.
    const LIST_HEADROOM: usize = 256;

    pub(super) fn pids() -> Option<Vec<i32>> {
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
        Some(pids.into_iter().filter(|pid| *pid > 0).collect())
    }

    pub(super) fn read(pid: i32) -> Read {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let Ok(size) = i32::try_from(size_of::<libc::proc_bsdinfo>()) else {
            return Read::Unreadable;
        };
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
            // A short read with ESRCH means the process is gone. Anything
            // else leaves it unresolved.
            let error = std::io::Error::last_os_error();
            return if read <= 0 && error.raw_os_error() == Some(libc::ESRCH) {
                Read::Gone
            } else {
                Read::Unreadable
            };
        }
        // SAFETY: the kernel filled all `size` bytes, and every field is a
        // plain integer or byte array for which any bit pattern is valid.
        let info = unsafe { info.assume_init() };
        let (Ok(ppid), Ok(pgid)) = (i32::try_from(info.pbi_ppid), i32::try_from(info.pbi_pgid))
        else {
            return Read::Unreadable;
        };
        Read::Present(ProcessEntry {
            pid,
            ppid,
            pgid,
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
    use super::{ProcessEntry, Read};

    pub(super) fn pids() -> Option<Vec<i32>> {
        let entries = std::fs::read_dir("/proc").ok()?;
        Some(
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
                .collect(),
        )
    }

    pub(super) fn read(pid: i32) -> Read {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => parse_stat(pid, &stat).map_or(Read::Unreadable, Read::Present),
            // The process exited between listing and reading.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(3) =>
            {
                Read::Gone
            }
            Err(_) => Read::Unreadable,
        }
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
    use super::Read;

    pub(super) fn pids() -> Option<Vec<i32>> {
        None
    }

    pub(super) fn read(_pid: i32) -> Read {
        Read::Unreadable
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
        let entry = listed
            .entries
            .iter()
            .find(|entry| entry.pid == me)
            .expect("self");
        assert_eq!(Read::Present(*entry), read(me));
        assert!(entry.ppid > 0);
        assert!(entry.pgid > 0);
        assert!(entry.started > 0);
        assert!(!entry.zombie);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reports_an_exited_process_as_gone() {
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .spawn()
            .unwrap();
        let pid = i32::try_from(child.id()).unwrap();
        child.wait().unwrap();
        assert_eq!(read(pid), Read::Gone);
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
