use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRP_PROTOCOL_VERSION: u64 = 1;
const PRP_FIXTURE_VERSION: u64 = 1;
const PRP_FIXTURE_SCHEMA: &str = "paperclip.prp.fixture.v1";
const PRP_EVENT_SCHEMA: &str = "paperclip.prp.event.v1";
const PRP_SEMANTIC_TOOL_SCHEMA: &str = "paperclip.prp.semantic_tool.v1";
const PRP_STOP_REASON_SCHEMA: &str = "paperclip.prp.stop_reason.v1";
const PRP_SEMANTIC_TOOLS_CAPABILITY_SCHEMA: &str = "paperclip.prp.semantic_tools.v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayFixture {
    schema: String,
    fixture_version: u64,
    protocol_version: u64,
    identity: ReplayIdentity,
    capabilities: Value,
    events: Vec<ReplayEvent>,
    result: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplayIdentity {
    run_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ReplayEvent {
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
pub struct ReplaySequenceGap {
    source_key: String,
    expected: u64,
    received: u64,
    missing: Vec<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayParitySummary {
    run_id: String,
    integrity: String,
    timeline_count: usize,
    duplicate_event_ids: Vec<String>,
    gaps: Vec<ReplaySequenceGap>,
    turn_terminal_state: Option<String>,
    run_terminal_state: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayError(String);

impl ReplayError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ReplayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ReplayError {}

pub fn reduce_replay_fixture(input: &str) -> Result<ReplayParitySummary, ReplayError> {
    let fixture: ReplayFixture = serde_json::from_str(input)
        .map_err(|error| ReplayError::invalid(format!("fixture must be valid JSON: {error}")))?;
    if fixture.protocol_version != PRP_PROTOCOL_VERSION {
        return Err(ReplayError::invalid(format!(
            "unsupported required protocolVersion {}; expected {PRP_PROTOCOL_VERSION}",
            fixture.protocol_version
        )));
    }
    if fixture.fixture_version != PRP_FIXTURE_VERSION {
        return Err(ReplayError::invalid(format!(
            "unsupported required fixtureVersion {}; expected {PRP_FIXTURE_VERSION}",
            fixture.fixture_version
        )));
    }
    if fixture.schema != PRP_FIXTURE_SCHEMA {
        return Err(ReplayError::invalid(format!(
            "unsupported required fixture schema {}; expected {PRP_FIXTURE_SCHEMA}",
            fixture.schema
        )));
    }
    validate_optional_versioned_envelope(
        fixture.capabilities.get("semanticTools"),
        PRP_SEMANTIC_TOOLS_CAPABILITY_SCHEMA,
        "semanticTools",
    )?;

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

    let mut seen = HashMap::<&str, &ReplayEvent>::new();
    let mut cursors = HashMap::<String, u64>::new();
    let mut gaps = Vec::<ReplaySequenceGap>::new();
    let mut timeline_count = 0_usize;
    let mut turn_terminal_state = None;
    let mut run_terminal_state = None;
    let mut proposed_result_count = 0_usize;
    let mut terminal_count = 0_usize;

    for event in &fixture.events {
        if event.schema != PRP_EVENT_SCHEMA {
            return Err(ReplayError::invalid(format!(
                "unsupported required event schema {}; expected {PRP_EVENT_SCHEMA}",
                event.schema
            )));
        }
        if event.schema_version != 1 {
            return Err(ReplayError::invalid(format!(
                "unsupported required event schemaVersion {}; expected 1",
                event.schema_version
            )));
        }
        validate_optional_versioned_envelope(
            event.payload.get("semantic_tool"),
            PRP_SEMANTIC_TOOL_SCHEMA,
            "semantic_tool",
        )?;
        validate_optional_versioned_envelope(
            event.payload.get("stopReason"),
            PRP_STOP_REASON_SCHEMA,
            "stopReason",
        )?;
        if event.run_id != fixture.identity.run_id {
            return Err(ReplayError::invalid(
                "event runId must match identity.runId",
            ));
        }
        if let Some(previous) = seen.get(event.source_event_id.as_str()) {
            if *previous != event {
                return Err(ReplayError::invalid(
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
            gaps.push(ReplaySequenceGap {
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
                    return Err(ReplayError::invalid(
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
        return Err(ReplayError::invalid(
            "scripted fixtures must contain exactly one unique run.result.proposed event",
        ));
    }
    if terminal_count != 1 {
        return Err(ReplayError::invalid(
            "scripted fixtures must contain exactly one unique run.terminal event",
        ));
    }

    Ok(ReplayParitySummary {
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

fn validate_optional_versioned_envelope(
    envelope: Option<&Value>,
    expected_schema: &str,
    field: &str,
) -> Result<(), ReplayError> {
    let Some(envelope) = envelope else {
        return Ok(());
    };
    let schema = envelope
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    if schema != expected_schema {
        return Err(ReplayError::invalid(format!(
            "unsupported required {field} schema {schema}; expected {expected_schema}"
        )));
    }
    let version = envelope
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version != 1 {
        return Err(ReplayError::invalid(format!(
            "unsupported required {field} schemaVersion {version}; expected 1"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{reduce_replay_fixture, ReplayParitySummary};
    use serde_json::Value;

    fn assert_fixture_parity(fixture: &str, expected: &str) {
        let actual = reduce_replay_fixture(fixture).expect("fixture should reduce");
        let expected: ReplayParitySummary =
            serde_json::from_str(expected).expect("golden summary should parse");
        assert_eq!(actual, expected);
    }

    macro_rules! parity_case {
        ($name:ident, $fixture:literal, $golden:literal) => {
            #[test]
            fn $name() {
                assert_fixture_parity(
                    include_str!(concat!(
                        "../../../../protocol/fixtures/replay/",
                        $fixture,
                        ".json"
                    )),
                    include_str!(concat!(
                        "../../../../protocol/fixtures/replay/golden/",
                        $golden,
                        ".summary.json"
                    )),
                );
            }
        };
    }

    parity_case!(replay_fixture_parity_happy_path, "happy-path", "happy-path");
    parity_case!(replay_fixture_parity_failed_run, "failed-run", "failed-run");
    parity_case!(
        replay_fixture_parity_interrupted_run,
        "interrupted-run",
        "interrupted-run"
    );
    parity_case!(
        replay_fixture_parity_duplicate_event,
        "duplicate-event",
        "duplicate-event"
    );
    parity_case!(replay_fixture_parity_source_gap, "source-gap", "source-gap");
    parity_case!(
        replay_fixture_parity_unknown_optional_fields,
        "unknown-optional-fields",
        "unknown-optional-fields"
    );
    parity_case!(
        replay_fixture_parity_semantic_tool_artifact_happy_path,
        "semantic-tool-artifact-happy-path",
        "semantic-tool-artifact-happy-path"
    );
    parity_case!(
        replay_fixture_parity_semantic_tool_denial_redaction,
        "semantic-tool-denial-redaction",
        "semantic-tool-denial-redaction"
    );
    parity_case!(
        replay_fixture_parity_semantic_tool_conflict_duplicate_retry,
        "semantic-tool-conflict-duplicate-retry",
        "semantic-tool-conflict-duplicate-retry"
    );
    parity_case!(
        replay_fixture_parity_semantic_tool_governance_wake_monitor,
        "semantic-tool-governance-wake-monitor",
        "semantic-tool-governance-wake-monitor"
    );
    parity_case!(
        replay_fixture_parity_budget_cost_stop_reason,
        "budget-cost-stop-reason",
        "budget-cost-stop-reason"
    );
    parity_case!(
        replay_fixture_parity_semantic_tool_unknown_optional_envelope,
        "semantic-tool-unknown-optional-envelope",
        "semantic-tool-unknown-optional-envelope"
    );

    #[test]
    fn replay_fixture_parity_rejects_unsupported_required_version() {
        let error = reduce_replay_fixture(include_str!(
            "../../../../protocol/fixtures/replay/unsupported-required-version.json"
        ))
        .expect_err("PRP v2 fixture must fail closed");
        assert!(error
            .to_string()
            .contains("unsupported required protocolVersion 2"));
    }

    #[test]
    fn replay_fixture_parity_rejects_unsupported_semantic_tool_version() {
        let error = reduce_replay_fixture(include_str!(
            "../../../../protocol/fixtures/replay/semantic-tool-unsupported-required-version.json"
        ))
        .expect_err("semantic_tool v2 fixture must fail closed");
        assert!(error
            .to_string()
            .contains("unsupported required semantic_tool schema paperclip.prp.semantic_tool.v2"));
    }

    #[test]
    fn replay_fixture_parity_rejects_unsupported_fixture_version() {
        let fixture = include_str!("../../../../protocol/fixtures/replay/happy-path.json")
            .replace("\"fixtureVersion\": 1", "\"fixtureVersion\": 2");
        let error =
            reduce_replay_fixture(&fixture).expect_err("fixture version 2 must fail closed");
        assert!(error
            .to_string()
            .contains("unsupported required fixtureVersion 2"));
    }

    #[test]
    fn replay_fixture_parity_rejects_a_mismatched_declared_result() {
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../../../protocol/fixtures/replay/happy-path.json"
        ))
        .expect("fixture should parse");
        fixture["result"]["summary"] = Value::String("Contradictory result".to_owned());
        let error = reduce_replay_fixture(&fixture.to_string())
            .expect_err("mismatched result must fail closed");
        assert!(error
            .to_string()
            .contains("fixture result must match the run.result.proposed event payload"));
    }
}
