use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use paperclip_runner_core::durable::{
    Command, CommandDisposition, DurableRunnerConfig, DurableStateStore,
};
use serde_json::json;

fn config(state_dir: PathBuf) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1:3000/api/runner/v1/connect/run_1".to_owned(),
        state_dir,
        runner_instance_id: "runner_1".to_owned(),
        environment_lease_id: "environment_1".to_owned(),
        run_id: "run_1".to_owned(),
        normalized_session_id: "session_1".to_owned(),
        turn_id: "turn_1".to_owned(),
        item_id: "item_1".to_owned(),
        runner_version: "0.0.0".to_owned(),
        runner_digest: "sha256:test".to_owned(),
        max_outbox_bytes: 16_384,
        p0_reserve_bytes: 4096,
        max_frame_bytes: 65_536,
        reconnect_delay: Duration::from_millis(1),
        max_runtime: Duration::from_secs(1),
    }
}

fn command() -> Command {
    Command {
        schema: "paperclip.prp.command.v1".to_owned(),
        command_id: "command_1".to_owned(),
        controller_seq: 1,
        command_type: "session.open".to_owned(),
        issued_at: "2026-08-24T00:00:00.000Z".to_owned(),
        deadline_at: None,
        precondition: None,
        payload: json!({}),
    }
}

fn temporary_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must follow the Unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "paperclip-runner-public-recovery-{}-{nonce}",
        std::process::id()
    ))
}

#[test]
fn public_store_never_reexecutes_a_journaled_command_after_recovery() {
    let directory = temporary_directory();
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).expect("create private state store");
    let (mut state, existed) = store.load_or_create(&config).expect("create durable state");
    assert!(!existed);

    let command = command();
    assert_eq!(
        state.begin_command(&command).expect("journal command"),
        CommandDisposition::Execute
    );
    store
        .save(&state)
        .expect("persist command before its external effect");

    let (mut recovered, existed) = store
        .load_or_create(&config)
        .expect("recover durable state");
    assert!(existed);
    assert!(matches!(
        recovered
            .begin_command(&command)
            .expect("look up recovered command"),
        CommandDisposition::Replay(result)
            if result.status == "indeterminate"
                && result.result["code"] == "execution_indeterminate"
    ));

    fs::remove_dir_all(directory).expect("remove integration-test state");
}
