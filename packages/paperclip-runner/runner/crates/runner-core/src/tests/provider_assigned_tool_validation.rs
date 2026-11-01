use super::*;
use crate::provider_bridge::AuthorizedTool;

fn authorized_bridge(operation_id: &str, input_schema: Value) -> ProviderToolBridge {
    let operations = vec![AuthorizedTool {
        operation_id: operation_id.to_owned(),
        version: 1,
        description: "Search assigned tools.".to_owned(),
        input_schema,
        response_schema: json!({"type": "object"}),
    }];
    let mut bridge = ProviderToolBridge::default();
    bridge
        .prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        })
        .unwrap();
    bridge
}

#[test]
fn assigned_tool_discovery_rejection_guides_repair_without_retaining_a_receipt() {
    let operation_id = "paperclip_search_assigned_tools";
    let mut bridge = authorized_bridge(
        operation_id,
        json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "query": {"type": "string", "maxLength": 200},
                "offset": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                "schemaTool": {"type": "string"},
                "schemaOffset": {"type": "integer", "minimum": 0}
            },
            "required": ["query"]
        }),
    );
    let initial_state = serde_json::to_value(&bridge).unwrap();
    for (input, location) in [
        (json!({}), "/required (missing \"query\")"),
        (json!({"query": null}), "/properties/query/type"),
        (
            json!({"query": "PRIVATE_QUERY", "offset": null}),
            "/properties/offset/type",
        ),
        (
            json!({"query": "PRIVATE_QUERY", "limit": 21}),
            "/properties/limit/maximum",
        ),
        (
            json!({"query": "PRIVATE_QUERY".repeat(100)}),
            "/properties/query/maxLength",
        ),
        (
            json!({"query": "PRIVATE_QUERY", "PRIVATE_FIELD": "PRIVATE_VALUE"}),
            "/additionalProperties",
        ),
    ] {
        let error = bridge
            .begin_call("discovery".to_owned(), operation_id.to_owned(), input)
            .unwrap_err();
        let result =
            invalid_tool_call_result("discovery".to_owned(), operation_id.to_owned(), &error);
        let message = result.result["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("Correct the arguments and retry"),
            "{message}"
        );
        assert!(message.contains(location), "{message}");
        for private in ["PRIVATE_QUERY", "PRIVATE_FIELD", "PRIVATE_VALUE"] {
            assert!(!result.result.to_string().contains(private));
        }
        assert!(message.len() <= 512);
        assert!(!message.chars().any(char::is_control));
        assert!(result.is_error);
        assert_eq!(result.result["error"]["code"], "invalid_tool_call");
        assert_eq!(result.result["error"]["retryable"], false);
        assert!(!bridge.has_call_receipt("discovery"));
        assert_eq!(serde_json::to_value(&bridge).unwrap(), initial_state);
    }

    let input = json!({"query": "github"});
    bridge
        .begin_call(
            "discovery".to_owned(),
            operation_id.to_owned(),
            input.clone(),
        )
        .unwrap();
    assert_eq!(bridge.pending_calls().count(), 1);
    let result = ToolResult {
        call_id: "discovery".to_owned(),
        operation_id: operation_id.to_owned(),
        result: json!({"tools": [{"name": "app_github_read_pull_request"}]}),
        is_error: false,
    };
    bridge.apply_result(result.clone()).unwrap();
    assert_eq!(bridge.pending_calls().count(), 0);
    assert_eq!(
        bridge
            .replay_result("discovery", operation_id, &input)
            .unwrap(),
        Some(result)
    );
    assert!(bridge
        .begin_call("discovery".to_owned(), operation_id.to_owned(), input)
        .is_err());
}

#[test]
fn arbitrary_assigned_tool_gets_schema_guidance_only_when_authorized() {
    let operation_id = "app_custom_connection_search";
    let schema = json!({
        "type": "object", "required": ["query"],
        "properties": {"query": {"type": "string"}},
        "additionalProperties": false
    });
    let mut bridge = authorized_bridge(operation_id, schema);
    let error = bridge
        .begin_call("custom".to_owned(), operation_id.to_owned(), json!({}))
        .unwrap_err();
    let result = invalid_tool_call_result("custom".to_owned(), operation_id.to_owned(), &error);
    assert!(result.result["error"]["message"]
        .as_str()
        .unwrap()
        .contains("/required (missing \"query\")"));

    let denied = bridge
        .begin_call(
            "denied".to_owned(),
            "app_unassigned".to_owned(),
            json!({"PRIVATE_FIELD": "PRIVATE_VALUE"}),
        )
        .unwrap_err();
    assert_eq!(
        invalid_tool_call_result("denied".to_owned(), "app_unassigned".to_owned(), &denied).result
            ["error"]["message"],
        GENERIC_INVALID_TOOL_CALL_MESSAGE
    );
    assert!(!bridge.has_call_receipt("denied"));
}
