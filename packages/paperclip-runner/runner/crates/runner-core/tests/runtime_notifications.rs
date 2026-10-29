#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::{DurableRunnerConfig, DurableState, DurableStateStore};
use paperclip_runner_core::runtime_notifications::{
    context_path, RuntimeNotifications, CONTEXT_ENV, HELPER_ENV,
};

fn helper(
    server: &mut RuntimeNotifications,
    config: &DurableRunnerConfig,
    state: &mut DurableState,
    store: &DurableStateStore,
    args: &[&str],
) -> Output {
    let child =
        Command::new(std::env::var_os(HELPER_ENV).expect("Runner publishes its matching helper"))
            .env("PATH", "/usr/bin:/bin")
            .env(CONTEXT_ENV, context_path(&config.state_dir))
            .env("PAPERCLIP_RUN_ID", "stale-process-run")
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
    let client = thread::spawn(move || child.wait_with_output().unwrap());
    let deadline = Instant::now() + Duration::from_secs(3);
    while !client.is_finished() && Instant::now() < deadline {
        server.poll(config, state, store);
        thread::sleep(Duration::from_millis(1));
    }
    client.join().unwrap()
}

#[test]
fn real_cli_uses_runner_context_and_never_process_run_identity() {
    let path = std::env::temp_dir().join(format!("notification-cli-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".into(),
        ca_bundle_path: None,
        state_dir: path.clone(),
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
    let mut server = RuntimeNotifications::bind(&path).unwrap();
    std::env::set_var(CONTEXT_ENV, context_path(&path));
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
        Some(context_path(&path).to_string_lossy().into_owned())
    );
    assert_eq!(
        provider
            .receive_stdout_line(Duration::from_secs(1))
            .unwrap(),
        Some(env!("CARGO_BIN_EXE_paperclip-runnerd").to_owned())
    );
    provider.wait().unwrap();
    let captured = helper(
        &mut server,
        &config,
        &mut state,
        &store,
        &["notification-context"],
    );
    assert!(captured.status.success(), "{:?}", captured);
    let context = String::from_utf8(captured.stdout).unwrap();
    let args = [
        "record-activity",
        context.trim(),
        "example.runtime",
        "desktop.used",
    ];
    let activated = helper(&mut server, &config, &mut state, &store, &args);
    assert!(activated.status.success(), "{:?}", activated);
    assert!(activated.stdout.is_empty());
    assert!(activated.stderr.is_empty());
    assert_eq!(state.outbox[0].envelope["payload"]["runId"], "active-run");
    config.run_id = "next-run".into();
    state.run_id.clone_from(&config.run_id);
    let stale = helper(&mut server, &config, &mut state, &store, &args);
    assert!(!stale.status.success());
    assert_eq!(state.outbox.len(), 1);
    std::env::remove_var(CONTEXT_ENV);
    std::env::remove_var(HELPER_ENV);
    drop(server);
    fs::remove_dir_all(path).unwrap();
}
