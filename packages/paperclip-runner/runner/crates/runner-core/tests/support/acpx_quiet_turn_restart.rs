use super::*;

fn live_providers(harness: &Harness) -> Vec<Value> {
    harness
        .fixture
        .process_starts()
        .into_iter()
        .map(|line| line["processStart"].clone())
        .filter(alive)
        .collect()
}

fn run_turn(harness: &mut Harness, turn: &str) -> (Vec<Value>, Vec<String>) {
    let before = harness.fixture.journal().len();
    let execution = harness.execute(
        "turn.start",
        json!({"turnId": turn, "text": "Complete the work."}),
    );
    let mut events = execution
        .events
        .iter()
        .map(|(kind, _, payload)| json!({"type":kind,"payload":payload}))
        .collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !events.iter().any(|event: &Value| {
        event["type"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("turn.") && kind != "turn.started")
    }) {
        assert!(Instant::now() < deadline, "no terminal provider turn");
        events.extend(harness.drain());
    }
    events.extend(harness.drain());
    (events, commands_after(&harness.fixture.journal(), before))
}

fn replaced(events: &[Value]) -> bool {
    events
        .iter()
        .any(|event| event["type"] == "session.reconciled")
}

#[test]
fn a_quiet_completed_claude_turn_keeps_its_provider_for_the_next_turns() {
    let mut harness = Harness::new();
    harness.fixture.background("quiet");
    let pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    let before = harness.fixture.journal().len();
    harness.executor.prepare_next_turn().unwrap();
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(
        commands_after(&harness.fixture.journal(), before),
        Vec::<String>::new(),
        "the turn-end path neither suspends nor respawns the provider"
    );
    assert_eq!(harness.fixture.process_starts().len(), 1);
    assert_eq!(live_providers(&harness), [pid.clone()]);

    for turn in ["second", "third"] {
        let (events, commands) = run_turn(&mut harness, turn);
        assert_eq!(
            commands,
            ["session.snapshot", "turn.start", "session.goal.get"],
            "{turn}"
        );
        assert!(!replaced(&events), "{turn}");
        assert!(events.iter().any(|event| event["type"] == "turn.completed"));
        harness.executor.prepare_next_turn().unwrap();
        assert_eq!(harness.fixture.process_starts().len(), 1, "{turn}");
        assert_eq!(live_providers(&harness), [pid.clone()], "{turn}");
    }
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}

#[test]
fn unknown_background_work_restarts_at_the_turn_end_like_today() {
    for mode in ["", "malformed"] {
        let mut harness = Harness::new();
        harness.fixture.background(mode);
        let pid = harness.opened["processId"].clone();
        harness.complete_turn("first");
        harness.executor.prepare_next_turn().unwrap();
        assert_eq!(harness.fixture.process_starts().len(), 2, "{mode}");
        assert!(!alive(&pid), "{mode}");
        let (events, commands) = run_turn(&mut harness, "second");
        assert_eq!(commands, ["turn.start", "session.goal.get"], "{mode}");
        assert_eq!(
            events
                .iter()
                .find(|event| event["type"] == "session.reconciled")
                .expect("the turn reports the replaced provider")["payload"]["previousProcessId"],
            pid,
            "{mode}"
        );
        harness.executor.shutdown().unwrap();
    }
}

#[test]
fn background_work_that_starts_after_a_quiet_terminal_restarts_at_the_next_turn() {
    for snapshot in ["snapshot-live", "snapshot-unknown", "snapshot-reject"] {
        let mut harness = Harness::new();
        harness.fixture.background("quiet");
        let pid = harness.opened["processId"].clone();
        harness.complete_turn("first");
        harness.executor.prepare_next_turn().unwrap();
        assert_eq!(harness.fixture.process_starts().len(), 1, "{snapshot}");
        harness.fixture.background(&format!("quiet {snapshot}"));
        let (events, commands) = run_turn(&mut harness, "second");
        assert_eq!(
            commands[..3],
            ["session.snapshot", "session.suspend", "initialize"],
            "{snapshot}"
        );
        assert!(replaced(&events), "{snapshot}");
        assert!(!alive(&pid), "{snapshot}");
        assert_eq!(harness.fixture.process_starts().len(), 2, "{snapshot}");
        harness.executor.shutdown().unwrap();
    }
}

