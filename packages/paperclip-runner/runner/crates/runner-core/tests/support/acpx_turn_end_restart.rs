use super::*;

const WARM_TURN: [&str; 2] = ["turn.start", "session.goal.get"];

fn live_providers(harness: &Harness) -> Vec<Value> {
    harness
        .fixture
        .process_starts()
        .into_iter()
        .map(|line| line["processStart"].clone())
        .filter(alive)
        .collect()
}

fn settle(harness: &mut Harness, turn: &str) -> Vec<Value> {
    let events = harness.complete_turn(turn);
    harness.executor.prepare_next_turn().unwrap();
    events
}

fn start_follow_up(harness: &mut Harness, turn: &str) -> (Vec<Value>, Vec<String>, Duration) {
    let before = harness.fixture.journal().len();
    let started = Instant::now();
    let execution = harness.execute(
        "turn.start",
        json!({"turnId": turn, "text": "Complete the work."}),
    );
    let elapsed = started.elapsed();
    let mut events = execution
        .events
        .iter()
        .map(|(kind, _, payload)| json!({"type":kind,"payload":payload}))
        .collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !events
        .iter()
        .any(|event: &Value| event["type"] == "turn.completed")
    {
        assert!(Instant::now() < deadline, "no completed provider turn");
        events.extend(harness.drain());
    }
    events.extend(harness.drain());
    let commands = commands_after(&harness.fixture.journal(), before);
    (events, commands, elapsed)
}

fn reconciled(events: &[Value]) -> &Value {
    &events
        .iter()
        .find(|event| event["type"] == "session.reconciled")
        .expect("the turn reports the replaced provider process")["payload"]
}

#[test]
fn a_settled_turn_restarts_its_provider_and_the_next_turn_starts_without_one() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    let before = harness.fixture.journal().len();
    let started = Instant::now();
    harness.executor.prepare_next_turn().unwrap();
    let restart = started.elapsed();
    let journal = harness.fixture.journal();
    let spawned = last_process_start(&journal);
    assert_eq!(
        commands_after(&journal[..spawned], before),
        ["session.suspend"]
    );
    assert_eq!(journal[spawned]["livePredecessors"], json!([]));
    assert_eq!(
        commands_after(&journal, spawned),
        ["initialize", "session.open", "run.attach"]
    );
    assert_eq!(journal[spawned + 3]["params"]["runId"], "run-1");
    let fresh_pid = journal[spawned]["processStart"].clone();
    assert!(!alive(&old_pid));
    assert_eq!(live_providers(&harness), [fresh_pid.clone()]);
    assert_eq!(
        harness.drain(),
        Vec::<Value>::new(),
        "the fresh generation's output waits for its first turn"
    );
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 2);

    let (events, commands, turn_start) = start_follow_up(&mut harness, "second");
    eprintln!("turn-end restart={restart:?} follow-up turn.start={turn_start:?}");
    assert_eq!(commands, WARM_TURN);
    assert_eq!(reconciled(&events)["previousProcessId"], old_pid);
    assert_eq!(reconciled(&events)["processId"], fresh_pid);
    assert!(events
        .iter()
        .any(|event| event["type"] == "harness.diagnostic"
            && event["payload"]["details"]["pid"] == fresh_pid));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 3);
    assert_eq!(live_providers(&harness).len(), 1);
    let (_, commands, _) = start_follow_up(&mut harness, "third");
    assert_eq!(commands, WARM_TURN);
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}

#[test]
fn park_reuses_the_generation_a_settled_turn_restarted() {
    let mut harness = Harness::new();
    settle(&mut harness, "first");
    let fresh_pid = harness.fixture.process_starts().last().unwrap()["processStart"].clone();
    assert!(harness.executor.host_park_ready().unwrap());
    let before = harness.fixture.journal().len();
    let started = Instant::now();
    assert!(
        !harness.executor.prepare_for_park(park_deadline()).unwrap(),
        "park neither restarts nor asks for a second proof"
    );
    eprintln!(
        "park preparation after a turn-end restart={:?}",
        started.elapsed()
    );
    assert_eq!(
        commands_after(&harness.fixture.journal(), before),
        Vec::<String>::new()
    );
    assert!(harness.executor.host_park_ready().unwrap());
    assert_eq!(harness.fixture.process_starts().len(), 2);

    let (attached, _) = harness.attach("run-2", |_| {});
    assert_eq!(attached.result["processId"], fresh_pid);
    let events = settle(&mut harness, "second");
    assert!(events
        .iter()
        .any(|event| event["type"] == "harness.diagnostic"
            && event["payload"]["details"]["pid"] == fresh_pid));
    assert_eq!(harness.fixture.process_starts().len(), 3);
    let (events, commands, _) = start_follow_up(&mut harness, "third");
    assert_eq!(commands, WARM_TURN);
    assert_eq!(reconciled(&events)["previousProcessId"], fresh_pid);
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.executor.shutdown().unwrap();
}

