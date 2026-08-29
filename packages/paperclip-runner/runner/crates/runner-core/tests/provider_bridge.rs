use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ProviderToolBridge,
    ToolResult, TOOL_SET_SCHEMA,
};
use serde_json::json;

fn tools(digest: &str) -> AuthorizedToolSet {
    let mut tool_set = AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: digest.to_owned(),
        operations: vec![AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        }],
    };
    if digest == "computed" {
        tool_set.catalog_digest = authorized_tool_catalog_digest(&tool_set.operations).unwrap();
    }
    tool_set
}

fn digest(suffix: char) -> String {
    format!("sha256:{}", suffix.to_string().repeat(64))
}

#[test]
fn forwards_only_authorized_calls_and_correlates_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let call = bridge
        .begin_call(
            "call-1".to_owned(),
            "get_task_context".to_owned(),
            json!({}),
        )
        .unwrap();
    assert_eq!(call.operation_id, "get_task_context");
    let value = bridge
        .apply_result(ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .unwrap();
    assert_eq!(value, json!({"ok": true}));
    assert_eq!(bridge.pending_calls().count(), 0);
}

#[test]
fn rejects_unknown_tools_and_conflicting_duplicate_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    assert!(bridge
        .begin_call("call-x".to_owned(), "not_authorized".to_owned(), json!({}))
        .is_err());
    bridge
        .begin_call(
            "call-1".to_owned(),
            "get_task_context".to_owned(),
            json!({}),
        )
        .unwrap();
    let result = ToolResult {
        call_id: "call-1".to_owned(),
        operation_id: "get_task_context".to_owned(),
        result: json!({"ok": true}),
        is_error: false,
    };
    bridge.apply_result(result.clone()).unwrap();
    bridge.apply_result(result).unwrap();
    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "get_task_context".to_owned(),
            result: json!({"ok": false}),
            is_error: false,
        })
        .is_err());
}

#[test]
fn durable_session_refuses_catalog_drift() {
    let mut bridge = ProviderToolBridge::default();
    let first = tools("computed");
    bridge.prepare(first.clone()).unwrap();
    let mut changed = first.clone();
    changed.operations[0].description = "Changed without changing the supplied digest.".to_owned();
    assert!(bridge.prepare(changed).is_err());
    let mut changed = first;
    changed.operations[0].description = "Changed with a new digest.".to_owned();
    changed.catalog_digest = authorized_tool_catalog_digest(&changed.operations).unwrap();
    assert!(bridge.prepare(changed).is_err());
    let encoded = serde_json::to_string(&bridge).unwrap();
    let recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    assert_eq!(recovered, bridge);
}

#[test]
fn catalog_digest_matches_the_typescript_canonical_json_contract() {
    assert_eq!(
        authorized_tool_catalog_digest(&tools("computed").operations).unwrap(),
        "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009"
    );
}

#[test]
fn validates_the_operation_value_inside_a_semantic_dispatch_envelope() {
    let mut set = tools("sha256:catalog-a");
    set.operations[0].response_schema = json!({
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
    });
    let mut bridge = ProviderToolBridge::default();
    set.catalog_digest = digest('a');
    set.catalog_digest = authorized_tool_catalog_digest(&set.operations).unwrap();
    bridge.prepare(set).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({
                "ok": true,
                "operationId": "get_task_context",
                "callId": "call-1",
                "result": { "value": "accepted" },
                "stateRevision": 2
            }),
            is_error: false,
        })
        .unwrap();
    assert_eq!(bridge.pending_calls().count(), 0);
}

#[test]
fn rejects_noncanonical_digests_and_oversized_contract_values() {
    let mut bridge = ProviderToolBridge::default();
    assert!(bridge.prepare(tools("sha256:catalog-a")).is_err());

    let mut set = tools(&digest('a'));
    set.operations[0].description = "x".repeat(16 * 1024 + 1);
    assert!(bridge.prepare(set).is_err());

    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    assert!(bridge
        .begin_call(
            "call-large".into(),
            "get_task_context".into(),
            json!({ "value": "x".repeat(1024 * 1024) }),
        )
        .is_err());
}

#[test]
fn keeps_pending_calls_when_a_result_envelope_has_wrong_identity() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();

    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({
                "ok": false,
                "operationId": "get_task_context",
                "callId": "another-call",
                "error": { "message": "denied" }
            }),
            is_error: true,
        })
        .is_err());
    assert_eq!(bridge.pending_calls().count(), 1);
}

#[test]
fn recovery_preserves_completed_call_replay_identities() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .unwrap();

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
}

#[test]
fn recovery_preserves_pending_calls_for_the_existing_run() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();

    let pending = recovered.pending_calls().collect::<Vec<_>>();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].call_id, "call-1");
    assert!(recovered
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_ok());
}

#[test]
fn settles_completed_receipts_before_the_next_turn() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();

    for index in 0..4_096 {
        let call_id = format!("call-{index}");
        bridge
            .begin_call(call_id.clone(), "get_task_context".into(), json!({}))
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".into(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap();
    }

    assert!(bridge
        .begin_call("call-next".into(), "get_task_context".into(), json!({}))
        .is_err());
    bridge.settle_turn().unwrap();
    assert!(bridge
        .begin_call("call-next".into(), "get_task_context".into(), json!({}))
        .is_ok());
}

#[test]
fn settlement_preserves_call_ids_for_the_durable_run() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .unwrap();
    bridge.settle_turn().unwrap();

    assert!(bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
    bridge
        .begin_call("call-2".into(), "get_task_context".into(), json!({}))
        .unwrap();

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
}

#[test]
fn refuses_to_settle_receipts_while_calls_are_pending() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();

    assert!(bridge.settle_turn().is_err());
    assert_eq!(bridge.pending_calls().count(), 1);
}
