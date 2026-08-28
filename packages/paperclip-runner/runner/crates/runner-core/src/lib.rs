#![forbid(unsafe_code)]

pub mod acpx_event_payload;
pub mod acpx_event_scope;
pub mod acpx_provider_session;
pub mod acpx_provider_state;
pub mod acpx_sidecar_transport;
pub mod codex_provider;
pub mod durable;
pub mod fake_harness;
pub mod generated_acpx_sidecar_contract;
pub mod local_runner;
pub mod process_supervisor;
pub mod provider_backend;
pub mod provider_bridge;
pub mod provider_events;
pub mod replay;

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::{Deserialize, Serialize};

pub const CONFORMANCE_FIXTURE_SCHEMA: &str = "paperclip.runner.conformance.fixture.v1";
pub const CONFORMANCE_OUTPUT_SCHEMA: &str = "paperclip.runner.conformance.output.v1";
pub const CONFORMANCE_FIXTURE: &str =
    include_str!("../../../../protocol/fixtures/conformance-minimal-run.json");
pub const CONFORMANCE_EXPECTED_OUTPUT: &str =
    include_str!("../../../../protocol/fixtures/conformance-expected-output.json");

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
pub struct ConformanceFixture {
    pub schema_version: String,
    pub run: NativeRunIdentity,
    pub events: Vec<NativeRunEvent>,
    pub result: NativeRunResult,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConformanceError(String);

impl ConformanceError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for ConformanceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ConformanceError {}

fn validate_identifier(value: &str, path: &str) -> Result<(), ConformanceError> {
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
        Err(ConformanceError::invalid(format!(
            "{path} must be a stable lowercase identifier"
        )))
    }
}

