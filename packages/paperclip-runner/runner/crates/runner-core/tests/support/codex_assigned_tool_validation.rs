use super::*;

#[test]
fn assigned_tool_discovery_repairs_invalid_arguments_through_codex_transport() {
    let directory = temporary_directory("assigned-discovery-repair");
    let config = provider_config(&directory, &["--repair-assigned-discovery"]);
    let operations = vec![AuthorizedTool {
        operation_id: "paperclip_search_assigned_tools".to_owned(),
        version: 1,
        description: "Search assigned tools.".to_owned(),
        input_schema: json!({"type":"object", "required":["query"],
            "properties":{"query":{"type":"string"}}, "additionalProperties":false}),
        response_schema: json!({"type":"object"}),
    }];
    let tool_set = AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    };
    let mut executor =
        CodexCommandExecutor::with_runner_config(&directory, &durable_config(&directory));
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider":config, "authorizedTools":tool_set
            }),
        ))
        .unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text":"Discover the assigned GitHub tools."}),
        ))
        .unwrap();

    let mut denied = 0;
    let mut dispatched = 0;
    let mut completed = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !completed && std::time::Instant::now() < deadline {
        for event in poll_and_ack(&mut executor).unwrap() {
            match event.event_type.as_str() {
                "harness.diagnostic" if event.payload["code"] == "semantic_tool_denied" => {
                    denied += 1;
                    assert_eq!(dispatched, 0);
                    assert_eq!(
                        event.payload["operationId"],
                        "paperclip_search_assigned_tools"
                    );
                    assert_eq!(event.payload["callId"], "assigned-discovery");
                    assert_eq!(
                        event.payload["message"],
                        "provider arguments for paperclip_search_assigned_tools failed JSON Schema validation"
                    );
                    assert_eq!(event.payload["paperclipExecuted"], false);
                    let guidance = event.payload["inputSchemaGuidance"]
                        .as_str()
                        .expect("denied input retains the safe guidance sent to the provider");
                    assert!(guidance.contains("/properties/query/type"), "{guidance}");
                    assert!(guidance.len() <= 512);
                    assert!(event.payload.get("input").is_none());
                    assert!(event.payload.get("arguments").is_none());
                    assert!(!event.payload.to_string().contains("PRIVATE_QUERY"));
                    assert!(!event.payload.to_string().contains("private search"));
                }
                "semantic_tool.input" => {
                    dispatched += 1;
                    assert_eq!(denied, 1);
                    assert_eq!(
                        event.payload["semantic_tool"]["input"],
                        json!({"query":"github"})
                    );
                    executor.execute(&command("result", 4, "semantic_tool.result", json!({
                        "callId":"assigned-discovery", "operationId":"paperclip_search_assigned_tools",
                        "result":{"tools":[{"name":"app_github_read_pull_request"}]}, "isError":false
                    }))).unwrap();
                }
                "turn.completed" => completed = true,
                "turn.failed" => panic!("provider could not repair discovery: {}", event.payload),
                _ => {}
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    executor.shutdown().unwrap();
    assert!(completed);
    assert_eq!(denied, 1);
    assert_eq!(dispatched, 1);
    assert_eq!(call_count(&directory, "discovery:repair-guidance"), 1);
    assert_eq!(call_count(&directory, "discovery:success"), 1);
    fs::remove_dir_all(directory).unwrap();
}