#[test]
fn failed_cancelled_and_interrupted_turns_restart_like_today_even_when_quiet() {
    for status in ["failed", "cancelled", "interrupted"] {
        let outcome = |background: &str| {
            let mut harness = Harness::new();
            harness.fixture.background(background);
            let (events, _) = run_turn(&mut harness, "first");
            harness.executor.prepare_next_turn().unwrap();
            let after_turn_end = harness.fixture.process_starts().len();
            harness.fixture.background("quiet");
            let (next, commands) = run_turn(&mut harness, "second");
            let starts = harness.fixture.process_starts().len();
            harness.executor.shutdown().unwrap();
            (
                events
                    .iter()
                    .map(|event| event["type"].clone())
                    .collect::<Vec<_>>(),
                after_turn_end,
                commands,
                replaced(&next),
                starts,
            )
        };
        let quiet = outcome(&format!("quiet status-{status}"));
        let unknown = outcome(&format!("unknown status-{status}"));
        assert_eq!(quiet, unknown, "{status}");
        assert_eq!(quiet.1, 1, "{status}");
        assert!(quiet.3, "{status}");
        assert_eq!(quiet.4, 2, "{status}");
    }
}

#[test]
fn an_active_goal_or_an_early_turn_keeps_today_s_restart_when_quiet() {
    let mut harness = Harness::new();
    harness.fixture.background("quiet");
    harness.fixture.fault("goal");
    harness.complete_turn("first");
    harness.executor.prepare_next_turn().unwrap();
    harness.fixture.fault("");
    let (events, _) = run_turn(&mut harness, "second");
    assert!(replaced(&events));
    harness.executor.shutdown().unwrap();

    let mut harness = Harness::new();
    harness.fixture.background("quiet");
    harness.complete_turn("first");
    let (events, commands) = run_turn(&mut harness, "second");
    assert_eq!(commands[..2], ["session.suspend", "initialize"]);
    assert!(replaced(&events));
    harness.executor.shutdown().unwrap();
}

#[test]
fn park_after_a_kept_quiet_provider_still_prepares_a_fresh_generation() {
    let mut harness = Harness::new();
    harness.fixture.background("quiet");
    let pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 1);
    assert!(harness.executor.host_park_ready().unwrap());
    let started = Instant::now();
    assert!(harness.executor.prepare_for_park(park_deadline()).unwrap());
    eprintln!(
        "park preparation after a kept quiet provider={:?}",
        started.elapsed()
    );
    assert!(!alive(&pid));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    let fresh = live_providers(&harness);
    assert_eq!(fresh.len(), 1);
    assert!(harness.executor.host_park_ready().unwrap());
    let (attached, _) = harness.attach("run-2", |_| {});
    assert_eq!(attached.result["processId"], fresh[0]);
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_runner_restart_after_a_kept_quiet_provider_resumes_in_a_fresh_process() {
    let mut harness = Harness::new();
    harness.fixture.background("quiet");
    let pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(harness.fixture.process_starts().len(), 1);
    harness.executor.shutdown().unwrap();
    assert!(!alive(&pid));
    harness.executor =
        NativeProviderCommandExecutor::with_runner_config(&harness.fixture.0, &harness.config);
    harness.sequence = 90;
    let (events, _) = run_turn(&mut harness, "second");
    assert!(events.iter().any(|event| event["type"] == "turn.completed"));
    let journal = harness.fixture.journal();
    let spawned = last_process_start(&journal);
    assert_eq!(journal[spawned]["livePredecessors"], json!([]));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(
        harness.fixture.process_starts().len(),
        2,
        "the resumed quiet generation is kept for the next turn"
    );
    harness.executor.shutdown().unwrap();
}

