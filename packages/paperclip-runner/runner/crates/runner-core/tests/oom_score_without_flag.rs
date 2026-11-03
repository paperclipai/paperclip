#![cfg(target_os = "linux")]

use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use paperclip_runner_core::process_supervisor::SupervisedProcess;

// A separate test binary: the flag's process-wide opt-in must stay unset here.
// Runs under CAP_SYS_RESOURCE only, because lowering a score needs it.
#[test]
fn supervised_processes_keep_inheritance_without_the_flag() {
    if fs::write("/proc/self/oom_score_adj", "-1").is_err() {
        eprintln!("skipped: lowering oom_score_adj requires CAP_SYS_RESOURCE");
        return;
    }
    let directory = std::env::temp_dir().join(format!("runner-oom-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let result = directory.join("score");
    let mut process = SupervisedProcess::spawn(
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            format!(
                "read -r start; cat /proc/self/oom_score_adj > {}.tmp; mv {0}.tmp {0}; read -r finish",
                result.display()
            ),
        ],
        Duration::from_secs(2),
        1024,
    )
    .unwrap();
    // Read the score only after spawn returns, when a reset would have happened.
    process.send(&"start").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !result.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let score = fs::read_to_string(&result).unwrap();
    let _ = fs::write("/proc/self/oom_score_adj", "0");
    let _ = fs::remove_dir_all(&directory);
    assert_eq!(score.trim(), "-1");
}
