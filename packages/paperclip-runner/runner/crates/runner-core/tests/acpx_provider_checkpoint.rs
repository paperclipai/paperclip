use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use paperclip_runner_core::acpx_provider_checkpoint::{
    AcpxSuspensionCheckpoint, AcpxSuspensionCheckpointStore,
};
use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSessionConfig, AcpxProviderSessionIdentity,
};
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{authorized_tool_catalog_digest, AuthorizedToolSet};

fn temporary_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "paperclip-acpx-checkpoint-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn config(directory: &std::path::Path) -> AcpxProviderSessionConfig {
    let operations = Vec::new();
    AcpxProviderSessionConfig {
        transport: AcpxSidecarTransportConfig {
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
            args: vec!["--mode".to_owned(), "suspend".to_owned()],
            request_timeout: Duration::from_secs(1),
            shutdown_grace: Duration::from_millis(100),
        },
        agent: "codex".to_owned(),
        model: "gpt-5.6-sol".to_owned(),
        run_id: "run-1".to_owned(),
        catalog_revision: 7,
        runtime_directory: directory.to_owned(),
        normalized_session_id: "session-1".to_owned(),
        working_directory: directory.to_owned(),
        permission_mode: AcpxPermissionMode::ApproveReads,
        permission_mode_pinned: true,
        system_instructions: "Complete the supplied task.".to_owned(),
        tool_set: AuthorizedToolSet {
            schema: "paperclip.runner.authorized-tools.v1".to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        },
        expected_identity: None,
    }
}

fn identity() -> AcpxProviderSessionIdentity {
    AcpxProviderSessionIdentity {
        kind: "acpx".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        acpx_record_id: "acpx-record-1".to_owned(),
        backend_session_id: "backend-session-1".to_owned(),
        agent_session_id: "agent-session-1".to_owned(),
        profile_digest: format!("sha256:{}", "a".repeat(64)),
        workspace_digest: format!("sha256:{}", "b".repeat(64)),
        requested_model: "gpt-5.6-sol".to_owned(),
        effective_model: "gpt-5.6-sol".to_owned(),
        permission_mode: Some(AcpxPermissionMode::ApproveReads),
    }
}

#[test]
fn round_trips_an_exact_private_suspension_checkpoint_idempotently() {
    let directory = temporary_directory("round-trip");
    let config = config(&directory);
    let checkpoint = AcpxSuspensionCheckpoint::from_suspension(&config, identity()).unwrap();
    let store = AcpxSuspensionCheckpointStore::new(&directory).unwrap();

    assert_eq!(store.load().unwrap(), None);
    store.save(&checkpoint).unwrap();
    store.save(&checkpoint).unwrap();
    let recovered = store.load().unwrap().unwrap();
    assert_eq!(recovered, checkpoint);
    assert_eq!(recovered.expected_identity(), identity());

    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(store.path()).unwrap().permissions().mode() & 0o077,
            0
        );
        assert_eq!(
            fs::metadata(store.path().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_identity_drift_before_a_checkpoint_is_created() {
    let directory = temporary_directory("identity-drift");
    let config = config(&directory);
    let mut mismatched = identity();
    mismatched.effective_model = "other-model".to_owned();
    let error = AcpxSuspensionCheckpoint::from_suspension(&config, mismatched)
        .unwrap_err()
        .to_string();
    assert!(error.contains("conflicts"), "{error}");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn fails_closed_on_unknown_or_oversized_checkpoint_files() {
    let directory = temporary_directory("malformed");
    let config = config(&directory);
    let checkpoint = AcpxSuspensionCheckpoint::from_suspension(&config, identity()).unwrap();
    let store = AcpxSuspensionCheckpointStore::new(&directory).unwrap();
    store.save(&checkpoint).unwrap();

    let mut malformed: serde_json::Value =
        serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
    malformed["unexpected"] = serde_json::json!(true);
    fs::write(store.path(), serde_json::to_vec(&malformed).unwrap()).unwrap();
    assert!(store.load().unwrap_err().to_string().contains("malformed"));

    fs::write(store.path(), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(store.load().unwrap_err().to_string().contains("1 MiB"));
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_a_symlinked_runner_state_directory() {
    use std::os::unix::fs::symlink;

    let directory = temporary_directory("symlink");
    let actual = directory.join("actual");
    fs::create_dir(&actual).unwrap();
    let linked = directory.join("linked");
    symlink(&actual, &linked).unwrap();
    let error = AcpxSuspensionCheckpointStore::new(&linked)
        .unwrap_err()
        .to_string();
    assert!(error.contains("must not be a symlink"), "{error}");
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_an_existing_runner_state_directory_that_is_not_private() {
    let directory = temporary_directory("public-state");
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();

    let error = AcpxSuspensionCheckpointStore::new(&directory)
        .unwrap_err()
        .to_string();

    assert!(error.contains("not private"), "{error}");
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o077,
        0o055
    );
    fs::remove_dir_all(directory).unwrap();
}
