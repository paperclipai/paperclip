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
        .replay_result("call-1", "get_task_context", &json!({}))
        .unwrap()
        .is_some());
    assert!(bridge
        .replay_result("call-1", "get_task_context", &json!({"changed": true}))
        .is_err());
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
fn catalog_digest_normalizes_json_numbers_like_javascript() {
    let operation = AuthorizedTool {
        operation_id: "get_task_context".into(),
        version: 1,
        description: "Read the active task context.".into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "limit": { "type": "number", "default": 1.0 },
                "epsilon": { "type": "number", "default": 1e-6 },
            },
        }),
        response_schema: json!({ "type": "object" }),
    };
    let digest = authorized_tool_catalog_digest(&[operation]).unwrap();

    assert_eq!(
        digest,
        "sha256:1c93693d9b5b48b46c83cd1c11d1ea329774f1b9b0ae741197cb2b8e992c4b8d"
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
    bridge.prepare(set.clone()).unwrap();
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

    let mut second = ProviderToolBridge::default();
    second.prepare(set).unwrap();
    second
        .begin_call("call-2".into(), "get_task_context".into(), json!({}))
        .unwrap();
    second
        .apply_result(ToolResult {
            call_id: "call-2".into(),
            operation_id: "get_task_context".into(),
            result: json!({
                "ok": true,
                "operationId": "get_task_context",
                "callId": "call-2",
                "value": { "value": "accepted" }
            }),
            is_error: false,
        })
        .unwrap();
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

    let retained = json!({"value": "x".repeat(700 * 1024)});
    for index in 0..5 {
        bridge
            .begin_call(
                format!("call-{index}"),
                "get_task_context".into(),
                retained.clone(),
            )
            .unwrap();
    }
    assert!(bridge
        .begin_call(
            "call-over-aggregate-limit".into(),
            "get_task_context".into(),
            retained,
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
    recovered.validate_recovered().unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
}

#[test]
fn recovered_bridge_rejects_tampered_authorization_state() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    encoded["authorized"]["get_task_context"]["description"] = json!("Tampered");
    let recovered: ProviderToolBridge = serde_json::from_value(encoded).unwrap();
    assert!(recovered.validate_recovered().is_err());
}

#[test]
fn cancellation_completes_pending_calls_and_rejects_late_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();
    let cancelled = bridge
        .cancel_pending_calls("provider_turn_stopped")
        .unwrap();
    assert_eq!(cancelled.len(), 1);
    assert!(cancelled[0].is_error);
    assert_eq!(bridge.pending_calls().count(), 0);
    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-1".into(),
            operation_id: "get_task_context".into(),
            result: json!({"ok": true}),
            is_error: false,
        })
        .is_err());
}

#[test]
fn turn_settlement_releases_value_capacity_without_reusing_call_ids() {
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

    assert!(bridge
        .settle_turn("provider_turn_terminated")
        .unwrap()
        .is_empty());
    assert!(bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .is_err());
    bridge
        .begin_call("call-2".into(), "get_task_context".into(), json!({}))
        .expect("a new turn can use a fresh call id after releasing exact values");
}

#[test]
fn completed_receipts_are_exact_until_the_controlled_turn_limit() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    for index in 0..4_096 {
        let call_id = format!("call-{index}");
        bridge
            .begin_call(call_id.clone(), "get_task_context".into(), json!({}))
            .expect("a completed call must release concurrent capacity");
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".into(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap();
    }

    let error = bridge
        .begin_call(
            "call-after-limit".into(),
            "get_task_context".into(),
            json!({}),
        )
        .expect_err("the bounded exact receipt ledger must stop the active turn");
    assert!(error.is_active_turn_receipt_limit());
    assert!(bridge
        .replay_result("call-0", "get_task_context", &json!({}))
        .unwrap()
        .is_some());
    assert!(bridge
        .replay_result("call-4095", "get_task_context", &json!({}))
        .unwrap()
        .is_some());

    let recovered: ProviderToolBridge =
        serde_json::from_str(&serde_json::to_string(&bridge).unwrap()).unwrap();
    recovered.validate_recovered().unwrap();
}

