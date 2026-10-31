#[test]
fn textless_opencode_transport_completion_does_not_claim_work_success() {
    for message in [None, Some("   ".to_owned())] {
        let mut state = opencode_result_state();
        state.last_agent_message = message;

        let events = terminal_events(&state, "turn.completed", None);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "run.result.proposed");
        let result = &events[0].payload;
        assert_eq!(result["reportedWorkDisposition"], "needs_review");
        assert_eq!(result["completionClaim"]["objectiveSatisfied"], false);
        assert!(result["completionClaim"]["criteria"]
            .as_array()
            .unwrap()
            .iter()
            .all(|criterion| criterion["status"] == "unknown"
                && criterion["evidenceRefs"].as_array().unwrap().is_empty()));
        assert!(result["evidence"].as_array().unwrap().is_empty());
        assert!(result["attentionRequests"].as_array().unwrap().is_empty());
        assert_eq!(
            result["summary"],
            "The OpenCode turn completed without a final response or an accepted work result. Task completion is unverified."
        );
        assert!(!result["completionClaim"]["remainingWork"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(events[1].event_type, "run.terminal");
        assert_eq!(events[1].payload["turnTerminalState"], "completed");
        assert_eq!(events[1].payload["runTerminalState"], "succeeded");
        assert_eq!(events[1].payload["reportedWorkDisposition"], "needs_review");
        assert_eq!(
            events[1].payload["workOutcomeReason"],
            "missing_semantic_result_and_assistant_text"
        );
    }
}

