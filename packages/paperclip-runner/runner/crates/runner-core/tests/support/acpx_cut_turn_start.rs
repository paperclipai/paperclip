//! A `turn.start` cut off between the Runner's request and the sidecar's
//! reply (a frozen or killed sidecar, a timeout). The sidecar's dispatch
//! journal decides whether the prompt could have reached the provider.

use super::*;

const JOURNAL: &str = "paperclip-turn-dispatch.jsonl";

fn journal_phases(harness: &Harness) -> Vec<String> {
    fs::read_to_string(harness.fixture.0.join(JOURNAL))
        .unwrap_or_default()
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap()["phase"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn kill(pid: &Value) {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
}

/// Starts `turn` against a sidecar that freezes at `fault`, then kills the
/// sidecar once the journal shows `phases`, and returns the start's error.
fn cut_turn_start(harness: &mut Harness, turn: &str, fault: &str, phases: &[&str]) -> String {
    harness.fixture.fault(fault);
    let sidecar = harness.fixture.process_starts().last().unwrap()["processStart"].clone();
    let root = harness.fixture.0.clone();
    let expected = phases
        .iter()
        .map(|phase| phase.to_string())
        .collect::<Vec<_>>();
    let killer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen = fs::read_to_string(root.join(JOURNAL))
                .unwrap_or_default()
                .lines()
                .map(|line| {
                    serde_json::from_str::<Value>(line).unwrap()["phase"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
                .collect::<Vec<_>>();
            if seen == expected {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the sidecar never reached {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        kill(&sidecar);
    });
    harness.sequence += 1;
    let error = harness
        .executor
        .execute(&command(
            harness.sequence,
            "turn.start",
            json!({"turnId": turn, "text": "Write the brief."}),
        ))
        .unwrap_err()
        .to_string();
    killer.join().unwrap();
    harness.fixture.fault("");
    error
}

#[test]
fn a_start_cut_off_before_the_prompt_left_reopens_and_sends_the_prompt_once() {
    let mut harness = Harness::new();
    let error = cut_turn_start(&mut harness, "cut", "hang-before-dispatch", &["received"]);
    assert!(
        error.contains("before its prompt reached the provider"),
        "{error}"
    );
    let saved = harness.fixture.state();
    assert_eq!(saved["lifecycle"], "prepared", "{saved}");
    assert_eq!(saved["activeTurnId"], Value::Null);
    assert_eq!(saved["providerExitUnconfirmed"], false);
    // The run's next start reopens the conversation and delivers its prompt.
    let before = harness.fixture.journal().len();
    let events = harness.complete_turn("resent");
    assert!(
        events.iter().all(|event| event["type"] != "turn.failed"),
        "{events:?}"
    );
    let starts = harness.fixture.journal()[before..]
        .iter()
        .filter(|line| line["command"] == "turn.start")
        .map(|line| line["params"]["turnId"].clone())
        .collect::<Vec<_>>();
    assert_eq!(starts, [json!("resent")]);
    assert_eq!(journal_phases(&harness), ["received", "dispatched"]);
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_start_cut_off_after_the_prompt_left_stays_closed_and_never_resends() {
    let mut harness = Harness::new();
    let error = cut_turn_start(
        &mut harness,
        "cut",
        "hang-after-dispatch",
        &["received", "dispatched"],
    );
    assert!(error.contains("failed closed"), "{error}");
    assert_eq!(harness.fixture.state()["lifecycle"], "closed");
    let starts = harness.fixture.process_starts().len();
    harness.sequence += 1;
    let refused = harness
        .executor
        .execute(&command(
            harness.sequence,
            "turn.start",
            json!({"turnId": "resent", "text": "Write the brief."}),
        ))
        .unwrap_err()
        .to_string();
    assert_eq!(refused, "ACPX session is not open");
    assert_eq!(harness.fixture.process_starts().len(), starts);
}

/// The Runner itself dies while the session is saved `turn_starting`.
fn restore_cut_runner(harness: &mut Harness, phases: &[&str]) -> Vec<Value> {
    let mut saved = harness.fixture.state();
    harness.executor.shutdown().unwrap();
    saved["lifecycle"] = json!("turn_starting");
    saved["activeTurnId"] = json!("cut");
    fs::write(
        harness.fixture.0.join("acpx-provider-state.json"),
        serde_json::to_vec_pretty(&saved).unwrap(),
    )
    .unwrap();
    let journal = phases
        .iter()
        .map(|phase| {
            format!(
                "{}\n",
                json!({"schema":"paperclip.acpx-turn-dispatch.v1","turnId":"cut","phase":phase})
            )
        })
        .collect::<String>();
    let path = harness.fixture.0.join(JOURNAL);
    let _ = fs::remove_file(&path);
    if !phases.is_empty() {
        fs::write(&path, journal).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    harness.executor =
        NativeProviderCommandExecutor::with_runner_config(&harness.fixture.0, &harness.config);
    harness.sequence += 1;
    let snapshot = harness
        .executor
        .execute(&command(harness.sequence, "session.snapshot", json!({})))
        .unwrap();
    let mut events = snapshot
        .events
        .iter()
        .map(|(kind, _, payload)| json!({"type":kind,"payload":payload}))
        .collect::<Vec<_>>();
    events.extend(harness.drain());
    events
}

#[test]
fn a_runner_killed_before_the_prompt_left_restores_an_idle_session() {
    let mut harness = Harness::new();
    let events = restore_cut_runner(&mut harness, &["received"]);
    let kinds = events
        .iter()
        .map(|event| event["type"].clone())
        .collect::<Vec<_>>();
    assert!(kinds.contains(&json!("session.resumed")), "{events:?}");
    assert!(!kinds.contains(&json!("turn.failed")), "{events:?}");
    let saved = harness.fixture.state();
    assert_eq!(saved["lifecycle"], "session_open");
    assert_eq!(saved["activeTurnId"], Value::Null);
    harness.complete_turn("resent");
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_runner_killed_after_the_prompt_left_or_without_a_journal_reports_the_lost_turn() {
    for phases in [&["received", "dispatched"][..], &[][..]] {
        let mut harness = Harness::new();
        let events = restore_cut_runner(&mut harness, phases);
        let lost = events
            .iter()
            .find(|event| event["type"] == "turn.failed")
            .unwrap_or_else(|| panic!("{phases:?}: {events:?}"));
        assert_eq!(lost["payload"]["code"], "provider_turn_lost_on_restore");
        harness.executor.shutdown().unwrap();
    }
}
