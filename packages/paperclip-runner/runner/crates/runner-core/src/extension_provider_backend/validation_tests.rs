use super::*;

fn launch_profile() -> ExtensionLaunchProfile {
    ExtensionLaunchProfile {
        schema: "paperclip.harness-launch.v1".to_owned(),
        identity: ExtensionReleaseIdentity {
            harness_id: "fixture.native".to_owned(),
            package_name: "@fixture/native-harness".to_owned(),
            version: "1.0.0".to_owned(),
            integrity: "sha512-Zml4dHVyZQ==".to_owned(),
            protocol_version: 1,
            runtime_digest: format!("sha256:{}", "a".repeat(64)),
        },
        command: ExtensionLaunchArtifact {
            path: std::env::temp_dir().join("fixture-runtime"),
            sha256: format!("sha256:{}", "b".repeat(64)),
        },
        entrypoint: None,
        args: Vec::new(),
        environment_keys: vec!["PROVIDER_API_KEY".to_owned()],
    }
}

#[test]
fn frames_require_supported_schema_and_bounded_json() {
    assert!(
        parse_frame(r#"{"schema":"paperclip.harness.v1","id":1,"ok":true,"result":{}}"#).is_ok()
    );
    assert!(
        parse_frame(r#"{"schema":"paperclip.harness.v999","id":1,"ok":true,"result":{}}"#).is_err()
    );
    assert!(parse_frame("{").is_err());
    assert!(parse_frame(&" ".repeat(MAX_FRAME_BYTES + 1)).is_err());

    let mut nested = json!({});
    for _ in 0..65 {
        nested = json!([nested]);
    }
    assert!(validate_json_bound(&nested, 0, &mut 0).is_err());
    assert!(validate_json_bound(&json!([0]), 0, &mut 65_535).is_err());
}

#[test]
fn launch_profile_cannot_grant_ambient_execution_authority() {
    let valid = launch_profile();
    valid.validate().unwrap();
    for key in [
        "NODE_OPTIONS",
        "NPM_CONFIG_PREFIX",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "PAPERCLIP_RUNNER_EXTENSION_PROFILE",
        "PATH",
        "HOME",
        "BASH_ENV",
        "ENV",
        "PYTHONPATH",
        "invalid_key",
    ] {
        let mut profile = valid.clone();
        profile.environment_keys = vec![key.to_owned()];
        assert!(profile.validate().is_err(), "accepted {key}");
    }
    let mut duplicate = valid.clone();
    duplicate
        .environment_keys
        .push("PROVIDER_API_KEY".to_owned());
    assert!(duplicate.validate().is_err());
    let mut absolute_argument = valid;
    absolute_argument.args = vec![std::env::temp_dir().to_string_lossy().into_owned()];
    assert!(absolute_argument.validate().is_err());
}

#[test]
fn launch_identity_rejects_unsupported_versions_digests_and_fields() {
    let valid = launch_profile();
    let mut incompatible = valid.clone();
    incompatible.identity.protocol_version = 2;
    assert!(incompatible.validate().is_err());
    let mut invalid_digest = valid.clone();
    invalid_digest.identity.runtime_digest = format!("sha256:{}", "A".repeat(64));
    assert!(invalid_digest.validate().is_err());
    let mut invalid_integrity = valid.clone();
    invalid_integrity.identity.integrity = "sha1-invalid".to_owned();
    assert!(invalid_integrity.validate().is_err());
    let mut unknown_field = serde_json::to_value(valid).unwrap();
    unknown_field["executableOverride"] = json!("untrusted-runtime");
    assert!(serde_json::from_value::<ExtensionLaunchProfile>(unknown_field).is_err());
}

#[test]
fn provider_event_inventory_preserves_runner_control_authority() {
    for event in ["item.delta", "turn.completed", "runtime_request.created"] {
        assert!(provider_event(event));
    }
    for event in [
        "runner.connected",
        "run.terminal",
        "run.result.accepted",
        "run.result.rejected",
        "run.attached",
        "harness.exited",
        "extension.unknown",
    ] {
        assert!(!provider_event(event), "accepted {event}");
    }
}
