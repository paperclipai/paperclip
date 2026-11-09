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
    let at_turn_end = outcome(true);
    assert!(
        at_turn_end.0.starts_with("ACPX turn start failed closed:")
            && at_turn_end.0.contains("session.open"),
        "{}",
        at_turn_end.0
    );
    assert_eq!(at_turn_end, outcome(false));
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