fn complete_turn_accepting_provider_turns(harness: &mut Harness, turn: &str) -> Vec<Value> {
    let started = harness.execute(
        "turn.start",
        json!({"turnId": turn, "text": "Complete the work.", "providerStartedTurns": true}),
    );
    let seen = started
        .events
        .iter()
        .map(|(kind, _, payload)| json!({"type":kind,"payload":payload}))
        .collect::<Vec<_>>();
    drain_until(harness, seen, "turn.completed")
}

fn drain_until(harness: &mut Harness, mut seen: Vec<Value>, kind: &str) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !seen.iter().any(|event| event["type"] == kind) {
        assert!(Instant::now() < deadline, "expected {kind}: {seen:?}");
        seen.extend(harness.drain());
    }
    seen
}

#[test]
fn live_shells_at_a_completed_claude_turn_keep_the_provider_and_refuse_park() {
    let mut harness = Harness::new();
    harness
        .fixture
        .background("live provider-turn provider-turn-hold");
    let pid = harness.opened["processId"].clone();
    let events = complete_turn_accepting_provider_turns(&mut harness, "first");
    let completed = events
        .iter()
        .find(|event| event["type"] == "turn.completed")
        .unwrap();
    assert_eq!(completed["payload"]["awaitingProviderTurn"], json!(true));
    assert!(!events.iter().any(|event| event["type"] == "run.terminal"));
    let before = harness.fixture.journal().len();
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(
        commands_after(&harness.fixture.journal(), before),
        Vec::<String>::new()
    );
    assert_eq!(live_providers(&harness), [pid.clone()]);
    assert!(!harness.executor.host_park_ready().unwrap());

    let (next, _) = run_turn(&mut harness, "second");
    assert!(
        replaced(&next),
        "a controller turn restarts the awaited provider first"
    );
    assert!(!alive(&pid));
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}