#[test]
fn turn_settlement_cannot_be_blocked_by_completed_value_pressure() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let large = json!({"value": "x".repeat(700 * 1024)});
    for index in 0..5 {
        bridge
            .begin_call(
                format!("call-{index}"),
                "get_task_context".into(),
                large.clone(),
            )
            .unwrap();
    }
    for index in 0..4 {
        bridge
            .apply_result(ToolResult {
                call_id: format!("call-{index}"),
                operation_id: "get_task_context".into(),
                result: large.clone(),
                is_error: false,
            })
            .unwrap();
    }

    let settled = bridge.settle_turn("provider_turn_terminated").unwrap();
    assert_eq!(settled.len(), 1);
    assert!(settled[0].is_error);
    assert!(bridge
        .begin_call("call-0".into(), "get_task_context".into(), json!({}))
        .is_err());
    bridge
        .begin_call(
            "call-after-settlement".into(),
            "get_task_context".into(),
            json!({}),
        )
        .expect("settlement releases prior turn value retention");
}

#[test]
fn recovered_turn_preserves_exact_results_at_the_value_boundary() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let large = json!({"value": "x".repeat(700 * 1024)});
    for index in 0..5 {
        bridge
            .begin_call(
                format!("call-{index}"),
                "get_task_context".into(),
                large.clone(),
            )
            .unwrap();
    }
    for index in 0..5 {
        bridge
            .apply_result(ToolResult {
                call_id: format!("call-{index}"),
                operation_id: "get_task_context".into(),
                result: large.clone(),
                is_error: false,
            })
            .unwrap();
    }

    let error = bridge
        .begin_call("call-next".into(), "get_task_context".into(), large.clone())
        .expect_err("exact replay values must not be discarded for later work");
    assert!(error.is_active_turn_receipt_limit());
    assert_eq!(
        bridge
            .replay_result("call-0", "get_task_context", &large)
            .unwrap()
            .unwrap()
            .result,
        large,
    );
    bridge
        .apply_result(ToolResult {
            call_id: "call-0".into(),
            operation_id: "get_task_context".into(),
            result: large.clone(),
            is_error: false,
        })
        .expect("a matching exact result receipt remains idempotent");
    assert!(bridge
        .apply_result(ToolResult {
            call_id: "call-0".into(),
            operation_id: "get_task_context".into(),
            result: json!({"value": "changed"}),
            is_error: false,
        })
        .is_err());

    let recovered: ProviderToolBridge =
        serde_json::from_str(&serde_json::to_string(&bridge).unwrap()).unwrap();
    recovered.validate_recovered().unwrap();
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
    assert!(error.to_string().contains("omitted its catalog identity"));
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
        .expect_err("recovery must reconstruct the authorized catalog projection");
    assert!(error.to_string().contains("changed its authorized catalog"));

    let mut changed_map_key = encoded;
    let authorized = changed_map_key["authorized"].as_object_mut().unwrap();
    let tool = authorized.remove("get_task_context").unwrap();
    authorized.insert("delete_company".to_owned(), tool);
    let mut recovered: ProviderToolBridge = serde_json::from_value(changed_map_key).unwrap();
    let error = recovered
        .attach_existing_run()
        .expect_err("recovery must bind map keys to declared operation identities");
    assert!(error.to_string().contains("changed its authorized catalog"));
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
    unauthorized["completed"]["call-1"]["result"]["operationId"] = json!("delete_company");
    let error = serde_json::from_value::<ProviderToolBridge>(unauthorized)
        .expect_err("durable decoding must reject mismatched call and result identities");
    assert!(error
        .to_string()
        .contains("retained provider tool receipt identity is inconsistent"));

    let mut invalid_output = completed;
    invalid_output["completed"]["call-1"]["result"]["result"] = json!(["not", "an", "object"]);
    let mut recovered: ProviderToolBridge = serde_json::from_value(invalid_output).unwrap();
    assert!(recovered.attach_existing_run().is_err());

    bridge.settle_turn("provider_turn_terminated").unwrap();
    let mut invalid_settled_output = serde_json::to_value(&bridge).unwrap();
    invalid_settled_output["settledResults"]["call-1"]["result"]["result"] = json!("invalid");
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
    bridge.settle_turn("provider_turn_terminated").unwrap();
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
    bridge.settle_turn("provider_turn_terminated").unwrap();

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
fn exact_identity_overflow_saturates_the_durable_run() {
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

    let overflow = bridge
        .begin_call("overflow".into(), "get_task_context".into(), json!({}))
        .expect_err("the pending call reserves the final exact identity slot");
    assert!(overflow.is_active_turn_receipt_limit());

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered.durable_run_receipt_limit_reached());
    recovered
        .settle_turn("provider_turn_terminated")
        .expect("the controlled turn stop retains replay protection");
    assert!(recovered.durable_run_receipt_limit_reached());
    assert!(recovered.has_completed_call("settled-0"));
    assert!(recovered.has_completed_call("last-call"));
    let stopped_turn_receipt = recovered
        .replay_result("last-call", "get_task_context", &json!({}))
        .unwrap()
        .expect("the call admitted before exhaustion retains an exact terminal receipt");
    assert!(stopped_turn_receipt.is_error);
    assert_eq!(
        stopped_turn_receipt.result["error"]["code"],
        "provider_turn_terminated"
    );
    assert!(recovered
        .begin_call("settled-0".into(), "get_task_context".into(), json!({}))
        .is_err());
    assert!(recovered
        .begin_call("overflow".into(), "get_task_context".into(), json!({}))
        .is_err());
    recovered.prepare_turn().unwrap();
    assert!(recovered
        .replay_result("last-call", "get_task_context", &json!({}))
        .unwrap()
        .is_none());
    assert!(recovered.has_completed_call("last-call"));
    assert!(recovered.has_completed_call("settled-0"));
    assert!(recovered.durable_run_receipt_limit_reached());
    let saturation = recovered
        .begin_call("next-call".into(), "get_task_context".into(), json!({}))
        .expect_err("a turn boundary must not reopen the saturated durable run");
    assert!(saturation.is_active_turn_receipt_limit());

    let encoded = serde_json::to_string(&recovered).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered.has_completed_call("settled-0"));
    assert!(recovered.has_completed_call("last-call"));
    assert!(recovered.durable_run_receipt_limit_reached());

    recovered.attach_run(tools("computed")).unwrap();
    assert!(!recovered.durable_run_receipt_limit_reached());
    recovered
        .begin_call("overflow".into(), "get_task_context".into(), json!({}))
        .expect("a new durable run receives a fresh tool-call identity ledger");
}

