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
fn recovery_preserves_a_pristine_bridge_without_a_catalog() {
    let bridge = ProviderToolBridge::default();
    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();

    recovered
        .attach_existing_run()
        .expect("a pristine pre-catalog snapshot remains recoverable");
    assert_eq!(recovered, bridge);
}

#[test]
fn recovery_rejects_nonempty_state_without_a_catalog_digest() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    encoded["catalogDigest"] = serde_json::Value::Null;
    let mut recovered: ProviderToolBridge = serde_json::from_value(encoded).unwrap();

    let error = recovered
        .attach_existing_run()
        .expect_err("nonempty recovered state must remain bound to a catalog digest");
    assert!(error.to_string().contains("omit the catalog digest"));
}

#[test]
fn recovery_rejects_tampered_authorization_catalog_bindings() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let encoded = serde_json::to_value(&bridge).unwrap();

    let mut changed_contract = encoded.clone();
    changed_contract["authorized"]["get_task_context"]["inputSchema"] = json!({
        "type": "object",
        "properties": { "includeSecrets": { "type": "boolean" } }
    });
    let mut recovered: ProviderToolBridge = serde_json::from_value(changed_contract).unwrap();
    let error = recovered
        .attach_existing_run()
        .expect_err("recovery must recompute the catalog digest");
    assert!(error.to_string().contains("catalog digest"));

    let mut changed_map_key = encoded;
    let authorized = changed_map_key["authorized"].as_object_mut().unwrap();
    let tool = authorized.remove("get_task_context").unwrap();
    authorized.insert("delete_company".to_owned(), tool);
    let mut recovered: ProviderToolBridge = serde_json::from_value(changed_map_key).unwrap();
    let error = recovered
        .attach_existing_run()
        .expect_err("recovery must bind map keys to declared operation identities");
    assert!(error.to_string().contains("identities are inconsistent"));
}

#[test]
fn recovery_rejects_tampered_pending_call_contracts() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    let encoded = serde_json::to_value(&bridge).unwrap();

    let mut unauthorized = encoded.clone();
    unauthorized["pending"]["call-1"]["operationId"] = json!("delete_company");
    let mut recovered: ProviderToolBridge = serde_json::from_value(unauthorized).unwrap();
    assert!(recovered.attach_existing_run().is_err());

    let mut invalid_input = encoded;
    invalid_input["pending"]["call-1"]["input"] = json!(["not", "an", "object"]);
    let mut recovered: ProviderToolBridge = serde_json::from_value(invalid_input).unwrap();
    assert!(recovered.attach_existing_run().is_err());

    let mut oversized_input = serde_json::to_value(&bridge).unwrap();
    oversized_input["pending"]["call-1"]["input"] = json!({"value": "x".repeat(1024 * 1024)});
    let mut recovered: ProviderToolBridge = serde_json::from_value(oversized_input).unwrap();
    assert!(recovered.attach_existing_run().is_err());
}

#[test]
fn recovery_rejects_tampered_retained_result_contracts() {
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
    let completed = serde_json::to_value(&bridge).unwrap();

    let mut unauthorized = completed.clone();
    unauthorized["completed"]["call-1"]["operationId"] = json!("delete_company");
    let mut recovered: ProviderToolBridge = serde_json::from_value(unauthorized).unwrap();
    assert!(recovered.attach_existing_run().is_err());

    let mut invalid_output = completed;
    invalid_output["completed"]["call-1"]["result"] = json!(["not", "an", "object"]);
    let mut recovered: ProviderToolBridge = serde_json::from_value(invalid_output).unwrap();
    assert!(recovered.attach_existing_run().is_err());

    bridge.settle_turn().unwrap();
    let mut invalid_settled_output = serde_json::to_value(&bridge).unwrap();
    invalid_settled_output["settledResults"]["call-1"]["result"] = json!("invalid");
    let mut recovered: ProviderToolBridge = serde_json::from_value(invalid_settled_output).unwrap();
    assert!(recovered.attach_existing_run().is_err());
}

