use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};

use crate::durable::{AcpxLaunchProfile, DurableRunnerError, QualifiedLaunchArtifact};
use crate::process_supervisor::VerifiedProcessArtifact;
use crate::qualified_launch::{verify_executable_launch_artifact, verify_launch_artifact};

pub(crate) type VerifiedLaunchArtifacts = HashMap<PathBuf, VerifiedProcessArtifact>;

struct Verified {
    command: PathBuf,
    artifacts: Vec<QualifiedLaunchArtifact>,
    snapshots: VerifiedLaunchArtifacts,
}

impl Verified {
    fn matches(&self, profile: &AcpxLaunchProfile) -> bool {
        self.command == profile.command && self.artifacts == profile.artifacts
    }
}

enum State {
    Idle,
    Verifying(JoinHandle<Result<Verified, DurableRunnerError>>),
    Ready(Verified),
}

pub struct AcpxLaunchArtifacts {
    state: Mutex<State>,
    cancelled: Arc<AtomicBool>,
}

impl Default for AcpxLaunchArtifacts {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::Idle),
            cancelled: Arc::default(),
        }
    }
}

impl Drop for AcpxLaunchArtifacts {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        let state = self.state.get_mut().unwrap_or_else(PoisonError::into_inner);
        if let State::Verifying(handle) = std::mem::replace(state, State::Idle) {
            let _ = handle.join();
        }
    }
}

impl AcpxLaunchArtifacts {
    pub fn verify_in_background(profile: Option<&AcpxLaunchProfile>) -> Self {
        let Some(profile) = profile.cloned() else {
            return Self::default();
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let state = thread::Builder::new()
            .name("acpx-launch-artifacts".to_owned())
            .spawn(move || verify(&profile, &worker_cancelled))
            .map_or(State::Idle, State::Verifying);
        Self {
            state: Mutex::new(state),
            cancelled,
        }
    }

    pub(crate) fn verified(
        &self,
        profile: &AcpxLaunchProfile,
    ) -> Result<VerifiedLaunchArtifacts, DurableRunnerError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        *state = match std::mem::replace(&mut *state, State::Idle) {
            State::Verifying(handle) => match handle.join() {
                Ok(Ok(verified)) => State::Ready(verified),
                _ => State::Idle,
            },
            settled => settled,
        };
        if let State::Ready(verified) = &*state {
            if verified.matches(profile) {
                return Ok(verified.snapshots.clone());
            }
        }
        let verified = verify(profile, &self.cancelled)?;
        let snapshots = verified.snapshots.clone();
        *state = State::Ready(verified);
        Ok(snapshots)
    }
}

fn verify(
    profile: &AcpxLaunchProfile,
    cancelled: &AtomicBool,
) -> Result<Verified, DurableRunnerError> {
    let mut snapshots = HashMap::new();
    for artifact in &profile.artifacts {
        if cancelled.load(Ordering::Acquire) {
            return Err(DurableRunnerError::invalid(
                "ACPX launch artifact verification stopped with its runner",
            ));
        }
        if snapshots.contains_key(&artifact.path) {
            return Err(DurableRunnerError::invalid(
                "ACPX runner launch profile repeats an artifact path",
            ));
        }
        let snapshot = if artifact.path == profile.command {
            verify_executable_launch_artifact(artifact, "ACPX")?
        } else {
            verify_launch_artifact(artifact, "ACPX")?
        };
        snapshots.insert(artifact.path.clone(), snapshot);
    }
    Ok(Verified {
        command: profile.command.clone(),
        artifacts: profile.artifacts.clone(),
        snapshots,
    })
}

#[cfg(all(test, unix))]
#[path = "tests/acpx_launch_artifacts.rs"]
mod tests;