#[test]
fn settled_result_byte_exhaustion_recovers_after_turn_cleanup() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let large_result = json!({"value": "x".repeat(750 * 1024)});

    for index in 0..10 {
        let call_id = format!("large-settled-{index}");
        bridge
            .begin_call(call_id.clone(), "get_task_context".into(), json!({}))
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".into(),
                result: large_result.clone(),
                is_error: false,
            })
            .unwrap();
    }
    bridge.settle_turn("provider_turn_terminated").unwrap();

    let error = bridge
        .begin_call(
            "over-byte-limit".into(),
            "get_task_context".into(),
            json!({}),
        )
        .expect_err("settled byte exhaustion must stop the durable run");
    assert!(error.is_active_turn_receipt_limit());

    let encoded = serde_json::to_string(&bridge).unwrap();
    let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
    recovered.attach_existing_run().unwrap();
    assert!(recovered.durable_run_receipt_limit_reached());
    assert_eq!(
        recovered
            .replay_result("large-settled-0", "get_task_context", &json!({}))
            .unwrap()
            .unwrap()
            .result,
        large_result
    );
    assert!(recovered
        .begin_call(
            "over-byte-limit".into(),
            "get_task_context".into(),
            json!({})
        )
        .is_err());
    recovered.prepare_turn().unwrap();
    assert!(recovered
        .replay_result("large-settled-0", "get_task_context", &json!({}))
        .unwrap()
        .is_none());
    assert!(recovered.has_completed_call("large-settled-0"));
    assert!(!recovered.durable_run_receipt_limit_reached());
    recovered
        .begin_call(
            "after-turn-boundary".into(),
            "get_task_context".into(),
            json!({}),
        )
        .expect("releasing bulky results clears transient byte pressure");
    recovered
        .settle_turn("provider_turn_terminated")
        .expect("the admitted next-turn call remains settleable");

    recovered.attach_run(tools("computed")).unwrap();
    recovered
        .begin_call(
            "over-byte-limit".into(),
            "get_task_context".into(),
            json!({}),
        )
        .expect("a new durable run resets the settled result budget");
}

