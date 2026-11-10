use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
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
}

impl Default for AcpxLaunchArtifacts {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::Idle),
        }
    }
}

impl AcpxLaunchArtifacts {
    pub fn verify_in_background(profile: Option<&AcpxLaunchProfile>) -> Self {
        let Some(profile) = profile.cloned() else {
            return Self::default();
        };
        let state = thread::Builder::new()
            .name("acpx-launch-artifacts".to_owned())
            .spawn(move || verify(&profile))
            .map_or(State::Idle, State::Verifying);
        Self {
            state: Mutex::new(state),
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
        let verified = verify(profile)?;
        let snapshots = verified.snapshots.clone();
        *state = State::Ready(verified);
        Ok(snapshots)
    }
}

fn verify(profile: &AcpxLaunchProfile) -> Result<Verified, DurableRunnerError> {
    let mut snapshots = HashMap::new();
    for artifact in &profile.artifacts {
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
