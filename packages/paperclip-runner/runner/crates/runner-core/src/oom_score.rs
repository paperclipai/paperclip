//! Linux out-of-memory priority for Runner and the processes it supervises.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

const SCORE_RANGE: std::ops::RangeInclusive<i16> = -1000..=1000;

// Set only by the launch flag, so a launcher that does not opt in keeps today's
// inheritance even when Runner starts with a negative score.
static RELEASE_SUPERVISED_PROCESSES: AtomicBool = AtomicBool::new(false);

pub fn parse_oom_score_adj(value: &str) -> Option<i16> {
    value
        .parse()
        .ok()
        .filter(|score| SCORE_RANGE.contains(score))
}

/// Each environment decides how much Runner is worth protecting, so Runner has
/// no default. A negative value needs privilege or a floor set by the launcher;
/// callers treat a failure as non-fatal because it only leaves Runner killable.
pub fn set_own_oom_score_adj(score: i16) -> io::Result<()> {
    // The launcher opted in even if this write fails and Runner keeps its score.
    RELEASE_SUPERVISED_PROCESSES.store(true, Ordering::Relaxed);
    #[cfg(target_os = "linux")]
    {
        std::fs::write("/proc/self/oom_score_adj", score.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = score;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "oom_score_adj is supported only on Linux",
        ))
    }
}

/// Children inherit Runner's score. With the launch flag set, protection meant for
/// Runner must not make harness and tool processes as hard to kill as Runner.
///
/// A fork in the window after exec keeps Runner's score. So does the child if this
/// write fails, which leaves it no more protected than Runner, so it is not fatal.
pub(crate) fn release_supervised_process(pid: u32) {
    if !RELEASE_SUPERVISED_PROCESSES.load(Ordering::Relaxed) {
        return;
    }
    #[cfg(target_os = "linux")]
    if let Some(score) = std::fs::read_to_string("/proc/self/oom_score_adj")
        .ok()
        .and_then(|score| score.trim().parse().ok())
    {
        release_from_score(score, pid);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = pid;
}

#[cfg(target_os = "linux")]
fn release_from_score(own_score: i16, pid: u32) {
    if own_score < 0 {
        let _ = std::fs::write(format!("/proc/{pid}/oom_score_adj"), "0");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_kernel_range() {
        assert_eq!(parse_oom_score_adj("-1000"), Some(-1000));
        assert_eq!(parse_oom_score_adj("1000"), Some(1000));
        assert_eq!(parse_oom_score_adj("-1001"), None);
        assert_eq!(parse_oom_score_adj("1001"), None);
        assert_eq!(parse_oom_score_adj("low"), None);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn releases_children_only_from_a_protected_score() {
        struct Sleeper(std::process::Child);
        impl Drop for Sleeper {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let child = Sleeper(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        let path = format!("/proc/{pid}/oom_score_adj");
        let score = || std::fs::read_to_string(&path).unwrap().trim().to_owned();
        std::fs::write(&path, "7").unwrap();

        release_from_score(0, pid);
        assert_eq!(score(), "7");
        release_from_score(-1, pid);
        assert_eq!(score(), "0");
    }
}