#[test]
fn the_reaped_generation_late_callback_never_reaches_the_next_turn() {
    let mut harness = Harness::new();
    harness.complete_turn("first");
    harness.fixture.fault("late-tool-after-suspend");
    harness.executor.prepare_next_turn().unwrap();
    harness.fixture.fault("");
    assert_eq!(harness.drain(), Vec::<Value>::new());
    let (events, commands, _) = start_follow_up(&mut harness, "second");
    assert_eq!(commands, WARM_TURN);
    assert!(!format!("{events:?}").contains("late-call"));
    assert!(!format!("{events:?}").contains("late-old-generation"));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_turn_that_arrives_before_the_turn_end_restart_restarts_at_its_start() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    let (events, commands, _) = start_follow_up(&mut harness, "second");
    assert_eq!(commands[..2], ["session.suspend", "initialize"]);
    assert_eq!(reconciled(&events)["previousProcessId"], old_pid);
    assert_eq!(harness.fixture.process_starts().len(), 2);
    assert_eq!(live_providers(&harness).len(), 1);
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 3);
    assert_eq!(live_providers(&harness).len(), 1);
    let (_, commands, _) = start_follow_up(&mut harness, "third");
    assert_eq!(commands, WARM_TURN);
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_park_before_the_turn_end_restart_restarts_once() {
    let mut harness = Harness::new();
    harness.complete_turn("first");
    assert!(harness.executor.host_park_ready().unwrap());
    assert!(harness.executor.prepare_for_park(park_deadline()).unwrap());
    assert!(harness.executor.host_park_ready().unwrap());
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 2);
    assert_eq!(live_providers(&harness).len(), 1);
    let (attached, _) = harness.attach("run-2", |_| {});
    assert_eq!(attached.result["processId"], live_providers(&harness)[0]);
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_failed_turn_end_restart_fails_the_next_turn_like_a_failed_turn_start_restart() {
    let outcome = |turn_end: bool| {
        let mut harness = Harness::new();
        let old_pid = harness.opened["processId"].clone();
        harness.complete_turn("first");
        harness.fixture.fault("reject-open");
        if turn_end {
            harness.executor.prepare_next_turn().unwrap();
            assert!(!alive(&old_pid));
            assert!(!harness.executor.host_park_ready().unwrap());
            assert!(!harness.executor.prepare_for_park(park_deadline()).unwrap());
            assert_eq!(harness.drain(), Vec::<Value>::new());
            harness.executor.prepare_next_turn().unwrap();
        }
        let first = harness
            .executor
            .execute(&command(
                90,
                "turn.start",
                json!({"turnId": "second", "text": "Complete the work."}),
            ))
            .unwrap_err()
            .to_string();
        harness.fixture.fault("");
        let retry = harness
            .executor
            .execute(&command(
                91,
                "turn.start",
                json!({"turnId": "third", "text": "Complete the work."}),
            ))
            .unwrap_err()
            .to_string();
        assert_eq!(live_providers(&harness), Vec::<Value>::new());
        let state = harness.fixture.state();
        let starts = harness.fixture.process_starts().len();
        harness.executor.shutdown().unwrap();
        (
            first,
            retry,
            state["lifecycle"].clone(),
            state["providerExitUnconfirmed"].clone(),
            state["activeTurnId"].clone(),
            state["pendingEvents"].clone(),
            starts,
        )
    };
    let mut at_turn_end = outcome(true);
    assert!(
        at_turn_end.0.starts_with("ACPX turn start failed closed:")
            && at_turn_end.0.contains("session.open"),
        "{}",
        at_turn_end.0
    );
    // The turns of this run fail the same way. Unlike a failed restart at turn
    // start, the failed turn-end restart saves a resumable session, so the next
    // run resumes the conversation (see the test below).
    assert_eq!(at_turn_end.2, "suspended");
    let mut at_turn_start = outcome(false);
    assert_eq!(at_turn_start.2, "closed");
    at_turn_end.2 = Value::Null;
    at_turn_start.2 = Value::Null;
    assert_eq!(at_turn_end, at_turn_start);
}

