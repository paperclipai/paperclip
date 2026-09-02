use std::fs::{self, DirBuilder};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

use serde::{Deserialize, Serialize};

use crate::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSessionConfig, AcpxProviderSessionIdentity,
};
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory,
};
use crate::local_runner::LocalRunnerError;
use crate::stable_identity::{is_stable_id, SHORT_STABLE_ID_CHARS};

const CHECKPOINT_SCHEMA: &str = "paperclip.runner.acpx-suspension-checkpoint.v1";
const CHECKPOINT_DIRECTORY: &str = "acpx-provider";
const CHECKPOINT_FILE: &str = "suspension-checkpoint.json";
const MAX_CHECKPOINT_BYTES: u64 = 1024 * 1024;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpxSuspensionCheckpoint {
    schema: String,
    run_id: String,
    normalized_session_id: String,
    catalog_revision: u64,
    catalog_digest: String,
    identity: PersistedAcpxProviderSessionIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedAcpxProviderSessionIdentity {
    kind: String,
    normalized_session_id: String,
    acpx_record_id: String,
    backend_session_id: String,
    agent_session_id: String,
    profile_digest: String,
    workspace_digest: String,
    requested_model: String,
    effective_model: String,
    permission_mode: AcpxPermissionMode,
}

impl PersistedAcpxProviderSessionIdentity {
    fn from_runtime(identity: AcpxProviderSessionIdentity) -> Result<Self, LocalRunnerError> {
        identity.validate()?;
        let permission_mode = identity.permission_mode.ok_or_else(|| {
            LocalRunnerError::invalid(
                "ACPX suspension checkpoint identity omitted its pinned permission mode",
            )
        })?;
        Ok(Self {
            kind: identity.kind,
            normalized_session_id: identity.normalized_session_id,
            acpx_record_id: identity.acpx_record_id,
            backend_session_id: identity.backend_session_id,
            agent_session_id: identity.agent_session_id,
            profile_digest: identity.profile_digest,
            workspace_digest: identity.workspace_digest,
            requested_model: identity.requested_model,
            effective_model: identity.effective_model,
            permission_mode,
        })
    }

    fn runtime_identity(&self) -> AcpxProviderSessionIdentity {
        AcpxProviderSessionIdentity {
            kind: self.kind.clone(),
            normalized_session_id: self.normalized_session_id.clone(),
            acpx_record_id: self.acpx_record_id.clone(),
            backend_session_id: self.backend_session_id.clone(),
            agent_session_id: self.agent_session_id.clone(),
            profile_digest: self.profile_digest.clone(),
            workspace_digest: self.workspace_digest.clone(),
            requested_model: self.requested_model.clone(),
            effective_model: self.effective_model.clone(),
            permission_mode: Some(self.permission_mode),
        }
    }

    fn validate(&self) -> Result<(), LocalRunnerError> {
        self.runtime_identity().validate()
    }
}

impl AcpxSuspensionCheckpoint {
    pub fn from_suspension(
        config: &AcpxProviderSessionConfig,
        identity: AcpxProviderSessionIdentity,
    ) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        identity.validate()?;
        if identity.normalized_session_id != config.normalized_session_id
            || identity.requested_model != config.model
            || identity.effective_model != config.model
            || identity.permission_mode != Some(config.permission_mode)
            || config
                .expected_identity
                .as_ref()
                .is_some_and(|expected| expected != &identity)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX suspended identity conflicts with the admitted session configuration",
            ));
        }
        let checkpoint = Self {
            schema: CHECKPOINT_SCHEMA.to_owned(),
            run_id: config.run_id.clone(),
            normalized_session_id: config.normalized_session_id.clone(),
            catalog_revision: config.catalog_revision,
            catalog_digest: config.tool_set.catalog_digest.clone(),
            identity: PersistedAcpxProviderSessionIdentity::from_runtime(identity)?,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if self.schema != CHECKPOINT_SCHEMA {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint schema is unsupported",
            ));
        }
        validate_stable_id(&self.run_id, "run")?;
        validate_stable_id(&self.normalized_session_id, "normalized session")?;
        if self.catalog_revision == 0 || self.catalog_revision > MAX_JSON_SAFE_INTEGER {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint catalog revision is invalid",
            ));
        }
        if !is_sha256_digest(&self.catalog_digest) {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint catalog digest is invalid",
            ));
        }
        self.identity.validate()?;
        if self.identity.normalized_session_id != self.normalized_session_id {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint session identity is inconsistent",
            ));
        }
        Ok(())
    }

    pub fn admit_recovery(
        &self,
        config: &AcpxProviderSessionConfig,
    ) -> Result<AcpxProviderSessionIdentity, LocalRunnerError> {
        self.validate()?;
        config.validate()?;
        let identity = self.identity.runtime_identity();
        let expected = Self::from_suspension(config, identity.clone())?;
        if &expected != self {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint conflicts with the recovery configuration",
            ));
        }
        Ok(identity)
    }
}

