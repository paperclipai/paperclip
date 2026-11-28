use super::*;

#[test]
fn first_task_confirmation_repairs_misplaced_metadata_without_becoming_a_question() {
    let directory = temporary_directory("first-task-confirmation-repair");
    // Read the current generated schema at test execution instead of embedding
    // test-only data outside the release crate's hashed build-input closure.
    let contracts: Value = serde_json::from_str(
        &fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../generated/capability/semantic-tool-contracts.json"),
        )
        .expect("read the generated semantic tool contracts"),
    )
    .expect("parse the generated semantic tool contracts");
    let definition = contracts
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "request_human_input")
        .unwrap();
    let operations = vec![AuthorizedTool {
        operation_id: "request_human_input".to_owned(),
        version: 1,
        description: definition["description"].as_str().unwrap().to_owned(),
        input_schema: definition["inputSchema"].clone(),
        response_schema: json!({"type":"object"}),
    }];
    let tools = AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    };
    let mut executor =
        CodexCommandExecutor::with_runner_config(&directory, &durable_config(&directory));
    executor.execute(&command("prepare", 1, "run.prepare", json!({
        "provider":provider_config(&directory, &["--repair-first-task-confirmation"]), "authorizedTools":tools
    }))).unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text":"Propose one child task and wait for approval."}),
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
                    assert_eq!(event.payload["paperclipExecuted"], false);
                    let hint = event.payload["inputSchemaGuidance"].as_str().unwrap();
                    assert!(hint.contains("payload.version"));
                    assert!(hint.contains("payload.supersedeOnUserComment"));
                    assert!(hint.contains("Keep approval"));
                    assert!(hint.contains("confirmation or checkbox"));
                    assert!(!hint.contains("payload.questionSet"));
                    assert!(hint.contains("/additionalProperties"));
                    assert!(hint.len() <= 512);
                    assert!(!event
                        .payload
                        .to_string()
                        .contains("PRIVATE_CONFIRMATION_SCOPE"));
                }
                "semantic_tool.input" => {
                    dispatched += 1;
                    assert_eq!(denied, 1);
                    let input = &event.payload["semantic_tool"]["input"];
                    assert_eq!(input["interactionKind"], "confirmation");
                    assert!(input.get("version").is_none());
                    assert!(input.get("supersedeOnUserComment").is_none());
                    assert_eq!(input["payload"]["version"], 1);
                    assert_eq!(input["payload"]["supersedeOnUserComment"], false);
                    executor.execute(&command("result", 4, "semantic_tool.result", json!({
                        "callId":"first-task-confirmation", "operationId":"request_human_input",
                        "result":{"interaction":{"id":"proposal-card","kind":"request_confirmation","status":"pending"}},
                        "isError":false
                    }))).unwrap();
                }
                "turn.completed" => completed = true,
                "turn.failed" => panic!(
                    "proposal could not correct its arguments: {}",
                    event.payload
                ),
                _ => {}
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    executor.shutdown().unwrap();
    assert!(completed);
    assert_eq!(denied, 1);
    assert_eq!(dispatched, 1);
    assert_eq!(call_count(&directory, "first-task:repair-guidance"), 1);
    assert_eq!(call_count(&directory, "first-task:confirmation-pending"), 1);
    fs::remove_dir_all(directory).unwrap();
}
