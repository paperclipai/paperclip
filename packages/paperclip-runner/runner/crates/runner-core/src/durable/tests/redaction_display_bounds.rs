#[test]
fn redaction_growth_keeps_a_full_tool_output_inside_its_schema_bound() {
    let mut config = config(PathBuf::from("unused"));
    config.max_outbox_bytes = 1024 * 1024;
    config.max_frame_bytes = 256 * 1024;
    for (needle, secret) in [
        ("GITHUB_TOKEN: ***", "***"),
        ("token=abc", "token=abc"),
        ("Authorization: Bearer x", "Bearer x"),
        ("password: hunter2", "hunter2"),
    ] {
        let mut state = DurableState::new(&config);
        let line = format!("{}\n{needle}\n", "x".repeat(70));
        let text: String = line
            .repeat(65_536 / line.len() + 1)
            .chars()
            .take(65_536)
            .collect();
        state
            .enqueue_event(&config, "tool.execution.completed", EventPriority::P1, json!({
                "schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"execute","status":"completed",
                "output":text,"outputBytes":200_000,"outputTruncated":false,"outputDigest":format!("sha256:{}", "a".repeat(64))
            }))
            .unwrap_or_else(|error| panic!("{needle} was rejected: {error:?}"));
        let stored = state.outbox[0]
            .envelope
            .pointer("/payload/payload")
            .unwrap();
        let output = stored["output"].as_str().unwrap();
        let redacted = redact_sensitive_text_values(&text);
        let expected: String = redacted
            .chars()
            .skip(redacted.chars().count() - 65_536)
            .collect();
        assert_eq!(output, expected, "{needle}");
        assert!(!output.contains(secret), "{needle}");
        assert_eq!(stored["outputTruncated"], true, "{needle}");
        assert!(crate::acpx_event_payload::has_bounded_rich_display_shape(
            "tool.execution.completed",
            stored
        ));
    }
}

#[test]
fn redaction_growth_keeps_a_bounded_notice_summary_inside_its_schema_bound() {
    let config = config(PathBuf::from("unused"));
    let mut state = DurableState::new(&config);
    let summary = format!("token=abc {}", "y".repeat(3_990));
    assert_eq!(summary.chars().count(), 4_000);
    state
        .enqueue_event(&config, "provider.notice.recorded", EventPriority::P1, json!({
            "schema":"paperclip.provider.notice.v1","noticeId":"notice-1","severity":"info","category":"provider.status",
            "scope":"turn","recoverable":true,"userActionable":false,"summary":summary
        }))
        .unwrap();
    let stored = state.outbox[0]
        .envelope
        .pointer("/payload/payload")
        .unwrap();
    let stored_summary = stored["summary"].as_str().unwrap();
    assert_eq!(stored_summary.chars().count(), 4_000);
    assert!(stored_summary.starts_with("token=[REDACTED] y"));
    assert!(stored.get("outputTruncated").is_none());
}

#[test]
fn redaction_within_the_bound_leaves_short_tool_output_whole() {
    let config = config(PathBuf::from("unused"));
    let mut state = DurableState::new(&config);
    state
        .enqueue_event(&config, "tool.execution.completed", EventPriority::P1, json!({
            "schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"execute","status":"completed",
            "output":"before\ntoken=abc\nafter","outputBytes":22,"outputTruncated":false,"outputDigest":null
        }))
        .unwrap();
    let stored = state.outbox[0]
        .envelope
        .pointer("/payload/payload")
        .unwrap();
    assert_eq!(stored["output"], "before\ntoken=[REDACTED]\nafter");
    assert_eq!(stored["outputTruncated"], false);
}
