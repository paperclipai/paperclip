use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRP_PROTOCOL_VERSION: u64 = 1;
const PRP_FIXTURE_VERSION: u64 = 1;
const PRP_FIXTURE_SCHEMA: &str = "paperclip.prp.fixture.v1";
const PRP_EVENT_SCHEMA: &str = "paperclip.prp.event.v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Phase1Fixture {
    schema: String,
    fixture_version: u64,
    protocol_version: u64,
    identity: Phase1Identity,
    events: Vec<Phase1Event>,
    result: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Phase1Identity {
    run_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Phase1Event {
    schema: String,
    source_event_id: String,
    source_seq: u64,
    source_instance_id: String,
    source_kind: String,
    run_id: String,
    schema_version: u64,
    event_type: String,
    payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase1SequenceGap {
    source_key: String,
    expected: u64,
    received: u64,
    missing: Vec<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Phase1ParitySummary {
    run_id: String,
    integrity: String,
    timeline_count: usize,
    duplicate_event_ids: Vec<String>,
    gaps: Vec<Phase1SequenceGap>,
    turn_terminal_state: Option<String>,
    run_terminal_state: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase1Error(String);

impl Phase1Error {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for Phase1Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Phase1Error {}

pub fn reduce_phase1_fixture(input: &str) -> Result<Phase1ParitySummary, Phase1Error> {
    let fixture: Phase1Fixture = serde_json::from_str(input)
        .map_err(|error| Phase1Error::invalid(format!("fixture must be valid JSON: {error}")))?;
    if fixture.protocol_version != PRP_PROTOCOL_VERSION {
        return Err(Phase1Error::invalid(format!(
            "unsupported required protocolVersion {}; expected {PRP_PROTOCOL_VERSION}",
            fixture.protocol_version
        )));
    }
    if fixture.fixture_version != PRP_FIXTURE_VERSION {
        return Err(Phase1Error::invalid(format!(
            "unsupported required fixtureVersion {}; expected {PRP_FIXTURE_VERSION}",
            fixture.fixture_version
        )));
    }
    if fixture.schema != PRP_FIXTURE_SCHEMA {
        return Err(Phase1Error::invalid(format!(
            "unsupported required fixture schema {}; expected {PRP_FIXTURE_SCHEMA}",
            fixture.schema
        )));
    }

    let mut delivery_counts = HashMap::<&str, usize>::new();
    for event in &fixture.events {
        *delivery_counts
            .entry(event.source_event_id.as_str())
            .or_default() += 1;
    }
    let mut duplicate_event_ids = delivery_counts
        .into_iter()
        .filter_map(|(event_id, count)| (count > 1).then(|| event_id.to_owned()))
        .collect::<Vec<_>>();
    duplicate_event_ids.sort();

    let mut seen = HashMap::<&str, &Phase1Event>::new();
    let mut cursors = HashMap::<String, u64>::new();
    let mut gaps = Vec::<Phase1SequenceGap>::new();
    let mut timeline_count = 0_usize;
    let mut turn_terminal_state = None;
    let mut run_terminal_state = None;
    let mut proposed_result_count = 0_usize;
    let mut terminal_count = 0_usize;

    for event in &fixture.events {
        if event.schema != PRP_EVENT_SCHEMA {
            return Err(Phase1Error::invalid(format!(
                "unsupported required event schema {}; expected {PRP_EVENT_SCHEMA}",
                event.schema
            )));
        }
        if event.schema_version != 1 {
            return Err(Phase1Error::invalid(format!(
                "unsupported required event schemaVersion {}; expected 1",
                event.schema_version
            )));
        }
        if event.run_id != fixture.identity.run_id {
            return Err(Phase1Error::invalid(
                "event runId must match identity.runId",
            ));
        }
        if let Some(previous) = seen.get(event.source_event_id.as_str()) {
            if *previous != event {
                return Err(Phase1Error::invalid(
                    "duplicate sourceEventId deliveries must be byte-equivalent",
                ));
            }
            continue;
        }
        seen.insert(event.source_event_id.as_str(), event);

        let key = format!("{}:{}", event.source_kind, event.source_instance_id);
        let cursor = *cursors.get(&key).unwrap_or(&0);
        let expected = cursor + 1;
        if event.source_seq <= cursor {
            continue;
        }
        if event.source_seq > expected {
            gaps.push(Phase1SequenceGap {
                source_key: key.clone(),
                expected,
                received: event.source_seq,
                missing: (expected..event.source_seq).collect(),
            });
        }
        cursors.insert(key, event.source_seq);
        timeline_count += 1;

        match event.event_type.as_str() {
            "run.result.proposed" => {
                proposed_result_count += 1;
                if event.payload != fixture.result {
                    return Err(Phase1Error::invalid(
                        "fixture result must match the run.result.proposed event payload",
                    ));
                }
            }
            "run.terminal" => {
                terminal_count += 1;
                turn_terminal_state = event
                    .payload
                    .get("turnTerminalState")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                run_terminal_state = event
                    .payload
                    .get("runTerminalState")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            _ => {}
        }
    }

    if proposed_result_count != 1 {
        return Err(Phase1Error::invalid(
            "scripted fixtures must contain exactly one unique run.result.proposed event",
        ));
    }
    if terminal_count != 1 {
        return Err(Phase1Error::invalid(
            "scripted fixtures must contain exactly one unique run.terminal event",
        ));
    }

    Ok(Phase1ParitySummary {
        run_id: fixture.identity.run_id,
        integrity: if gaps.is_empty() {
            "complete".to_owned()
        } else {
            "gap_detected".to_owned()
        },
        timeline_count,
        duplicate_event_ids,
        gaps,
        turn_terminal_state,
        run_terminal_state,
    })
}

#[cfg(test)]
mod tests {
    use super::{reduce_phase1_fixture, Phase1ParitySummary};
    use serde_json::Value;

    fn assert_fixture_parity(fixture: &str, expected: &str) {
        let actual = reduce_phase1_fixture(fixture).expect("fixture should reduce");
        let expected: Phase1ParitySummary =
            serde_json::from_str(expected).expect("golden summary should parse");
        assert_eq!(actual, expected);
    }

    macro_rules! parity_case {
        ($name:ident, $fixture:literal, $golden:literal) => {
            #[test]
            fn $name() {
                assert_fixture_parity(
                    include_str!(concat!(
                        "../../../../protocol/fixtures/phase-01/",
                        $fixture,
                        ".json"
                    )),
                    include_str!(concat!(
                        "../../../../protocol/fixtures/phase-01/golden/",
                        $golden,
                        ".summary.json"
                    )),
                );
            }
        };
    }

    parity_case!(phase1_fixture_parity_happy_path, "happy-path", "happy-path");
    parity_case!(phase1_fixture_parity_failed_run, "failed-run", "failed-run");
    parity_case!(
        phase1_fixture_parity_interrupted_run,
        "interrupted-run",
        "interrupted-run"
    );
    parity_case!(
        phase1_fixture_parity_duplicate_event,
        "duplicate-event",
        "duplicate-event"
    );
    parity_case!(phase1_fixture_parity_source_gap, "source-gap", "source-gap");
    parity_case!(
        phase1_fixture_parity_unknown_optional_fields,
        "unknown-optional-fields",
        "unknown-optional-fields"
    );

    #[test]
    fn phase1_fixture_parity_rejects_unsupported_required_version() {
        let error = reduce_phase1_fixture(include_str!(
            "../../../../protocol/fixtures/phase-01/unsupported-required-version.json"
        ))
        .expect_err("PRP v2 fixture must fail closed");
        assert!(error
            .to_string()
            .contains("unsupported required protocolVersion 2"));
    }

    #[test]
    fn phase1_fixture_parity_rejects_unsupported_fixture_version() {
        let fixture = include_str!("../../../../protocol/fixtures/phase-01/happy-path.json")
            .replace("\"fixtureVersion\": 1", "\"fixtureVersion\": 2");
        let error =
            reduce_phase1_fixture(&fixture).expect_err("fixture version 2 must fail closed");
        assert!(error
            .to_string()
            .contains("unsupported required fixtureVersion 2"));
    }

    #[test]
    fn phase1_fixture_parity_rejects_a_mismatched_declared_result() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/phase-01/happy-path.json"
        ))
        .expect("fixture should parse");
        fixture["result"]["summary"] = Value::String("Contradictory result".to_owned());
        let error = reduce_phase1_fixture(&fixture.to_string())
            .expect_err("mismatched result must fail closed");
        assert!(error
            .to_string()
            .contains("fixture result must match the run.result.proposed event payload"));
    }
}