#[test]
fn reserves_settled_result_bytes_before_accepting_a_call() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let large_result = json!({"value": "x".repeat(700 * 1024)});
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
        .settle_turn("provider_turn_terminated")
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
        json!({"value": "x".repeat(700 * 1024)})
    );
}

#[test]
fn recovery_rejects_an_oversized_settled_result_envelope() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    let settled = encoded["settledResults"].as_object_mut().unwrap();
    for index in 0..12 {
        let call_id = format!("recovered-large-{index}");
        settled.insert(
            call_id.clone(),
            json!({
                "call": {
                    "callId": call_id,
                    "operationId": "get_task_context",
                    "input": {}
                },
                "result": {
                    "callId": call_id,
                    "operationId": "get_task_context",
                    "result": {"value": "x".repeat(700 * 1024)},
                    "isError": false
                }
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
    let mut settled_ids = Vec::new();
    for index in 0..11 {
        let call_id = format!("recovered-large-{index}");
        settled_ids.push(json!(call_id));
        settled.insert(
            call_id.clone(),
            json!({
                "call": {
                    "callId": call_id,
                    "operationId": "get_task_context",
                    "input": {}
                },
                "result": {
                    "callId": call_id,
                    "operationId": "get_task_context",
                    "result": {"value": "x".repeat(700 * 1024)},
                    "isError": false
                }
            }),
        );
    }
    encoded["settledCallIds"] = serde_json::Value::Array(settled_ids);
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
fn settles_pending_receipts_with_explicit_terminal_results() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    bridge
        .begin_call("call-1".into(), "get_task_context".into(), json!({}))
        .unwrap();

    let settled = bridge.settle_turn("provider_turn_terminated").unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].call_id, "call-1");
    assert!(settled[0].is_error);
    assert_eq!(bridge.pending_calls().count(), 0);
}

#[test]
fn full_identity_ledger_fails_closed_across_turn_and_recovery() {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(tools("computed")).unwrap();
    let mut encoded = serde_json::to_value(&bridge).unwrap();
    encoded["settledCallIds"] = serde_json::Value::Array(
        (0..65_536)
            .map(|index| json!(format!("settled-{index:05}")))
            .collect(),
    );
    let mut recovered: ProviderToolBridge = serde_json::from_value(encoded).unwrap();
    recovered.validate_recovered().unwrap();
    let saturation = recovered
        .begin_call("current-call".into(), "get_task_context".into(), json!({}))
        .expect_err("a full exact ledger must stop fresh work");
    assert!(saturation.is_active_turn_receipt_limit());
    assert!(recovered.durable_run_receipt_limit_reached());
    assert!(recovered.has_completed_call("settled-65535"));
    assert!(recovered.has_completed_call("settled-00000"));
    assert!(!recovered.has_completed_call("current-call"));
    assert!(recovered
        .begin_call("settled-00000".into(), "get_task_context".into(), json!({}))
        .is_err());
    recovered.prepare_turn().unwrap();
    let fresh = recovered
        .begin_call("fresh-call".into(), "get_task_context".into(), json!({}))
        .expect_err("a turn boundary must preserve durable-run saturation");
    assert!(fresh.is_active_turn_receipt_limit());

    let round_trip = serde_json::to_value(&recovered).unwrap();
    assert_eq!(
        round_trip["settledCallIds"].as_array().unwrap().len(),
        65_536
    );
    let mut recovered_again: ProviderToolBridge = serde_json::from_value(round_trip).unwrap();
    recovered_again.attach_existing_run().unwrap();
    assert!(recovered_again.durable_run_receipt_limit_reached());
    assert!(recovered_again.has_completed_call("settled-00000"));

    recovered_again.attach_run(tools("computed")).unwrap();
    assert!(!recovered_again.durable_run_receipt_limit_reached());
    recovered_again
        .begin_call("current-call".into(), "get_task_context".into(), json!({}))
        .expect("only a new durable run resets replay authority");
}