#[test]
fn cancellation_after_a_turn_end_restart_is_already_settled() {
    let mut harness = Harness::new();
    settle(&mut harness, "first");
    for kind in ["run.cancel", "turn.interrupt", "turn.stop"] {
        let result = harness.execute(kind, json!({})).result;
        assert_eq!(result["status"], "already_settled", "{kind}");
    }
    let (_, commands, _) = start_follow_up(&mut harness, "second");
    assert_eq!(commands, WARM_TURN);
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
}

#[test]
fn suspension_and_retirement_after_a_turn_end_restart_reap_the_fresh_generation() {
    let mut harness = Harness::new();
    settle(&mut harness, "first");
    let fresh_pid = live_providers(&harness)[0].clone();
    harness.execute("runner.suspend", json!({}));
    assert!(!alive(&fresh_pid));
    assert_eq!(harness.fixture.state()["lifecycle"], "suspended");
    let events = harness.complete_turn("second");
    assert!(events
        .iter()
        .any(|event| event["type"] == "session.resumed"));
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.executor.prepare_next_turn().unwrap();
    let fresh_pid = live_providers(&harness)[0].clone();
    assert_eq!(harness.fixture.process_starts().len(), 4);
    harness.executor.shutdown().unwrap();
    assert!(!alive(&fresh_pid));
}

#[test]
fn an_active_goal_or_a_request_at_the_terminal_keeps_today_s_restart_timing() {
    let mut harness = Harness::new();
    harness.fixture.fault("goal");
    harness.complete_turn("first");
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(
        harness.fixture.process_starts().len(),
        1,
        "an active goal can keep working after its prompt"
    );
    harness.executor.shutdown().unwrap();

    let resolve = |turn_end: bool| {
        let mut harness = Harness::new();
        harness.fixture.fault("pending-input");
        let events = harness.complete_turn("first");
        harness.fixture.fault("");
        if turn_end {
            harness.executor.prepare_next_turn().unwrap();
        }
        let resolved = harness
            .executor
            .execute(&command(
                90,
                "request.resolve",
                json!({"requestId": "input-at-terminal", "answers": {"target": "first"}}),
            ))
            .map(|execution| execution.result)
            .map_err(|error| error.to_string());
        let (_, commands, _) = start_follow_up(&mut harness, "second");
        let starts = harness.fixture.process_starts().len();
        harness.executor.shutdown().unwrap();
        (
            events
                .iter()
                .map(|event| event["type"].clone())
                .collect::<Vec<_>>(),
            resolved,
            commands.contains(&"session.suspend".to_owned()),
            starts,
        )
    };
    let at_turn_end = resolve(true);
    let at_turn_start = resolve(false);
    assert_eq!(at_turn_end.0, at_turn_start.0);
    assert_eq!(at_turn_end.1, at_turn_start.1);
    assert_eq!(at_turn_end.3, at_turn_start.3);
    eprintln!("request at terminal: {at_turn_end:?}");
}

/// A turn-end restart that fails (for example a slow or loaded host) used to
/// save the session `closed`. The next run's `run.attach` then refused it and
/// the controller started a new conversation. The failed restart now saves a
/// resumable session once the reaped provider is proven gone: later turns of
/// this run still fail closed, and the next run resumes the same conversation,
/// in this Runner process or in a new one.
#[test]
fn the_next_run_resumes_the_conversation_after_a_failed_turn_end_restart() {
    for new_runner_process in [false, true] {
        let mut harness = Harness::new();
        let old_pid = harness.opened["processId"].clone();
        let conversation = harness.opened["providerSessionId"].clone();
        harness.complete_turn("first");
        harness.fixture.fault("reject-open");
        harness.executor.prepare_next_turn().unwrap();
        assert!(!alive(&old_pid));
        // The Runner records the cause once as a diagnostic.
        let reported = harness.executor.take_turn_end_restart_failure();
        assert!(
            reported
                .as_deref()
                .is_some_and(|cause| cause.contains("session.open")),
            "{reported:?}"
        );
        assert_eq!(harness.executor.take_turn_end_restart_failure(), None);
        let saved = harness.fixture.state();
        assert_eq!(saved["lifecycle"], "suspended", "{saved}");
        assert_eq!(saved["providerExitUnconfirmed"], false);
        let failed = harness
            .executor
            .execute(&command(
                90,
                "turn.start",
                json!({"turnId": "second", "text": "Complete the work."}),
            ))
            .unwrap_err()
            .to_string();
        assert!(
            failed.starts_with("ACPX turn start failed closed:"),
            "{failed}"
        );
        harness.sequence = 90;
        harness.fixture.fault("");
        let attached = if new_runner_process {
            // A new Runner process for the next run cold-attaches the saved session.
            harness.executor.shutdown().unwrap();
            harness.config.run_id = "run-2".to_owned();
            harness.executor = NativeProviderCommandExecutor::with_runner_config(
                &harness.fixture.0,
                &harness.config,
            );
            let payload = harness.attach_payload("run-2", |payload| {
                payload
                    .as_object_mut()
                    .unwrap()
                    .remove("paperclipNextAuthority");
            });
            harness.execute("run.attach", payload)
        } else {
            harness.attach("run-2", |_| {}).0
        };
        assert_eq!(
            attached.result["providerSessionId"], conversation,
            "new_runner_process={new_runner_process}"
        );
        harness.complete_turn("next-run");
        assert_eq!(harness.fixture.state()["descriptor"]["runId"], "run-2");
        harness.executor.shutdown().unwrap();
    }
}

