use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::durable::{DurableRunnerError, QualifiedLaunchArtifact};
use crate::process_supervisor::{VerifiedProcessArgument, VerifiedProcessLaunch};
use crate::qualified_launch::{verify_executable_launch_artifact, verify_launch_artifact};

use super::{bounded_text, invalid, EXTENSION_LAUNCH_PROFILE_ENV};

fn sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionReleaseIdentity {
    pub harness_id: String,
    pub package_name: String,
    pub version: String,
    pub integrity: String,
    pub protocol_version: u64,
    pub runtime_digest: String,
}
impl ExtensionReleaseIdentity {
    pub(super) fn validate(&self) -> Result<(), DurableRunnerError> {
        if !bounded_text(&self.harness_id, 240)
            || !bounded_text(&self.package_name, 240)
            || !bounded_text(&self.version, 120)
            || !bounded_text(&self.integrity, 1024)
            || !(self.integrity.starts_with("sha256-") || self.integrity.starts_with("sha512-"))
            || self.protocol_version != 1
            || !sha256(&self.runtime_digest)
        {
            return Err(invalid(
                "extension release identity is invalid or incompatible",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionLaunchArtifact {
    pub path: PathBuf,
    pub sha256: String,
}
impl ExtensionLaunchArtifact {
    pub(super) fn qualified(&self) -> Result<QualifiedLaunchArtifact, DurableRunnerError> {
        if !self.path.is_absolute() || !sha256(&self.sha256) {
            return Err(invalid(
                "extension launch artifact must have an absolute path and SHA-256 digest",
            ));
        }
        Ok(QualifiedLaunchArtifact {
            path: self.path.clone(),
            sha256: self.sha256.clone(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionLaunchProfile {
    pub schema: String,
    pub identity: ExtensionReleaseIdentity,
    pub command: ExtensionLaunchArtifact,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<ExtensionLaunchArtifact>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub environment_keys: Vec<String>,
}
impl ExtensionLaunchProfile {
    pub fn from_environment() -> Result<Option<Self>, DurableRunnerError> {
        let Some(value) = std::env::var_os(EXTENSION_LAUNCH_PROFILE_ENV) else {
            return Ok(None);
        };
        let raw = value
            .to_str()
            .ok_or_else(|| invalid("extension launch profile is not UTF-8"))?;
        if raw.len() > 64 * 1024 {
            return Err(invalid("extension launch profile exceeds its bound"));
        }
        let profile: Self = serde_json::from_str(raw)
            .map_err(|_| invalid("extension launch profile is malformed"))?;
        profile.validate()?;
        Ok(Some(profile))
    }
    pub fn validate(&self) -> Result<(), DurableRunnerError> {
        self.identity.validate()?;
        self.command.qualified()?;
        if let Some(entrypoint) = &self.entrypoint {
            entrypoint.qualified()?;
        }
        let mut keys = BTreeSet::new();
        if self.schema != "paperclip.harness-launch.v1"
            || self.args.len() > 64
            || self
                .args
                .iter()
                .any(|arg| arg.len() > 4096 || arg.contains('\0') || Path::new(arg).is_absolute())
            || self.environment_keys.len() > 128
            || self
                .environment_keys
                .iter()
                .any(|key| !valid_environment_key(key) || !keys.insert(key))
        {
            return Err(invalid(
                "extension launch profile contains unsupported arguments or environment keys",
            ));
        }
        Ok(())
    }
    pub(super) fn digest(&self) -> Result<String, DurableRunnerError> {
        Ok(format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(self)
                    .map_err(|_| invalid("extension launch profile serialization failed"))?
            )
        ))
    }
    pub(super) fn verified_launch(&self) -> Result<VerifiedProcessLaunch, DurableRunnerError> {
        self.validate()?;
        let program =
            verify_executable_launch_artifact(&self.command.qualified()?, "extension command")?;
        let mut args = Vec::new();
        if let Some(entrypoint) = &self.entrypoint {
            // The entrypoint is a bundled CommonJS artifact. It may load only
            // its declared runtime closure; Node's ambient module path is empty.
            args.push(VerifiedProcessArgument::CommonJsArtifact(
                verify_launch_artifact(&entrypoint.qualified()?, "extension entrypoint")?,
            ));
        }
        args.extend(
            self.args
                .iter()
                .cloned()
                .map(VerifiedProcessArgument::Literal),
        );
        Ok(VerifiedProcessLaunch::new(program, args).with_inherited_runtime_executable())
    }
}
fn valid_environment_key(key: &str) -> bool {
    key.len() <= 128
        && key.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && !["PAPERCLIP_", "NODE_", "NPM_", "LD_", "DYLD_", "GIT_CONFIG"]
            .iter()
            .any(|prefix| key.starts_with(prefix))
        && !matches!(
            key,
            "PATH"
                | "HOME"
                | "SHELL"
                | "ENV"
                | "BASH_ENV"
                | "IFS"
                | "NODEPATH"
                | "PYTHONPATH"
                | "PYTHONHOME"
                | "RUBYOPT"
                | "PERL5OPT"
                | "GIT_SSH"
                | "GIT_SSH_COMMAND"
                | "GIT_ASKPASS"
                | "SSH_ASKPASS"
                | "SSH_AUTH_SOCK"
                | "PROMPT_COMMAND"
                | "PS4"
                | "SHELLOPTS"
                | "BASHOPTS"
                | "CDPATH"
                | "GLOBIGNORE"
                | "OPENSSL_CONF"
                | "OPENSSL_MODULES"
                | "GIT_EXEC_PATH"
                | "GIT_PROXY_COMMAND"
                | "BASH_LOADABLES_PATH"
                | "ZDOTDIR"
                | "COMSPEC"
                | "PATHEXT"
                | "GCONV_PATH"
                | "GLIBC_TUNABLES"
                | "OPENSSL_ENGINES"
        )
}
