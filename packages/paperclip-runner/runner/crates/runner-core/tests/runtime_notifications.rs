#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::{DurableRunnerConfig, DurableStateStore};
use paperclip_runner_core::runtime_notifications::{
    context_path, RuntimeNotifications, CONTEXT_ENV, HELPER_ENV,
};

fn helper(config: &DurableRunnerConfig, args: &[&str]) -> Output {
    Command::new(std::env::var_os(HELPER_ENV).expect("Runner publishes its matching helper"))
        .env("PATH", "/usr/bin:/bin")
        .env(
            CONTEXT_ENV,
            fs::canonicalize(context_path(&config.state_dir)).unwrap(),
        )
        .env("PAPERCLIP_RUN_ID", "stale-process-run")
        .current_dir(std::env::temp_dir())
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap()
}

#[test]
fn real_cli_uses_relative_state_from_another_directory_and_never_process_run_identity() {
    let path = std::env::current_dir()
        .unwrap()
        .join(format!("notification-cli-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".into(),
        ca_bundle_path: None,
        state_dir: PathBuf::from(path.file_name().unwrap()),
        runner_instance_id: "runner".into(),
        environment_lease_id: "lease".into(),
        run_id: "active-run".into(),
        normalized_session_id: "session".into(),
        turn_id: "turn".into(),
        item_id: "item".into(),
        runner_version: "1".into(),
        runner_digest: "sha256:digest".into(),
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 65536,
        max_frame_bytes: 65536,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::ZERO,
    };
    let store = DurableStateStore::new(&path).unwrap();
    let (mut state, _) = store.load_or_create(&config).unwrap();
    state.lifecycle = "ready".into();
    let mut server = RuntimeNotifications::bind(&config.state_dir).unwrap();
    server.poll(&config, &mut state, &store);
    std::env::set_var(CONTEXT_ENV, fs::canonicalize(context_path(&path)).unwrap());
    std::env::set_var(HELPER_ENV, env!("CARGO_BIN_EXE_paperclip-runnerd"));
    let mut provider = paperclip_runner_core::process_supervisor::SupervisedProcess::spawn(
        std::path::Path::new("/bin/sh"),
        &[
            "-c".into(),
            "printf '%s\\n' \"$PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT\" \"$PAPERCLIP_RUNTIME_NOTIFICATION_HELPER\"".into(),
        ],
        Duration::from_millis(100),
        2048,
    )
    .unwrap();
    assert_eq!(
        provider
            .receive_stdout_line(Duration::from_secs(1))
            .unwrap(),
        Some(
            fs::canonicalize(context_path(&path))
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    assert_eq!(
        provider
            .receive_stdout_line(Duration::from_secs(1))
            .unwrap(),
        Some(env!("CARGO_BIN_EXE_paperclip-runnerd").to_owned())
    );
    provider.wait().unwrap();
    let captured = helper(&config, &["notification-context"]);
    assert!(captured.status.success(), "{:?}", captured);
    let context = String::from_utf8(captured.stdout).unwrap();
    let args = [
        "record-activity",
        context.trim(),
        "example.runtime",
        "desktop.used",
    ];
    let activated = helper(&config, &args);
    assert!(activated.status.success(), "{:?}", activated);
    assert!(activated.stdout.is_empty());
    assert!(activated.stderr.is_empty());
    let deadline = Instant::now() + Duration::from_secs(2);
    while state.outbox.is_empty() && Instant::now() < deadline {
        server.poll(&config, &mut state, &store);
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(state.outbox[0].envelope["payload"]["runId"], "active-run");
    config.run_id = "next-run".into();
    state.run_id.clone_from(&config.run_id);
    server.poll(&config, &mut state, &store);
    let stale = helper(&config, &args);
    assert!(!stale.status.success());
    assert_eq!(state.outbox.len(), 1);
    std::env::remove_var(CONTEXT_ENV);
    std::env::remove_var(HELPER_ENV);
    drop(server);
    fs::remove_dir_all(path).unwrap();
}
