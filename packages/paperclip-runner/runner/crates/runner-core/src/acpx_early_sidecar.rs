use std::thread::JoinHandle;

use super::{
    verify_launch_profile, AcpxCommandExecutor, AcpxProviderDescriptor, AcpxProviderSession,
};
use crate::acpx_sidecar_transport::{AcpxSidecarTransport, AcpxSidecarTransportConfig};
use crate::durable::{AcpxLaunchProfile, DurableRunnerError};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::AuthorizedToolSet;

type VerifiedLaunch = Result<AcpxSidecarTransportConfig, DurableRunnerError>;

pub struct PreparedAcpxLaunch {
    profile: AcpxLaunchProfile,
    verification: Option<JoinHandle<VerifiedLaunch>>,
}

impl PreparedAcpxLaunch {
    pub fn start(profile: &AcpxLaunchProfile) -> Option<Self> {
        let owned = profile.clone();
        let verification = std::thread::Builder::new()
            .name("acpx-launch-verification".to_owned())
            .spawn(move || verify_launch_profile(&owned))
            .ok()?;
        Some(Self {
            profile: profile.clone(),
            verification: Some(verification),
        })
    }

    fn take_for(
        mut self,
        profile: Option<&AcpxLaunchProfile>,
    ) -> Option<AcpxSidecarTransportConfig> {
        let verified = self.verification.take()?.join().ok()?.ok()?;
        (profile == Some(&self.profile)).then_some(verified)
    }
}

impl Drop for PreparedAcpxLaunch {
    fn drop(&mut self) {
        if let Some(verification) = self.verification.take() {
            let _ = verification.join();
        }
    }
}

pub(super) struct EarlyAcpxSidecar {
    transport: AcpxSidecarTransport,
    verified: AcpxSidecarTransportConfig,
    descriptor: AcpxProviderDescriptor,
    tool_set: AuthorizedToolSet,
    launch_profile: Option<AcpxLaunchProfile>,
}

impl AcpxCommandExecutor {
    pub(crate) fn with_prepared_launch(mut self, prepared: Option<PreparedAcpxLaunch>) -> Self {
        self.prepared_launch = prepared;
        self
    }

    pub(super) fn take_verified_launch(&mut self) -> Option<AcpxSidecarTransportConfig> {
        self.prepared_launch
            .take()
            .and_then(|prepared| prepared.take_for(self.launch_profile.as_ref()))
    }

    fn early_sidecar_eligible(&self) -> bool {
        self.session.is_none()
            && self.early_sidecar.is_none()
            && self.persistence_error.is_none()
            && self.candidate_admission().is_none()
            && self.state.as_ref().is_some_and(|state| {
                state.descriptor.agent == "claude"
                    && state.lifecycle == "prepared"
                    && state.identity.is_none()
                    && state.active_turn_id.is_none()
                    && !state.provider_exit_unconfirmed
                    && state.turn_end_restart_failed_run.is_none()
            })
    }

    pub(crate) fn start_provider_early(&mut self) {
        if !self.early_sidecar_eligible() {
            return;
        }
        let state = self.state.as_ref().expect("checked ACPX state");
        let descriptor = state.descriptor.clone();
        let tool_set = state.tool_set.clone();
        let verified = self.take_verified_launch();
        let Ok(config) = descriptor.session_config_with_transport(
            tool_set.clone(),
            None,
            self.launch_profile.as_ref(),
            verified,
        ) else {
            return;
        };
        let Ok(transport) = AcpxSidecarTransport::start_for_agent(&config.transport, &config.agent)
        else {
            return;
        };
        self.early_sidecar = Some(EarlyAcpxSidecar {
            transport,
            verified: config.transport,
            descriptor,
            tool_set,
            launch_profile: self.launch_profile.clone(),
        });
    }

    pub(super) fn start_fresh_session(
        &mut self,
        descriptor: &AcpxProviderDescriptor,
        tool_set: &AuthorizedToolSet,
    ) -> Result<AcpxProviderSession, DurableRunnerError> {
        let early = self.early_sidecar.take().filter(|early| {
            early.descriptor == *descriptor
                && early.tool_set == *tool_set
                && early.launch_profile == self.launch_profile
        });
        let verified = match &early {
            Some(early) => Some(early.verified.clone()),
            None => {
                self.discard_early_sidecar();
                self.take_verified_launch()
            }
        };
        let config = descriptor.session_config_with_transport(
            tool_set.clone(),
            None,
            self.launch_profile.as_ref(),
            verified,
        );
        let config = match config {
            Ok(config) => config,
            Err(error) => {
                if let Some(mut early) = early {
                    let _ = early.transport.shutdown();
                }
                return Err(error);
            }
        };
        let started = match early {
            Some(mut early) => {
                if early.transport.running() {
                    AcpxProviderSession::start_with_transport(&config, early.transport)
                } else {
                    let _ = early.transport.shutdown();
                    AcpxProviderSession::start(&config)
                }
            }
            None => AcpxProviderSession::start(&config),
        };
        started.map_err(|error: LocalRunnerError| {
            DurableRunnerError::invalid(format!("failed to start ACPX provider: {error}"))
                .with_provider_failure(error.provider_failure())
        })
    }

    pub(super) fn discard_early_sidecar(&mut self) {
        if let Some(mut early) = self.early_sidecar.take() {
            let _ = early.transport.shutdown();
        }
    }
}