#[test]
fn recovery_preserves_a_reverse_ordered_authorization_catalog() {
    let mut tool_set = tools("computed");
    tool_set.operations.push(AuthorizedTool {
        operation_id: "answer_status_question".to_owned(),
        version: 1,
        description: "Answer a status question.".to_owned(),
        input_schema: json!({"type": "object"}),
        response_schema: json!({"type": "object"}),
    });
    assert!(tool_set.operations[0].operation_id > tool_set.operations[1].operation_id);
    tool_set.catalog_digest = authorized_tool_catalog_digest(&tool_set.operations).unwrap();

    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tool_set).unwrap();
    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();

    recovered
        .attach_existing_run()
        .expect("recovery must preserve a valid catalog regardless of projection order");
    assert_eq!(recovered.authorized_tools().count(), 2);
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

    let replay = ToolResult {
        call_id: "call-1".into(),
        operation_id: "get_task_context".into(),
        result: json!({"ok": true}),
        is_error: false,
    };
    assert_eq!(
        bridge.apply_result(replay.clone()).unwrap(),
        json!({"ok": true})
    );
    assert!(bridge
        .apply_result(ToolResult {
            result: json!({"ok": false}),
            ..replay
        })
        .is_err());

    assert!(bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
    bridge
        .begin_call("call-2".into(), "get_task_context".into(), json!({}))
        .unwrap();

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert_eq!(
        recovered
            .apply_result(ToolResult {
                call_id: "call-1".into(),
                operation_id: "get_task_context".into(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap(),
        json!({"ok": true})
    );
    assert!(recovered
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
}

#[test]
fn reserves_identity_capacity_before_accepting_a_call() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();

    let mut encoded = serde_json::to_value(&bridge).unwrap();
    encoded["settledCallIds"] = serde_json::Value::Array(
        (0..65_535)
            .map(|index| serde_json::Value::String(format!("settled-{index}")))
            .collect(),
    );
    let mut bridge: ProviderToolBridge = serde_json::from_value(encoded).unwrap();
    bridge.attach_existing_run().unwrap();

    bridge
        .begin_call("last-call".into(), "get_task_context".into(), json!({}))
        .unwrap();
    bridge
        .apply_result(ToolResult {
            call_id: "last-call".into(),
            operation_id: "get_task_context".into(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .unwrap();
    bridge.settle_turn().unwrap();

    assert!(bridge
        .begin_call("overflow".into(), "get_task_context".into(), json!({}))
        .is_err());
    assert!(bridge.settle_turn().is_ok());
}

#[test]
fn reserves_settled_result_bytes_before_accepting_a_call() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let large_result = json!({"value": "x".repeat(900 * 1024)});
    let mut completed = 0;

    for index in 0..20 {
        let call_id = format!("large-call-{index}");
        if bridge
            .begin_call(call_id.clone(), "get_task_context".into(), json!({}))
            .is_err()
        {
            break;
        }
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".into(),
                result: large_result.clone(),
                is_error: false,
            })
            .expect("an admitted call has reserved its maximum durable result");
        completed += 1;
    }

    assert!((2..20).contains(&completed));
    assert!(bridge
        .begin_call(
            "over-byte-limit".into(),
            "get_task_context".into(),
            json!({})
        )
        .is_err());
    bridge
        .settle_turn()
        .expect("settlement cannot strand results whose bytes were reserved at admission");
    assert_eq!(
        bridge
            .apply_result(ToolResult {
                call_id: "large-call-0".into(),
                operation_id: "get_task_context".into(),
                result: large_result,
                is_error: false,
            })
            .unwrap(),
        json!({"value": "x".repeat(900 * 1024)})
    );
}

#[test]
fn recovery_rejects_an_oversized_settled_result_envelope() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    let settled = encoded["settledResults"].as_object_mut().unwrap();
    for index in 0..10 {
        let call_id = format!("recovered-large-{index}");
        settled.insert(
            call_id.clone(),
            json!({
                "callId": call_id,
                "operationId": "get_task_context",
                "result": {"value": "x".repeat(900 * 1024)},
                "isError": false
            }),
        );
    }

    let error = serde_json::from_value::<ProviderToolBridge>(encoded)
        .expect_err("decoding must stop a settled result envelope above 8 MiB");
    assert!(error.to_string().contains("durable byte limit"));
}

#[test]
fn recovery_rejects_state_without_room_for_a_pending_result() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    let settled = encoded["settledResults"].as_object_mut().unwrap();
    for index in 0..8 {
        let call_id = format!("recovered-large-{index}");
        settled.insert(
            call_id.clone(),
            json!({
                "callId": call_id,
                "operationId": "get_task_context",
                "result": {"value": "x".repeat(900 * 1024)},
                "isError": false
            }),
        );
    }
    encoded["pending"]["pending-call"] = json!({
        "callId": "pending-call",
        "operationId": "get_task_context",
        "input": {}
    });

    let mut recovered: ProviderToolBridge = serde_json::from_value(encoded).unwrap();
    let error = recovered
        .attach_existing_run()
        .expect_err("recovery must reserve a maximum result for every pending call");
    assert!(error.to_string().contains("durable byte limit"));
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
