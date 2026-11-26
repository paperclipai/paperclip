use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::generated_acpx_profiles::{
    acpx_release_profile, antigravity_native_closure, kimi_native_closure, AcpxReleaseProfile,
};
use crate::local_runner::LocalRunnerError;
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

const SCHEMA: &str = "paperclip.acpx-candidate-admission.v1";
const MAX_LIFETIME_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The record names Node's platform/architecture; the host check uses Rust's.
fn native_host_matches(platform: &str, architecture: &str, os: &str, host_arch: &str) -> bool {
    matches!(
        (platform, architecture, os, host_arch),
        ("darwin", "arm64", "macos", "aarch64")
            | ("linux", "x64", "linux", "x86_64")
            | ("linux", "arm64", "linux", "aarch64")
    )
}

/// The generated release profile that runtime qualification gates read.
pub(crate) fn release_profile(agent: &str) -> Option<AcpxReleaseProfile> {
    acpx_release_profile(agent)
}

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
        let profile = release_profile(&self.agent).ok_or_else(invalid)?;
        self.validate_against_profile(&profile, now, os, architecture)
    }

    /// A candidate grant authorizes only a profile whose generated declaration
    /// is still pending qualification. Releasing a profile is therefore a
    /// declaration change: every candidate grant for that agent stops working.
    fn validate_against_profile(
        &self,
        profile: &AcpxReleaseProfile,
        now: u64,
        os: &str,
        architecture: &str,
    ) -> Result<(), LocalRunnerError> {
        let closure = match self.agent.as_str() {
            "antigravity" if profile.qualification_pending => {
                antigravity_native_closure(&self.platform, &self.architecture)
            }
            "kimi" if profile.qualification_pending => {
                kimi_native_closure(&self.platform, &self.architecture)
            }
            _ => None,
        }
        .ok_or_else(invalid)?;
        let host_matches =
            native_host_matches(&self.platform, &self.architecture, os, architecture);
        if self.schema != SCHEMA
            || !is_stable_id(&self.company_id, DURABLE_STABLE_ID_CHARS)
            || self.model.trim().is_empty()
            || self.model != self.model.trim()
            || self.model.len() > 512
            || self.model.chars().any(char::is_control)
            || matches!(self.model.to_ascii_lowercase().as_str(), "auto" | "default")
            || self.profile_digest != profile.command_digest
            || self.native_closure_digest != format!("sha256:{closure}")
            || !host_matches
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

    pub fn validate_next_run(
        &self,
        next: &Self,
        agent: &str,
        model: &str,
        run_id: &str,
        normalized_session_id: &str,
    ) -> Result<(), LocalRunnerError> {
        if self.agent != "kimi" || self.run_id == next.run_id {
            return Err(invalid());
        }
        self.validate()?;
        next.validate_binding(agent, model, run_id, normalized_session_id)?;
        let mut rebound = next.clone();
        rebound.run_id = self.run_id.clone();
        if &rebound != self {
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

/// The verified Antigravity target of the test host, or macOS ARM elsewhere.
#[cfg(test)]
pub(crate) fn test_target() -> (&'static str, &'static str) {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        ("linux", "x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        ("linux", "arm64")
    } else {
        ("darwin", "arm64")
    }
}

#[cfg(test)]
pub(crate) fn test_admission(run_id: &str, session_id: &str) -> AcpxCandidateAdmission {
    let (platform, architecture) = test_target();
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
            antigravity_native_closure(platform, architecture).unwrap()
        ),
        platform: platform.to_owned(),
        architecture: architecture.to_owned(),
        expires_at: current_time_ms().unwrap() + 60_000,
        run_id: run_id.to_owned(),
        normalized_session_id: session_id.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn antigravity_admission(platform: &str, architecture: &str) -> AcpxCandidateAdmission {
        AcpxCandidateAdmission {
            native_closure_digest: format!(
                "sha256:{}",
                antigravity_native_closure(platform, architecture).unwrap()
            ),
            platform: platform.to_owned(),
            architecture: architecture.to_owned(),
            ..test_admission("run-1", "session-1")
        }
    }

    const ANTIGRAVITY_HOSTS: [(&str, &str, &str, &str); 3] = [
        ("darwin", "arm64", "macos", "aarch64"),
        ("linux", "x64", "linux", "x86_64"),
        ("linux", "arm64", "linux", "aarch64"),
    ];

    fn pending_antigravity_profile() -> AcpxReleaseProfile {
        AcpxReleaseProfile {
            qualification_pending: true,
            ..acpx_release_profile("antigravity").unwrap()
        }
    }

    #[test]
    fn candidate_record_is_strict_and_pinned_to_native_host_and_time() {
        assert!(antigravity_native_closure("darwin", "x64").is_none());
        let pending = pending_antigravity_profile();
        for (platform, architecture, os, host_arch) in ANTIGRAVITY_HOSTS {
            let candidate = antigravity_admission(platform, architecture);
            let now = candidate.expires_at - 1;
            candidate
                .validate_against_profile(&pending, now, os, host_arch)
                .unwrap();
            for (other_os, other_arch) in [
                ("macos", "aarch64"),
                ("macos", "x86_64"),
                ("linux", "x86_64"),
                ("linux", "aarch64"),
                ("windows", "x86_64"),
            ] {
                if (other_os, other_arch) != (os, host_arch) {
                    assert!(candidate
                        .validate_against_profile(&pending, now, other_os, other_arch)
                        .is_err());
                }
            }
            assert!(candidate
                .validate_against_profile(&pending, candidate.expires_at, os, host_arch)
                .is_err());
            assert!(candidate
                .validate_against_profile(
                    &pending,
                    candidate.expires_at - MAX_LIFETIME_MS - 1,
                    os,
                    host_arch,
                )
                .is_err());
            let other_platform = if platform == "linux" {
                "darwin"
            } else {
                "linux"
            };
            let other_architecture = if architecture == "x64" {
                "arm64"
            } else {
                "x64"
            };
            for (field, value) in [
                ("schema", json!("unknown")),
                ("companyId", json!("bad company")),
                ("agent", json!("copilot")),
                ("model", json!("auto")),
                ("profileDigest", json!("sha256:wrong")),
                ("nativeClosureDigest", json!("sha256:wrong")),
                ("platform", json!(other_platform)),
                ("architecture", json!(other_architecture)),
                ("runId", json!("bad/run")),
                ("normalizedSessionId", json!("bad/session")),
            ] {
                let mut changed = serde_json::to_value(&candidate).unwrap();
                changed[field] = value;
                let changed: AcpxCandidateAdmission = serde_json::from_value(changed).unwrap();
                assert!(
                    changed
                        .validate_against_profile(&pending, now, os, host_arch)
                        .is_err(),
                    "{platform}-{architecture}: {field}"
                );
            }
        }
        let candidate = test_admission("run-1", "session-1");
        let mut value = serde_json::to_value(&candidate).unwrap();
        value["extra"] = json!(true);
        assert!(serde_json::from_value::<AcpxCandidateAdmission>(value).is_err());
        assert!(AcpxCandidateAdmission::parse_json(&"x".repeat(4_097)).is_err());
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        )
    ))]
    fn candidate_binds_actual_launch_and_does_not_echo_bad_input() {
        let candidate = test_admission("run-1", "session-1");
        assert!(candidate
            .validate_binding("antigravity", "explicit-model", "run-1", "session-1")
            .is_err());
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

    #[test]
    fn released_antigravity_rejects_candidate_records_on_every_native_platform() {
        let released = acpx_release_profile("antigravity").unwrap();
        assert!(!released.qualification_pending);
        let pending = pending_antigravity_profile();
        for (platform, architecture, os, host_arch) in ANTIGRAVITY_HOSTS {
            let candidate = antigravity_admission(platform, architecture);
            let now = candidate.expires_at - 1;
            candidate
                .validate_against_profile(&pending, now, os, host_arch)
                .unwrap();
            assert!(
                candidate
                    .validate_against_profile(&released, now, os, host_arch)
                    .is_err(),
                "{platform}-{architecture}"
            );
            assert!(
                candidate.validate_at(now, os, host_arch).is_err(),
                "{platform}-{architecture}"
            );
            let mut next = candidate.clone();
            next.run_id = "run-2".to_owned();
            assert!(next
                .validate_against_profile(&released, now, os, host_arch)
                .is_err());
        }
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        )
    ))]
    fn released_antigravity_rejects_startup_and_binding_records() {
        assert!(
            !release_profile("antigravity")
                .unwrap()
                .qualification_pending
        );
        let current = test_admission("run-1", "session-1");
        assert!(current.validate().is_err());
        assert!(current
            .validate_binding("antigravity", "explicit-model", "run-1", "session-1")
            .is_err());
        assert!(
            AcpxCandidateAdmission::parse_json(&serde_json::to_string(&current).unwrap()).is_err()
        );
    }

    fn kimi_admission(platform: &str, architecture: &str) -> AcpxCandidateAdmission {
        AcpxCandidateAdmission {
            agent: "kimi".to_owned(),
            model: "kimi-for-coding".to_owned(),
            profile_digest: acpx_release_profile("kimi")
                .unwrap()
                .command_digest
                .to_owned(),
            native_closure_digest: format!(
                "sha256:{}",
                kimi_native_closure(platform, architecture).unwrap()
            ),
            platform: platform.to_owned(),
            architecture: architecture.to_owned(),
            ..test_admission("kimi-run", "kimi-session")
        }
    }

    #[test]
    fn released_kimi_rejects_candidate_records_on_both_native_platforms() {
        assert!(!acpx_release_profile("kimi").unwrap().qualification_pending);
        for (platform, architecture, os, host_arch) in [
            ("darwin", "arm64", "macos", "aarch64"),
            ("linux", "x64", "linux", "x86_64"),
        ] {
            let candidate = kimi_admission(platform, architecture);
            let now = candidate.expires_at - 1;
            assert!(candidate.validate_at(now, os, host_arch).is_err());
            for (wrong_os, wrong_arch) in [
                ("windows", "x86_64"),
                ("linux", "aarch64"),
                ("macos", "x86_64"),
            ] {
                assert!(candidate.validate_at(now, wrong_os, wrong_arch).is_err());
            }
            let (other_os, other_arch) = if os == "macos" {
                ("linux", "x86_64")
            } else {
                ("macos", "aarch64")
            };
            assert!(candidate.validate_at(now, other_os, other_arch).is_err());
            assert!(candidate
                .validate_at(candidate.expires_at, os, host_arch)
                .is_err());
            assert!(candidate
                .validate_at(candidate.expires_at - MAX_LIFETIME_MS - 1, os, host_arch)
                .is_err());
            for (field, value) in [
                ("companyId", json!("bad company")),
                ("agent", json!("copilot")),
                ("model", json!("default")),
                ("profileDigest", json!("sha256:wrong")),
                ("nativeClosureDigest", json!("sha256:wrong")),
                ("platform", json!("windows")),
                ("architecture", json!("s390x")),
                ("runId", json!("bad/run")),
                ("normalizedSessionId", json!("bad/session")),
            ] {
                let mut changed = serde_json::to_value(&candidate).unwrap();
                changed[field] = value;
                let changed: AcpxCandidateAdmission = serde_json::from_value(changed).unwrap();
                assert!(changed.validate_at(now, os, host_arch).is_err(), "{field}");
            }
        }
    }

    #[test]
    #[cfg(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64")
    ))]
    fn released_kimi_rejects_candidate_rebinding_and_startup_records() {
        assert!(!acpx_release_profile("kimi").unwrap().qualification_pending);
        let (platform, architecture) = if cfg!(target_os = "macos") {
            ("darwin", "arm64")
        } else {
            ("linux", "x64")
        };
        let current = kimi_admission(platform, architecture);
        let mut next = current.clone();
        next.run_id = "kimi-next-run".to_owned();
        assert!(current.validate().is_err());
        assert!(
            AcpxCandidateAdmission::parse_json(&serde_json::to_string(&current).unwrap()).is_err()
        );
        assert!(current
            .validate_next_run(
                &next,
                "kimi",
                "kimi-for-coding",
                "kimi-next-run",
                "kimi-session",
            )
            .is_err());
        assert!(current
            .validate_next_run(
                &current,
                "kimi",
                "kimi-for-coding",
                "kimi-run",
                "kimi-session"
            )
            .is_err());
        for (field, change) in [
            ("companyId", json!("another-company")),
            ("model", json!("another-model")),
            ("profileDigest", json!("sha256:wrong")),
            ("nativeClosureDigest", json!("sha256:wrong")),
            ("normalizedSessionId", json!("another-session")),
            ("expiresAt", json!(next.expires_at + 1)),
        ] {
            let mut value = serde_json::to_value(&next).unwrap();
            value[field] = change;
            let changed = serde_json::from_value(value).unwrap();
            assert!(current
                .validate_next_run(
                    &changed,
                    "kimi",
                    "kimi-for-coding",
                    "kimi-next-run",
                    "kimi-session"
                )
                .is_err());
        }
        assert!(current
            .validate_next_run(
                &next,
                "kimi",
                "kimi-for-coding",
                "foreign-run",
                "kimi-session"
            )
            .is_err());
        assert!(current
            .validate_next_run(
                &next,
                "kimi",
                "kimi-for-coding",
                "kimi-next-run",
                "foreign-session"
            )
            .is_err());
        let mut expired = current.clone();
        expired.expires_at = 0;
        assert!(expired
            .validate_next_run(
                &next,
                "kimi",
                "kimi-for-coding",
                "kimi-next-run",
                "kimi-session"
            )
            .is_err());
        let antigravity = test_admission("run-1", "session-1");
        assert!(antigravity
            .validate_next_run(
                &next,
                "kimi",
                "kimi-for-coding",
                "kimi-next-run",
                "kimi-session"
            )
            .is_err());
    }
}