#[test]
fn the_provider_started_turn_reaches_the_controller_as_ordinary_turn_events() {
    let mut harness = Harness::new();
    harness.fixture.background("live provider-turn");
    let pid = harness.opened["processId"].clone();
    let first = complete_turn_accepting_provider_turns(&mut harness, "first");
    let events = drain_until(&mut harness, first, "run.terminal");
    let kinds = events
        .iter()
        .map(|event| event["type"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let first_completed = kinds
        .iter()
        .position(|kind| kind == "turn.completed")
        .unwrap();
    let provider_started = events
        .iter()
        .position(|event| {
            event["type"] == "turn.started" && event["payload"]["origin"] == "provider"
        })
        .expect("provider-started turn");
    assert!(first_completed < provider_started);
    assert_eq!(
        events[provider_started]["payload"]["providerTurnId"],
        json!("provider-1")
    );
    let provider_completed = events
        .iter()
        .rposition(|event| event["type"] == "turn.completed")
        .unwrap();
    assert!(provider_started < provider_completed);
    assert_eq!(
        events[provider_completed]["payload"]["providerTurnId"],
        json!("provider-1")
    );
    assert!(events[provider_completed]["payload"]
        .get("awaitingProviderTurn")
        .is_none());
    assert!(events[provider_started..provider_completed]
        .iter()
        .any(|event| event["type"] == "usage.reported"));
    let run_terminal = kinds
        .iter()
        .position(|kind| kind == "run.terminal")
        .unwrap();
    assert!(run_terminal > provider_completed);
    assert_eq!(
        kinds.iter().filter(|kind| *kind == "run.terminal").count(),
        1
    );
    harness.executor.prepare_next_turn().unwrap();
    assert!(harness.executor.host_park_ready().unwrap());
    assert_eq!(live_providers(&harness).len(), 1);
    assert!(!alive(&pid) || live_providers(&harness) == [pid.clone()]);
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}

#[test]
fn a_runner_restart_while_awaiting_resumes_like_today() {
    let mut harness = Harness::new();
    harness
        .fixture
        .background("live provider-turn provider-turn-hold");
    let pid = harness.opened["processId"].clone();
    complete_turn_accepting_provider_turns(&mut harness, "first");
    harness.executor.prepare_next_turn().unwrap();
    assert_eq!(live_providers(&harness), [pid.clone()]);
    harness.executor.shutdown().unwrap();
    assert!(!alive(&pid));
    harness.executor =
        NativeProviderCommandExecutor::with_runner_config(&harness.fixture.0, &harness.config);
    harness.sequence = 90;
    harness.fixture.background("quiet");
    let (events, _) = run_turn(&mut harness, "second");
    assert!(events.iter().any(|event| event["type"] == "turn.completed"));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
    assert_eq!(live_providers(&harness), Vec::<Value>::new());
}

fn controller_view(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .map(|event| {
            let mut event = event.clone();
            for volatile in ["processId", "previousProcessId", "providerTurnId"] {
                if let Some(payload) = event["payload"].as_object_mut() {
                    payload.remove(volatile);
                }
            }
            event
        })
        .collect()
}

#[test]
fn without_the_controller_capability_live_shells_behave_exactly_as_before() {
    let outcome = |background: &str| {
        let mut harness = Harness::new();
        harness.fixture.background(background);
        let pid = harness.opened["processId"].clone();
        let events = harness.complete_turn("first");
        let park_ready_before_restart = harness.executor.host_park_ready().unwrap();
        let before = harness.fixture.journal().len();
        harness.executor.prepare_next_turn().unwrap();
        let commands = commands_after(&harness.fixture.journal(), before);
        let restarted = !alive(&pid);
        let park_ready = harness.executor.host_park_ready().unwrap();
        harness.executor.shutdown().unwrap();
        (
            controller_view(&events),
            commands,
            restarted,
            park_ready,
            park_ready_before_restart,
        )
    };
    let live = outcome("live provider-turn");
    let unknown = outcome("");
    assert_eq!(live.0, unknown.0);
    assert_eq!(live.1, unknown.1);
    assert!(live.2 && unknown.2);
    assert_eq!(live.3, unknown.3);
    assert_eq!(live.4, unknown.4);
    assert!(live.4);
    assert!(live.0.iter().any(|event| event["type"] == "run.terminal"));
    assert!(!live
        .0
        .iter()
        .any(|event| event["payload"].get("awaitingProviderTurn").is_some()));
    assert!(!live
        .1
        .iter()
        .any(|command| command == "session.provider_turn"));
}

#[test]
fn a_provider_lost_while_awaiting_ends_the_wait_with_the_held_run_terminal() {
    let mut harness = Harness::new();
    harness
        .fixture
        .background("live provider-turn provider-turn-hold provider-lost-after-arm");
    let pid = harness.opened["processId"].clone();
    let first = complete_turn_accepting_provider_turns(&mut harness, "first");
    let events = drain_until(&mut harness, first, "run.terminal");
    let completed = events
        .iter()
        .position(|event| event["type"] == "turn.completed")
        .unwrap();
    assert_eq!(
        events[completed]["payload"]["awaitingProviderTurn"],
        json!(true)
    );
    let terminals = events
        .iter()
        .filter(|event| event["type"] == "run.terminal")
        .collect::<Vec<_>>();
    assert_eq!(terminals.len(), 1);
    assert_eq!(
        terminals[0]["payload"]["turnTerminalState"],
        json!("completed")
    );
    assert!(events
        .iter()
        .any(|event| event["payload"]["code"] == "ACPX_PROVIDER_PROCESS_LOST"));
    harness.executor.prepare_next_turn().unwrap();
    assert!(
        !alive(&pid),
        "the lost provider is replaced at the turn end"
    );
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_sidecar_that_dies_while_awaiting_ends_the_wait_with_the_held_run_terminal() {
    let mut harness = Harness::new();
    harness
        .fixture
        .background("live provider-turn provider-turn-hold provider-sidecar-exit-after-arm");
    let first = complete_turn_accepting_provider_turns(&mut harness, "first");
    let events = drain_until(&mut harness, first, "run.terminal");
    let terminals = events
        .iter()
        .filter(|event| event["type"] == "run.terminal")
        .collect::<Vec<_>>();
    assert_eq!(terminals.len(), 1);
    assert_eq!(
        terminals[0]["payload"]["turnTerminalState"],
        json!("completed")
    );
    assert!(!events.iter().any(|event| event["type"] == "turn.failed"));
    let _ = harness.executor.shutdown();
}