#[derive(Clone, Debug)]
pub struct AcpxSuspensionCheckpointStore {
    directory: PathBuf,
    path: PathBuf,
}

impl AcpxSuspensionCheckpointStore {
    pub fn new(runner_state_directory: &Path) -> Result<Self, LocalRunnerError> {
        secure_directory(runner_state_directory, "runner state")?;
        let directory = runner_state_directory.join(CHECKPOINT_DIRECTORY);
        secure_directory(&directory, "ACPX checkpoint")?;
        Ok(Self {
            path: directory.join(CHECKPOINT_FILE),
            directory,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Option<AcpxSuspensionCheckpoint>, LocalRunnerError> {
        let file = match open_private_regular_file(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(LocalRunnerError::invalid(format!(
                    "failed to open the private ACPX suspension checkpoint: {error}"
                )))
            }
        };
        let length = file
            .metadata()
            .map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "failed to inspect the ACPX suspension checkpoint: {error}"
                ))
            })?
            .len();
        if length > MAX_CHECKPOINT_BYTES {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint exceeds its 1 MiB bound",
            ));
        }
        let bytes = read_checkpoint_bytes(file, length)?;
        let checkpoint: AcpxSuspensionCheckpoint =
            serde_json::from_slice(&bytes).map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "ACPX suspension checkpoint is malformed: {error}"
                ))
            })?;
        checkpoint.validate()?;
        Ok(Some(checkpoint))
    }

    pub fn save(&self, checkpoint: &AcpxSuspensionCheckpoint) -> Result<(), LocalRunnerError> {
        checkpoint.validate()?;
        verify_private_directory(&self.directory).map_err(|error| {
            LocalRunnerError::invalid(format!(
                "ACPX checkpoint directory is no longer private: {error}"
            ))
        })?;
        let bytes = serde_json::to_vec_pretty(checkpoint).map_err(|error| {
            LocalRunnerError::invalid(format!(
                "failed to serialize the ACPX suspension checkpoint: {error}"
            ))
        })?;
        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
            return Err(LocalRunnerError::invalid(
                "ACPX suspension checkpoint exceeds its 1 MiB bound",
            ));
        }
        let (temporary, mut file) = create_private_temporary_file(&self.path).map_err(|error| {
            LocalRunnerError::invalid(format!(
                "failed to create a private ACPX checkpoint file: {error}"
            ))
        })?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.path)?;
            #[cfg(unix)]
            File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(LocalRunnerError::invalid(format!(
                "failed to atomically replace the ACPX suspension checkpoint: {error}"
            )));
        }
        Ok(())
    }
}

fn read_checkpoint_bytes(
    reader: impl Read,
    capacity_hint: u64,
) -> Result<Vec<u8>, LocalRunnerError> {
    let mut reader = reader.take(MAX_CHECKPOINT_BYTES + 1);
    let mut bytes = Vec::with_capacity(capacity_hint.min(MAX_CHECKPOINT_BYTES) as usize);
    reader.read_to_end(&mut bytes).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to read the ACPX suspension checkpoint: {error}"
        ))
    })?;
    if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Err(LocalRunnerError::invalid(
            "ACPX suspension checkpoint exceeds its 1 MiB bound",
        ));
    }
    Ok(bytes)
}

fn secure_directory(path: &Path, label: &str) -> Result<(), LocalRunnerError> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(LocalRunnerError::invalid(format!(
                "failed to create {label} directory: {error}"
            )))
        }
    }
    // The leaf is created with its private mode in the atomic mkdir operation.
    // Never chmod a path after a metadata check: an attacker could replace the
    // leaf with a symlink between those calls and redirect the permission write.
    // Existing paths must already satisfy the same fail-closed contract.
    verify_private_directory(path).map_err(|error| {
        LocalRunnerError::invalid(format!("{label} directory is not private: {error}"))
    })
}

fn validate_stable_id(value: &str, label: &str) -> Result<(), LocalRunnerError> {
    if !is_stable_id(value, SHORT_STABLE_ID_CHARS) {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX suspension checkpoint {label} identity is invalid"
        )));
    }
    Ok(())
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::read_checkpoint_bytes;

    #[test]
    fn bounded_checkpoint_reader_rejects_growth_beyond_the_metadata_hint() {
        let error = read_checkpoint_bytes(std::io::repeat(b'x'), 0)
            .unwrap_err()
            .to_string();

        assert!(error.contains("1 MiB"), "{error}");
    }
}
