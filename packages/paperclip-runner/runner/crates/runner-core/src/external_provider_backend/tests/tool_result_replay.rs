use super::*;

#[test]
fn redacted_tool_result_transport_and_command_replay_after_restart() {
    use crate::durable::{sanitize_value, CommandDisposition, DurableStateStore};
    for codec in [
        ExternalProviderCodec::Dot,
        ExternalProviderCodec::Grok,
        ExternalProviderCodec::Muse,
    ] {
        let dir = TestDirectory::new();
        let mut executor = prepared_codec(dir.path(), codec);
        accept(&mut executor);
        let tool = operation(
            "catalog-read-1",
            "tool",
            json!({"name":"save_report","arguments":{"text":"synthetic catalog"}}),
        );
        assert_eq!(
            call(&mut executor, "external_provider.operation", tool.clone())["status"],
            "pending"
        );
        let events = executor.retained_events().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.event_type == "semantic_tool.input")
                .count(),
            1
        );
        executor.acknowledge_events(events.len()).unwrap();
        let tool_result = json!({"callId":"catalog-read-1","operationId":"save_report",
        "isError":false,"result":{"schema":{"type":"object","description":"Public schema",
            "properties":{"credentials":{"type":"string","description":"Supplied by user"}}}}});
        call(&mut executor, "semantic_tool.result", tool_result.clone());
        let events = executor.retained_events().unwrap();
        let settled = events
            .iter()
            .find(|e| e.event_type == "external_provider.operation_settled")
            .unwrap();
        let expected = sanitize_value(&settled.payload["outcome"]);
        assert_eq!(
            expected["result"]["schema"]["properties"]["credentials"],
            "[REDACTED]"
        );

        let cfg = config(dir.path());
        let store = DurableStateStore::new(dir.path()).unwrap();
        let (mut durable, _) = store.load_or_create(&cfg).unwrap();
        durable
            .enqueue_event(
                &cfg,
                &settled.event_type,
                settled.priority,
                settled.payload.clone(),
            )
            .unwrap();
        let replay_command = command("external_provider.operation", tool.clone());
        assert_eq!(
            durable.begin_command(&replay_command).unwrap(),
            CommandDisposition::Execute
        );
        let outcome = call(&mut executor, "external_provider.operation", tool.clone());
        let completed = durable.complete_command(&replay_command, outcome).unwrap();
        assert_eq!(completed.result, expected);
        let result_digest = semantic_value_digest(&completed.result);
        store.save(&durable).unwrap();
        executor.acknowledge_events(events.len()).unwrap();
        drop(executor);
        drop(durable);

        let (mut durable, existed) = store.load_or_create(&cfg).unwrap();
        assert!(existed);
        match durable.begin_command(&replay_command).unwrap() {
            CommandDisposition::Replay(receipt) => {
                assert_eq!(receipt.result, expected);
                assert_eq!(semantic_value_digest(&receipt.result), result_digest);
            }
            _ => panic!("durable command replay must not invoke the tool"),
        }
        let mut recovered = ExternalCommandExecutor::with_codec(dir.path(), &cfg, codec);
        let provider_receipt = call(&mut recovered, "external_provider.operation", tool);
        assert_eq!(sanitize_value(&provider_receipt), expected);
        call(&mut recovered, "semantic_tool.result", tool_result);
        assert!(recovered.poll_events().unwrap().is_empty());
    }
}