#[test]
fn a_runner_restart_in_the_same_run_keeps_the_failed_turn_end_restart_closed() {
    let mut harness = Harness::new();
    let conversation = harness.opened["providerSessionId"].clone();
    harness.complete_turn("first");
    harness.fixture.fault("reject-open");
    harness.executor.prepare_next_turn().unwrap();
    harness.fixture.fault("");
    let saved = harness.fixture.state();
    assert_eq!(
        saved["turnEndRestartFailedRun"], harness.config.run_id,
        "{saved}"
    );
    // The Runner process restarts inside the same run: its turns still fail
    // closed instead of reopening the saved session.
    harness.executor.shutdown().unwrap();
    harness.executor =
        NativeProviderCommandExecutor::with_runner_config(&harness.fixture.0, &harness.config);
    let starts = harness.fixture.process_starts().len();
    let failed = harness
        .executor
        .execute(&command(
            90,
            "turn.start",
            json!({"turnId": "second", "text": "Complete the work."}),
        ))
        .unwrap_err();
    assert_eq!(failed.to_string(), "ACPX session is not open");
    // No same-run start can reopen it: the controller offers Retry at once.
    assert_eq!(
        failed.classification(),
        Some(paperclip_runner_core::durable::PROVIDER_SESSION_CLOSED)
    );
    assert_eq!(harness.fixture.process_starts().len(), starts);
    // Neither session.open nor a same-run attach reopens it.
    let reopened = harness
        .executor
        .execute(&command(91, "session.open", json!({})))
        .unwrap_err()
        .to_string();
    assert!(reopened.contains("failed closed"), "{reopened}");
    let same_run_attach = json!({"provider": harness.descriptor.clone()});
    let attach_error = harness
        .executor
        .execute(&command(92, "run.attach", same_run_attach))
        .unwrap_err()
        .to_string();
    assert!(attach_error.contains("failed closed"), "{attach_error}");
    assert_eq!(harness.fixture.process_starts().len(), starts);
    assert_eq!(
        harness.fixture.state()["turnEndRestartFailedRun"],
        harness.config.run_id
    );
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
    assert_eq!(harness.fixture.state()["lifecycle"], "suspended");
    // The next run still resumes the conversation and clears the restriction.
    harness.executor.shutdown().unwrap();
    harness.sequence = 92;
    harness.config.run_id = "run-2".to_owned();
    harness.executor =
        NativeProviderCommandExecutor::with_runner_config(&harness.fixture.0, &harness.config);
    let payload = harness.attach_payload("run-2", |payload| {
        payload
            .as_object_mut()
            .unwrap()
            .remove("paperclipNextAuthority");
    });
    let attached = harness.execute("run.attach", payload);
    assert_eq!(attached.result["providerSessionId"], conversation);
    assert!(harness
        .fixture
        .state()
        .get("turnEndRestartFailedRun")
        .is_none());
    harness.complete_turn("next-run");
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_per_turn_runner_skips_the_turn_end_restart_and_restarts_a_later_turn_at_its_start() {
    let mut harness = Harness::configured(|config| config.turn_scoped = true);
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    let before = harness.fixture.journal().len();
    // The Runner exits with its run: no generation is spawned for teardown.
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 1);
    assert_eq!(
        commands_after(&harness.fixture.journal(), before),
        Vec::<String>::new()
    );
    assert_eq!(live_providers(&harness), [old_pid.clone()]);
    // A later turn of the same run still gets a fresh generation, at its start.
    let (events, commands, _) = start_follow_up(&mut harness, "second");
    assert_eq!(commands[..2], ["session.suspend", "initialize"]);
    assert_eq!(reconciled(&events)["previousProcessId"], old_pid);
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}
