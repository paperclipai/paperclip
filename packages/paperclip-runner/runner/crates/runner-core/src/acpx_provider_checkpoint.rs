use std::fs::{self, DirBuilder};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;

use serde::{Deserialize, Serialize};

use crate::acpx_provider_session::{AcpxProviderSessionConfig, AcpxProviderSessionIdentity};
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory,
};
use crate::local_runner::LocalRunnerError;

const CHECKPOINT_SCHEMA: &str = "paperclip.runner.acpx-suspension-checkpoint.v1";
const CHECKPOINT_DIRECTORY: &str = "acpx-provider";
const CHECKPOINT_FILE: &str = "suspension-checkpoint.json";
const MAX_CHECKPOINT_BYTES: u64 = 1024 * 1024;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcpxSuspensionCheckpoint {
    pub schema: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub catalog_revision: u64,
    pub catalog_digest: String,
    pub identity: AcpxProviderSessionIdentity,
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
            identity,
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
        validate_text(&self.run_id, 160, "run")?;
        validate_text(&self.normalized_session_id, 160, "normalized session")?;
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

    pub fn expected_identity(&self) -> AcpxProviderSessionIdentity {
        self.identity.clone()
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

fn validate_text(value: &str, max_chars: usize, label: &str) -> Result<(), LocalRunnerError> {
    if value.trim().is_empty()
        || value.chars().count() > max_chars
        || value.chars().any(char::is_control)
    {
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
