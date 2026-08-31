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
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet,
};
use serde_json::json;

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
    assert_eq!(recovered.admit_recovery(&config).unwrap(), identity());

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
fn admits_recovery_only_for_the_exact_run_catalog_and_provider_identity() {
    let directory = temporary_directory("recovery-admission");
    let config = config(&directory);
    let checkpoint = AcpxSuspensionCheckpoint::from_suspension(&config, identity()).unwrap();

    let mut changed_run = config.clone();
    changed_run.run_id = "run-2".to_owned();
    let mut changed_session = config.clone();
    changed_session.normalized_session_id = "session-2".to_owned();
    let mut changed_revision = config.clone();
    changed_revision.catalog_revision += 1;
    let mut changed_catalog = config.clone();
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read one issue".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    changed_catalog.tool_set = AuthorizedToolSet {
        schema: "paperclip.runner.authorized-tools.v1".to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    };
    let mut changed_model = config.clone();
    changed_model.agent = "claude".to_owned();
    changed_model.model = "claude-sonnet-5".to_owned();
    let mut changed_permission = config.clone();
    changed_permission.permission_mode = AcpxPermissionMode::ApproveAll;
    let mut changed_expected_identity = config.clone();
    let mut expected = identity();
    expected.backend_session_id = "backend-session-2".to_owned();
    changed_expected_identity.expected_identity = Some(expected);

    for (label, changed) in [
        ("run", changed_run),
        ("session", changed_session),
        ("revision", changed_revision),
        ("catalog", changed_catalog),
        ("model", changed_model),
        ("permission", changed_permission),
        ("expected identity", changed_expected_identity),
    ] {
        let error = checkpoint.admit_recovery(&changed).unwrap_err().to_string();
        assert!(error.contains("conflict"), "{label}: {error}");
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

    let valid: serde_json::Value =
        serde_json::from_slice(&fs::read(store.path()).unwrap()).unwrap();
    let mut top_level_unknown = valid.clone();
    top_level_unknown["unexpected"] = json!(true);
    let mut nested_unknown = valid.clone();
    nested_unknown["identity"]["unexpected"] = json!(true);
    let mut missing_permission = valid.clone();
    missing_permission["identity"]
        .as_object_mut()
        .unwrap()
        .remove("permissionMode");
    let mut invalid_run = valid.clone();
    invalid_run["runId"] = json!("run 1");
    let mut invalid_session = valid;
    invalid_session["normalizedSessionId"] = json!("séssion-1");

    for malformed in [
        top_level_unknown,
        nested_unknown,
        missing_permission,
        invalid_run,
        invalid_session,
    ] {
        fs::write(store.path(), serde_json::to_vec(&malformed).unwrap()).unwrap();
        assert!(store.load().is_err());
    }

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
