use std::borrow::Cow;
use std::fs;
use std::path::PathBuf;

use paperclip_runner_core::codex_provider::{CodexProvider, CodexProviderConfig};
use paperclip_runner_core::task_memory::{
    instructions_with_memory_note, set_task_cgroup, TaskMemoryMonitor,
};

// A separate test binary: the flag's process-wide path starts unset here, and this
// one test owns the order of the before and after states.
#[test]
fn only_the_launch_flag_adds_the_note_and_the_monitor() {
    assert!(matches!(
        instructions_with_memory_note("Do the work.", 4096),
        Cow::Borrowed("Do the work.")
    ));
    assert!(TaskMemoryMonitor::new().is_none());

    let directory = std::env::temp_dir().join(format!("runner-memory-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let task_cgroup: PathBuf = directory.join("task-a");
    fs::create_dir(&task_cgroup).unwrap();
    fs::write(directory.join("memory.max"), "6442450944\n").unwrap();
    fs::write(task_cgroup.join("memory.events"), "oom_kill 0\n").unwrap();
    set_task_cgroup(task_cgroup);

    let instructions = instructions_with_memory_note("Do the work.", 4096);
    assert!(instructions.starts_with("Do the work.\n\nAll task processes"));
    assert!(instructions.contains("6 GiB"));
    assert!(TaskMemoryMonitor::new().is_some());

    let log = directory.join("requests.ndjson");
    let config = CodexProviderConfig {
        provider: "codex".to_owned(),
        driver: "codex_app_server".to_owned(),
        provider_version: "fake-1".to_owned(),
        command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
        args: vec![
            "--state-file".to_owned(),
            directory.join("state.json").display().to_string(),
            "--call-log".to_owned(),
            directory.join("calls.log").display().to_string(),
            "--request-log".to_owned(),
            log.display().to_string(),
        ],
        cwd: std::env::current_dir().unwrap().display().to_string(),
        model: Some("test-model".to_owned()),
        provider_session_id: None,
        instructions: "Do the work.".to_owned(),
        approval_policy: "never".to_owned(),
        externally_sandboxed: false,
        read_only: false,
        include_skill_instructions: None,
        conversation_mode: None,
    };
    let mut provider = CodexProvider::start(&config, None).unwrap();
    let thread_id = provider.thread_id().to_owned();
    provider.shutdown().unwrap();
    let mut resumed = CodexProvider::start(&config, Some(&thread_id)).unwrap();
    resumed.shutdown().unwrap();
    let requests = fs::read_to_string(&log).unwrap();
    for method in ["thread/start", "thread/resume"] {
        let request: serde_json::Value = requests
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|request| request["method"] == method)
            .unwrap();
        assert_eq!(
            request["params"]["developerInstructions"].as_str().unwrap(),
            instructions.as_ref(),
            "{method}"
        );
    }
    fs::remove_dir_all(directory).unwrap();
}
