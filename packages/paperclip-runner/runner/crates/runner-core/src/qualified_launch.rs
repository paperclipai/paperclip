use std::fs::{self, File};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

use crate::durable::{DurableRunnerError, QualifiedLaunchArtifact};
use crate::process_supervisor::VerifiedProcessArtifact;

pub fn verify_launch_artifact(
    artifact: &QualifiedLaunchArtifact,
    label: &str,
) -> Result<VerifiedProcessArtifact, DurableRunnerError> {
    let source_metadata = fs::symlink_metadata(&artifact.path).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to inspect qualified {label}: {error}"))
    })?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} must be a regular file, not a symlink"
        )));
    }
    #[cfg(unix)]
    if source_metadata.permissions().mode() & 0o022 != 0 {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} must not be group- or world-writable"
        )));
    }

    let canonical = fs::canonicalize(&artifact.path).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to resolve qualified {label}: {error}"))
    })?;
    let canonical_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        DurableRunnerError::invalid(format!(
            "failed to inspect resolved qualified {label}: {error}"
        ))
    })?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_file() {
        return Err(DurableRunnerError::invalid(format!(
            "resolved qualified {label} must be a regular file"
        )));
    }
    let file = File::open(&canonical).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to open qualified {label}: {error}"))
    })?;
    let opened_metadata = file.metadata().map_err(|error| {
        DurableRunnerError::invalid(format!("failed to identify qualified {label}: {error}"))
    })?;
    if !same_file(&canonical_metadata, &opened_metadata) {
        return Err(DurableRunnerError::invalid(format!(
            "qualified {label} changed while it was opened"
        )));
    }
    VerifiedProcessArtifact::snapshot_verified(canonical, file, &artifact.sha256)
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.is_file() == right.is_file()
}
