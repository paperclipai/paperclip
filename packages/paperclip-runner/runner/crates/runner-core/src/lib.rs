#![forbid(unsafe_code)]

pub mod phase1;
pub mod phase2;
pub mod phase3;

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};

pub const PHASE0_FIXTURE_SCHEMA: &str = "paperclip.runner.phase0.fixture.v1";
pub const PHASE0_OUTPUT_SCHEMA: &str = "paperclip.runner.phase0.output.v1";
pub const PHASE0_FIXTURE: &str =
    include_str!("../../../../protocol/fixtures/phase-00-minimal-run.json");
pub const PHASE0_EXPECTED_OUTPUT: &str =
    include_str!("../../../../protocol/fixtures/phase-00-expected-output.json");

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunIdentity {
    pub run_id: String,
    pub session_id: String,
    pub company_id: String,
    pub issue_id: String,
    pub agent_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunEvent {
    pub event_id: String,
    pub run_id: String,
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunResult {
    pub run_id: String,
    pub status: String,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Phase0Fixture {
    pub schema_version: String,
    pub run: NativeRunIdentity,
    pub events: Vec<NativeRunEvent>,
    pub result: NativeRunResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase0Error(String);

impl Phase0Error {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for Phase0Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Phase0Error {}

fn validate_identifier(value: &str, path: &str) -> Result<(), Phase0Error> {
    let mut characters = value.chars();
    let starts_lowercase = characters
        .next()
        .is_some_and(|character| character.is_ascii_lowercase());
    let remainder_is_valid = characters.all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    });

    if starts_lowercase && remainder_is_valid {
        Ok(())
    } else {
        Err(Phase0Error::invalid(format!(
            "{path} must be a stable lowercase identifier"
        )))
    }
}

pub fn validate_phase0_fixture(input: &str) -> Result<Phase0Fixture, Phase0Error> {
    let fixture: Phase0Fixture = serde_json::from_str(input)
        .map_err(|error| Phase0Error::invalid(format!("fixture must be valid JSON: {error}")))?;

    if fixture.schema_version != PHASE0_FIXTURE_SCHEMA {
        return Err(Phase0Error::invalid(format!(
            "schemaVersion must be {PHASE0_FIXTURE_SCHEMA}"
        )));
    }

    for (path, value) in [
        ("run.runId", fixture.run.run_id.as_str()),
        ("run.sessionId", fixture.run.session_id.as_str()),
        ("run.companyId", fixture.run.company_id.as_str()),
        ("run.issueId", fixture.run.issue_id.as_str()),
        ("run.agentId", fixture.run.agent_id.as_str()),
    ] {
        validate_identifier(value, path)?;
    }

    if fixture.events.len() < 2 {
        return Err(Phase0Error::invalid(
            "events must contain at least run.started and run.completed",
        ));
    }

    for (index, event) in fixture.events.iter().enumerate() {
        validate_identifier(&event.event_id, &format!("events[{index}].eventId"))?;
        if event.run_id != fixture.run.run_id {
            return Err(Phase0Error::invalid(format!(
                "events[{index}].runId must match run.runId"
            )));
        }
        let expected_sequence = index as u64 + 1;
        if event.sequence != expected_sequence {
            return Err(Phase0Error::invalid(format!(
                "events[{index}].sequence must be {expected_sequence}"
            )));
        }
        if !matches!(event.event_type.as_str(), "run.started" | "run.completed") {
            return Err(Phase0Error::invalid(format!(
                "events[{index}].type is unsupported"
            )));
        }
    }

    if fixture
        .events
        .first()
        .map(|event| event.event_type.as_str())
        != Some("run.started")
    {
        return Err(Phase0Error::invalid("the first event must be run.started"));
    }
    if fixture.events.last().map(|event| event.event_type.as_str()) != Some("run.completed") {
        return Err(Phase0Error::invalid(
            "the final event must be run.completed",
        ));
    }
    if fixture.result.run_id != fixture.run.run_id {
        return Err(Phase0Error::invalid("result.runId must match run.runId"));
    }
    if fixture.result.status != "succeeded" {
        return Err(Phase0Error::invalid(
            "the Phase 0 fixture result must be succeeded",
        ));
    }
    if fixture.result.summary.trim().is_empty() {
        return Err(Phase0Error::invalid(
            "result.summary must be a non-empty string",
        ));
    }

    Ok(fixture)
}

#[derive(Default)]
pub struct MockControlPlane {
    running: bool,
    opened_run_id: Option<String>,
    events: Vec<NativeRunEvent>,
    result: Option<NativeRunResult>,
}

impl MockControlPlane {
    pub fn start(&mut self) -> Result<(), Phase0Error> {
        if self.running {
            return Err(Phase0Error::invalid(
                "mock control plane is already running",
            ));
        }
        self.running = true;
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn open_run(&mut self, identity: &NativeRunIdentity) -> Result<(), Phase0Error> {
        self.require_running()?;
        if self.opened_run_id.is_some() {
            return Err(Phase0Error::invalid(
                "mock control plane accepts one Phase 0 run",
            ));
        }
        self.opened_run_id = Some(identity.run_id.clone());
        Ok(())
    }

    pub fn append_event(&mut self, event: &NativeRunEvent) -> Result<u64, Phase0Error> {
        let run_id = self.require_run_id()?;
        if event.run_id != run_id {
            return Err(Phase0Error::invalid(
                "event runId does not match the opened run",
            ));
        }
        let expected_sequence = self.events.len() as u64 + 1;
        if event.sequence != expected_sequence {
            return Err(Phase0Error::invalid(format!(
                "event sequence must be {expected_sequence}"
            )));
        }
        self.events.push(event.clone());
        Ok(event.sequence)
    }

    pub fn complete_run(&mut self, result: &NativeRunResult) -> Result<(), Phase0Error> {
        let run_id = self.require_run_id()?;
        if result.run_id != run_id {
            return Err(Phase0Error::invalid(
                "result runId does not match the opened run",
            ));
        }
        if self.events.last().map(|event| event.event_type.as_str()) != Some("run.completed") {
            return Err(Phase0Error::invalid(
                "run.completed must be ingested before the result",
            ));
        }
        if self.result.is_some() {
            return Err(Phase0Error::invalid(
                "mock control plane accepts one terminal result",
            ));
        }
        self.result = Some(result.clone());
        Ok(())
    }

    fn require_running(&self) -> Result<(), Phase0Error> {
        if self.running {
            Ok(())
        } else {
            Err(Phase0Error::invalid(
                "mock control plane must be started first",
            ))
        }
    }

    fn require_run_id(&self) -> Result<&str, Phase0Error> {
        self.require_running()?;
        self.opened_run_id
            .as_deref()
            .ok_or_else(|| Phase0Error::invalid("a run must be opened first"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Phase0TracerOutput<'a> {
    schema_version: &'static str,
    run_identity: Phase0RunIdentityOutput<'a>,
    result: Phase0ResultOutput<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Phase0RunIdentityOutput<'a> {
    run_id: &'a str,
    session_id: &'a str,
}

#[derive(Serialize)]
struct Phase0ResultOutput<'a> {
    status: &'a str,
    summary: &'a str,
}

pub fn run_phase0_tracer(input: &str) -> Result<String, Phase0Error> {
    let fixture = validate_phase0_fixture(input)?;
    let mut mock_core = MockControlPlane::default();
    mock_core.start()?;

    let replay_result = (|| {
        mock_core.open_run(&fixture.run)?;
        for event in &fixture.events {
            mock_core.append_event(event)?;
        }
        mock_core.complete_run(&fixture.result)?;
        serde_json::to_string(&Phase0TracerOutput {
            schema_version: PHASE0_OUTPUT_SCHEMA,
            run_identity: Phase0RunIdentityOutput {
                run_id: &fixture.run.run_id,
                session_id: &fixture.run.session_id,
            },
            result: Phase0ResultOutput {
                status: &fixture.result.status,
                summary: &fixture.result.summary,
            },
        })
        .map_err(|error| Phase0Error::invalid(format!("output serialization failed: {error}")))
    })();

    mock_core.stop();
    replay_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_shared_fixture() {
        let fixture =
            validate_phase0_fixture(PHASE0_FIXTURE).expect("shared fixture should validate");

        assert_eq!(fixture.events.len(), 2);
        assert_eq!(fixture.events[1].sequence, 2);
        assert_eq!(fixture.result.status, "succeeded");
    }

    #[test]
    fn rejects_a_sequence_gap() {
        let invalid = PHASE0_FIXTURE.replacen(r#""sequence": 2"#, r#""sequence": 3"#, 1);

        let error = validate_phase0_fixture(&invalid).expect_err("sequence gap must fail");
        assert_eq!(error.to_string(), "events[1].sequence must be 2");
    }

    #[test]
    fn runs_the_mock_core_path_with_stable_output() {
        assert_eq!(
            run_phase0_tracer(PHASE0_FIXTURE).expect("tracer should succeed"),
            PHASE0_EXPECTED_OUTPUT.trim_end(),
        );
    }
}
