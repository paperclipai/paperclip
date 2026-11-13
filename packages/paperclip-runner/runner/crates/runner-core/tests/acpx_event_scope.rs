use paperclip_runner_core::acpx_event_scope::AcpxEventScope;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use serde_json::json;

fn event(
    event_type: GeneratedAcpxSidecarEventType,
    run_id: Option<&str>,
    turn_id: Option<&str>,
) -> AcpxSidecarEvent {
    AcpxSidecarEvent {
        sequence: 1,
        event_type,
        run_id: run_id.map(str::to_owned),
        turn_id: turn_id.map(str::to_owned),
        payload: json!({}),
    }
}

#[test]
fn admits_every_turn_scoped_event_only_for_the_active_run_and_turn() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    for event_type in [
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        GeneratedAcpxSidecarEventType::RuntimePermissionRequested,
        GeneratedAcpxSidecarEventType::RuntimeInputRequested,
        GeneratedAcpxSidecarEventType::RuntimeToolCalled,
        GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
    ] {
        scope
            .validate_event(&event(event_type, Some("run-1"), Some("turn-1")))
            .unwrap();
    }
}

#[test]
fn rejects_missing_and_cross_run_turn_bindings() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    for (run_id, turn_id, message) in [
        (None, Some("turn-1"), "omitted its run binding"),
        (Some("run-2"), Some("turn-1"), "stale run"),
        (Some("run-1"), None, "omitted its turn binding"),
        (Some("run-1"), Some("turn-2"), "stale turn"),
    ] {
        let error = scope
            .validate_event(&event(
                GeneratedAcpxSidecarEventType::RuntimeToolCalled,
                run_id,
                turn_id,
            ))
            .unwrap_err();
        assert!(error.to_string().contains(message), "{error}");
    }

    scope.clear_turn("turn-1").unwrap();
    let error = scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeToolCalled,
            Some("run-1"),
            Some("turn-1"),
        ))
        .unwrap_err();
    assert!(error.to_string().contains("requires an active turn"));
}

#[test]
fn admits_unbound_process_and_diagnostic_events() {
    let scope = AcpxEventScope::new("run-1").unwrap();
    for event_type in [
        GeneratedAcpxSidecarEventType::RuntimeProcess,
        GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
    ] {
        scope
            .validate_event(&event(event_type, None, None))
            .unwrap();
        scope
            .validate_event(&event(event_type, Some("run-1"), None))
            .unwrap();
    }
}

#[test]
fn validates_optional_scope_on_process_and_diagnostic_events() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    let wrong_run = scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeProcess,
            Some("run-2"),
            None,
        ))
        .unwrap_err();
    assert!(wrong_run.to_string().contains("stale run"));

    let missing_run = scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
            None,
            Some("turn-1"),
        ))
        .unwrap_err();
    assert!(missing_run.to_string().contains("without a run binding"));

    let wrong_turn = scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
            Some("run-1"),
            Some("turn-2"),
        ))
        .unwrap_err();
    assert!(wrong_turn.to_string().contains("stale turn"));

    scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeProcess,
            Some("run-1"),
            Some("turn-1"),
        ))
        .unwrap();
}

#[test]
fn binds_and_clears_one_turn_idempotently() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    assert_eq!(scope.active_turn_id(), Some("turn-1"));
    assert!(scope.bind_turn("turn-2").is_err());
    scope.clear_turn("turn-1").unwrap();
    assert_eq!(scope.active_turn_id(), None);
    assert!(scope.clear_turn("turn-1").is_err());
    let reused = scope.bind_turn("turn-1").unwrap_err();
    assert!(reused.to_string().contains("reused a settled turn"));
}

#[test]
fn rejects_late_events_after_rotating_to_a_distinct_turn_identity() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    scope.clear_turn("turn-1").unwrap();
    scope.bind_turn("turn-2").unwrap();

    let late = scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeToolCalled,
            Some("run-1"),
            Some("turn-1"),
        ))
        .unwrap_err();
    assert!(late.to_string().contains("stale turn"), "{late}");
}

#[test]
fn bounds_settled_turn_identity_retention() {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    for index in 0..4_096 {
        let turn_id = format!("turn-{index}");
        scope.bind_turn(&turn_id).unwrap();
        scope.clear_turn(&turn_id).unwrap();
    }

    let exhausted = scope.bind_turn("turn-overflow").unwrap_err();
    assert!(
        exhausted
            .to_string()
            .contains("exhausted its settled turn identity capacity"),
        "{exhausted}"
    );
}

#[test]
fn rejects_invalid_scope_identifiers() {
    assert!(AcpxEventScope::new("").is_err());
    assert!(AcpxEventScope::new("run\n1").is_err());
    assert!(AcpxEventScope::new("run 1").is_err());
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    let longest_turn_id = "t".repeat(240);
    scope.bind_turn(&longest_turn_id).unwrap();
    scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
            Some("run-1"),
            Some(&longest_turn_id),
        ))
        .unwrap();
    scope.clear_turn(&longest_turn_id).unwrap();
    assert!(scope.bind_turn("t".repeat(241)).is_err());
    assert!(scope.bind_turn("turn 1").is_err());
    let oversized_run_id = "r".repeat(161);
    assert!(scope
        .validate_event(&event(
            GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
            Some(&oversized_run_id),
            None,
        ))
        .is_err());
}
