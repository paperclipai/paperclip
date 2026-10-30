use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::generated_acpx_profiles::acpx_release_profile;
use crate::local_runner::LocalRunnerError;
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

const SCHEMA: &str = "paperclip.acpx-candidate-admission.v1";
const MAX_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DISTRIBUTIONS: &str = include_str!("../../../../antigravity-distributions.json");

/// Operator authority supplied only through trusted process startup. Company
/// membership is authorized by the server; an agent descriptor cannot mint it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpxCandidateAdmission {
    pub schema: String,
    pub company_id: String,
    pub agent: String,
    pub model: String,
    pub profile_digest: String,
    pub native_closure_digest: String,
    pub platform: String,
    pub architecture: String,
    pub expires_at: u64,
    pub run_id: String,
    pub normalized_session_id: String,
}

fn invalid() -> LocalRunnerError {
    LocalRunnerError::invalid(
        "ACPX candidate admission is missing, expired, or does not match the exact authorized execution",
    )
}

pub(crate) fn current_time_ms() -> Result<u64, LocalRunnerError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(invalid)
}

impl AcpxCandidateAdmission {
    pub fn parse_json(encoded: &str) -> Result<Self, LocalRunnerError> {
        if encoded.len() > 4_096 {
            return Err(invalid());
        }
        let admission: Self = serde_json::from_str(encoded).map_err(|_| invalid())?;
        admission.validate()?;
        Ok(admission)
    }

    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        self.validate_at(
            current_time_ms()?,
            std::env::consts::OS,
            std::env::consts::ARCH,
        )
    }

    fn validate_at(&self, now: u64, os: &str, architecture: &str) -> Result<(), LocalRunnerError> {
        let profile = acpx_release_profile("antigravity").ok_or_else(invalid)?;
        let manifest: Value = serde_json::from_str(DISTRIBUTIONS).map_err(|_| invalid())?;
        let closure = manifest
            .pointer("/platforms/darwin-arm64/closureSha256")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        if self.schema != SCHEMA
            || !is_stable_id(&self.company_id, DURABLE_STABLE_ID_CHARS)
            || self.agent != "antigravity"
            || self.model.trim().is_empty()
            || self.model != self.model.trim()
            || self.model.len() > 512
            || self.model.chars().any(char::is_control)
            || matches!(self.model.to_ascii_lowercase().as_str(), "auto" | "default")
            || self.profile_digest != profile.command_digest
            || self.native_closure_digest != format!("sha256:{closure}")
            || self.platform != "darwin"
            || self.architecture != "arm64"
            || os != "macos"
            || architecture != "aarch64"
            || self.expires_at > MAX_JSON_SAFE_INTEGER
            || self.expires_at <= now
            || self.expires_at > now.saturating_add(MAX_LIFETIME_MS)
            || !is_stable_id(&self.run_id, SHORT_STABLE_ID_CHARS)
            || !is_stable_id(&self.normalized_session_id, SHORT_STABLE_ID_CHARS)
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub fn validate_binding(
        &self,
        agent: &str,
        model: &str,
        run_id: &str,
        normalized_session_id: &str,
    ) -> Result<(), LocalRunnerError> {
        self.validate()?;
        if self.agent != agent
            || self.model != model
            || self.run_id != run_id
            || self.normalized_session_id != normalized_session_id
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn test_admission(run_id: &str, session_id: &str) -> AcpxCandidateAdmission {
    let manifest: Value = serde_json::from_str(DISTRIBUTIONS).unwrap();
    AcpxCandidateAdmission {
        schema: SCHEMA.to_owned(),
        company_id: "company-1".to_owned(),
        agent: "antigravity".to_owned(),
        model: "explicit-model".to_owned(),
        profile_digest: acpx_release_profile("antigravity")
            .unwrap()
            .command_digest
            .to_owned(),
        native_closure_digest: format!(
            "sha256:{}",
            manifest["platforms"]["darwin-arm64"]["closureSha256"]
                .as_str()
                .unwrap()
        ),
        platform: "darwin".to_owned(),
        architecture: "arm64".to_owned(),
        expires_at: current_time_ms().unwrap() + 60_000,
        run_id: run_id.to_owned(),
        normalized_session_id: session_id.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidate_record_is_strict_and_pinned_to_native_host_and_time() {
        let candidate = test_admission("run-1", "session-1");
        let now = candidate.expires_at - 1;
        candidate.validate_at(now, "macos", "aarch64").unwrap();
        for (os, architecture) in [("linux", "aarch64"), ("macos", "x86_64")] {
            assert!(candidate.validate_at(now, os, architecture).is_err());
        }
        assert!(candidate
            .validate_at(candidate.expires_at, "macos", "aarch64")
            .is_err());
        assert!(candidate
            .validate_at(
                candidate.expires_at - MAX_LIFETIME_MS - 1,
                "macos",
                "aarch64"
            )
            .is_err());
        for (field, value) in [
            ("schema", json!("unknown")),
            ("companyId", json!("bad company")),
            ("agent", json!("copilot")),
            ("model", json!("auto")),
            ("profileDigest", json!("sha256:wrong")),
            ("nativeClosureDigest", json!("sha256:wrong")),
            ("platform", json!("linux")),
            ("architecture", json!("x64")),
            ("runId", json!("bad/run")),
            ("normalizedSessionId", json!("bad/session")),
        ] {
            let mut changed = serde_json::to_value(&candidate).unwrap();
            changed[field] = value;
            let changed: AcpxCandidateAdmission = serde_json::from_value(changed).unwrap();
            assert!(
                changed.validate_at(now, "macos", "aarch64").is_err(),
                "{field}"
            );
        }
        let mut value = serde_json::to_value(&candidate).unwrap();
        value["extra"] = json!(true);
        assert!(serde_json::from_value::<AcpxCandidateAdmission>(value).is_err());
        assert!(AcpxCandidateAdmission::parse_json(&"x".repeat(4_097)).is_err());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn candidate_binds_actual_launch_and_does_not_echo_bad_input() {
        let candidate = test_admission("run-1", "session-1");
        candidate
            .validate_binding("antigravity", "explicit-model", "run-1", "session-1")
            .unwrap();
        for expected in [
            ("copilot", "explicit-model", "run-1", "session-1"),
            ("antigravity", "another-model", "run-1", "session-1"),
            ("antigravity", "explicit-model", "run-2", "session-1"),
            ("antigravity", "explicit-model", "run-1", "session-2"),
        ] {
            assert!(candidate
                .validate_binding(expected.0, expected.1, expected.2, expected.3)
                .is_err());
        }
        let error = AcpxCandidateAdmission::parse_json("private malformed input").unwrap_err();
        assert!(!error.to_string().contains("private"));
    }
}
