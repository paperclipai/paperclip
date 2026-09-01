use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use paperclip_runner_core::durable::{
    Command, CommandDisposition, DurableRunnerConfig, DurableStateStore,
};
use serde_json::json;

static NEXT_TEMPORARY_DIRECTORY: AtomicU64 = AtomicU64::new(0);

fn config(state_dir: PathBuf) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1:3000/api/runner/v1/connect/run_1".to_owned(),
        ca_bundle_path: None,
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
        reconnect_grace: None,
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
    let sequence = NEXT_TEMPORARY_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "paperclip-runner-public-recovery-{}-{nonce}-{sequence}",
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

#[test]
fn duplicate_replay_requires_the_complete_command_identity() {
    let directory = temporary_directory();
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).expect("create private state store");
    let (mut state, _) = store.load_or_create(&config).expect("create durable state");
    let original = command();

    assert_eq!(
        state.begin_command(&original).expect("journal command"),
        CommandDisposition::Execute
    );
    state
        .complete_command(&original, json!({"ok": true}))
        .expect("complete command");

    let mut changed_payload = original.clone();
    changed_payload.payload = json!({"changed": true});
    let mut changed_precondition = original.clone();
    changed_precondition.precondition = Some(json!({"ifMatch": "different"}));
    let mut changed_issued_at = original.clone();
    changed_issued_at.issued_at = "2026-08-24T00:00:01.000Z".to_owned();
    let mut changed_deadline = original.clone();
    changed_deadline.deadline_at = Some("2026-08-24T00:01:00.000Z".to_owned());
    let mut changed_type = original.clone();
    changed_type.command_type = "session.close".to_owned();
    let mut changed_sequence = original.clone();
    changed_sequence.controller_seq = 2;

    for conflicting in [
        changed_payload,
        changed_precondition,
        changed_issued_at,
        changed_deadline,
        changed_type,
        changed_sequence,
    ] {
        let error = state
            .begin_command(&conflicting)
            .expect_err("changed duplicate must fail closed");
        assert!(error
            .to_string()
            .contains("commandId was reused with different command data"));
    }
    assert!(matches!(
        state.begin_command(&original).expect("replay exact command"),
        CommandDisposition::Replay(result) if result.result == json!({"ok": true})
    ));

    fs::remove_dir_all(directory).expect("remove integration-test state");
}

#[test]
fn pre_fingerprint_journal_recovers_without_reexecuting_old_commands() {
    let directory = temporary_directory();
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).expect("create private state store");
    let (mut state, _) = store.load_or_create(&config).expect("create durable state");
    let command = command();
    assert_eq!(
        state.begin_command(&command).expect("journal command"),
        CommandDisposition::Execute
    );
    store.save(&state).expect("persist pending command");

    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(store.path()).expect("read current durable state"))
            .expect("parse current durable state");
    legacy
        .as_object_mut()
        .expect("durable state must be an object")
        .remove("processedCommandFingerprints");
    fs::write(
        store.path(),
        serde_json::to_vec_pretty(&legacy).expect("serialize legacy state"),
    )
    .expect("write simulated pre-fingerprint state");

    let (mut recovered, existed) = store
        .load_or_create(&config)
        .expect("migrate pre-fingerprint state");
    assert!(existed);
    assert!(recovered.processed_commands.is_empty());
    assert!(recovered.processed_command_fingerprints.is_empty());
    assert_eq!(recovered.compacted_through_controller_seq, 1);
    assert!(matches!(
        recovered
            .begin_command(&command)
            .expect("reject migrated command without reexecution"),
        CommandDisposition::Reject(result)
            if result.result["code"] == "command_history_compacted"
    ));

    fs::remove_dir_all(directory).expect("remove integration-test state");
}