pub fn validate_conformance_fixture(input: &str) -> Result<ConformanceFixture, ConformanceError> {
    let fixture: ConformanceFixture = serde_json::from_str(input).map_err(|error| {
        ConformanceError::invalid(format!("fixture must be valid JSON: {error}"))
    })?;

    if fixture.schema_version != CONFORMANCE_FIXTURE_SCHEMA {
        return Err(ConformanceError::invalid(format!(
            "schemaVersion must be {CONFORMANCE_FIXTURE_SCHEMA}"
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
        return Err(ConformanceError::invalid(
            "events must contain at least run.started and run.completed",
        ));
    }

    for (index, event) in fixture.events.iter().enumerate() {
        validate_identifier(&event.event_id, &format!("events[{index}].eventId"))?;
        if event.run_id != fixture.run.run_id {
            return Err(ConformanceError::invalid(format!(
                "events[{index}].runId must match run.runId"
            )));
        }
        let expected_sequence = index as u64 + 1;
        if event.sequence != expected_sequence {
            return Err(ConformanceError::invalid(format!(
                "events[{index}].sequence must be {expected_sequence}"
            )));
        }
        if !matches!(event.event_type.as_str(), "run.started" | "run.completed") {
            return Err(ConformanceError::invalid(format!(
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
        return Err(ConformanceError::invalid(
            "the first event must be run.started",
        ));
    }
    if fixture.events.last().map(|event| event.event_type.as_str()) != Some("run.completed") {
        return Err(ConformanceError::invalid(
            "the final event must be run.completed",
        ));
    }
    if fixture.result.run_id != fixture.run.run_id {
        return Err(ConformanceError::invalid(
            "result.runId must match run.runId",
        ));
    }
    if fixture.result.status != "succeeded" {
        return Err(ConformanceError::invalid(
            "the Conformance fixture result must be succeeded",
        ));
    }
    if fixture.result.summary.trim().is_empty() {
        return Err(ConformanceError::invalid(
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
    pub fn start(&mut self) -> Result<(), ConformanceError> {
        if self.running {
            return Err(ConformanceError::invalid(
                "mock control plane is already running",
            ));
        }
        self.running = true;
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn open_run(&mut self, identity: &NativeRunIdentity) -> Result<(), ConformanceError> {
        self.require_running()?;
        if self.opened_run_id.is_some() {
            return Err(ConformanceError::invalid(
                "mock control plane accepts one Conformance run",
            ));
        }
        self.opened_run_id = Some(identity.run_id.clone());
        Ok(())
    }

    pub fn append_event(&mut self, event: &NativeRunEvent) -> Result<u64, ConformanceError> {
        let run_id = self.require_run_id()?;
        if event.run_id != run_id {
            return Err(ConformanceError::invalid(
                "event runId does not match the opened run",
            ));
        }
        let expected_sequence = self.events.len() as u64 + 1;
        if event.sequence != expected_sequence {
            return Err(ConformanceError::invalid(format!(
                "event sequence must be {expected_sequence}"
            )));
        }
        self.events.push(event.clone());
        Ok(event.sequence)
    }

    pub fn complete_run(&mut self, result: &NativeRunResult) -> Result<(), ConformanceError> {
        let run_id = self.require_run_id()?;
        if result.run_id != run_id {
            return Err(ConformanceError::invalid(
                "result runId does not match the opened run",
            ));
        }
        if self.events.last().map(|event| event.event_type.as_str()) != Some("run.completed") {
            return Err(ConformanceError::invalid(
                "run.completed must be ingested before the result",
            ));
        }
        if self.result.is_some() {
            return Err(ConformanceError::invalid(
                "mock control plane accepts one terminal result",
            ));
        }
        self.result = Some(result.clone());
        Ok(())
    }

    fn require_running(&self) -> Result<(), ConformanceError> {
        if self.running {
            Ok(())
        } else {
            Err(ConformanceError::invalid(
                "mock control plane must be started first",
            ))
        }
    }

    fn require_run_id(&self) -> Result<&str, ConformanceError> {
        self.require_running()?;
        self.opened_run_id
            .as_deref()
            .ok_or_else(|| ConformanceError::invalid("a run must be opened first"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConformanceTracerOutput<'a> {
    schema_version: &'static str,
    run_identity: ConformanceRunIdentityOutput<'a>,
    result: ConformanceResultOutput<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConformanceRunIdentityOutput<'a> {
    run_id: &'a str,
    session_id: &'a str,
}

#[derive(Serialize)]
struct ConformanceResultOutput<'a> {
    status: &'a str,
    summary: &'a str,
}

pub fn run_conformance_tracer(input: &str) -> Result<String, ConformanceError> {
    let fixture = validate_conformance_fixture(input)?;
    let mut mock_core = MockControlPlane::default();
    mock_core.start()?;

    let replay_result = (|| {
        mock_core.open_run(&fixture.run)?;
        for event in &fixture.events {
            mock_core.append_event(event)?;
        }
        mock_core.complete_run(&fixture.result)?;
        serde_json::to_string(&ConformanceTracerOutput {
            schema_version: CONFORMANCE_OUTPUT_SCHEMA,
            run_identity: ConformanceRunIdentityOutput {
                run_id: &fixture.run.run_id,
                session_id: &fixture.run.session_id,
            },
            result: ConformanceResultOutput {
                status: &fixture.result.status,
                summary: &fixture.result.summary,
            },
        })
        .map_err(|error| ConformanceError::invalid(format!("output serialization failed: {error}")))
    })();

    mock_core.stop();
    replay_result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_the_shared_fixture() {
        let fixture = validate_conformance_fixture(CONFORMANCE_FIXTURE)
            .expect("shared fixture should validate");

        assert_eq!(fixture.events.len(), 2);
        assert_eq!(fixture.events[1].sequence, 2);
        assert_eq!(fixture.result.status, "succeeded");
    }

    #[test]
    fn rejects_a_sequence_gap() {
        let invalid = CONFORMANCE_FIXTURE.replacen(r#""sequence": 2"#, r#""sequence": 3"#, 1);

        let error = validate_conformance_fixture(&invalid).expect_err("sequence gap must fail");
        assert_eq!(error.to_string(), "events[1].sequence must be 2");
    }

    #[test]
    fn runs_the_mock_core_path_with_stable_output() {
        assert_eq!(
            run_conformance_tracer(CONFORMANCE_FIXTURE).expect("tracer should succeed"),
            CONFORMANCE_EXPECTED_OUTPUT.trim_end(),
        );
    }
}
