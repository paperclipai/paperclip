mod runner;
mod state;
mod transport;

use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;
use std::time::Duration;

pub use runner::{run_durable_runner, CommandExecution, CommandExecutor, PolledEvent};
pub(crate) use state::{
    create_private_temporary_file, open_private_regular_file, redact_text, verify_private_directory,
};
pub use state::{
    Command, CommandDisposition, DurableState, DurableStateStore, EventPriority,
    StoredCommandResult, StoredOutboxEvent,
};

pub const PROTOCOL: &str = "paperclip.runner";
pub const PROTOCOL_VERSION: u64 = 1;
pub const BOOTSTRAP_TICKET_ENV: &str = "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET";
const MAX_OUTBOX_BYTES: usize = 512 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableRunnerError(String);

impl DurableRunnerError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for DurableRunnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for DurableRunnerError {}

#[derive(Debug)]
struct Secret(Vec<u8>);

impl Secret {
    fn new(value: String) -> Self {
        Self(value.into_bytes())
    }

    fn expose(&self) -> Result<&str, DurableRunnerError> {
        std::str::from_utf8(&self.0)
            .map_err(|_| DurableRunnerError::invalid("transport credential is not valid UTF-8"))
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Debug)]
pub struct BootstrapTicket(Secret);

impl BootstrapTicket {
    pub fn new(value: String) -> Result<Self, DurableRunnerError> {
        if value.trim().is_empty() {
            return Err(DurableRunnerError::invalid(
                "bootstrap ticket must not be empty",
            ));
        }
        Ok(Self(Secret::new(value)))
    }

    fn expose(&self) -> Result<&str, DurableRunnerError> {
        self.0.expose()
    }
}

pub fn capture_bootstrap_ticket() -> Result<Option<BootstrapTicket>, DurableRunnerError> {
    let value = match std::env::var(BOOTSTRAP_TICKET_ENV) {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(error) => {
            return Err(DurableRunnerError::invalid(format!(
                "failed to read bootstrap ticket: {error}"
            )))
        }
    };
    std::env::remove_var(BOOTSTRAP_TICKET_ENV);
    BootstrapTicket::new(value).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DurableRunnerConfig {
    pub connect_url: String,
    pub state_dir: PathBuf,
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub runner_version: String,
    pub runner_digest: String,
    pub max_outbox_bytes: usize,
    pub p0_reserve_bytes: usize,
    pub max_frame_bytes: usize,
    pub reconnect_delay: Duration,
    pub max_runtime: Duration,
}

impl DurableRunnerConfig {
    pub fn validate(&self) -> Result<(), DurableRunnerError> {
        for (name, value) in [
            ("connect_url", self.connect_url.as_str()),
            ("runner_instance_id", self.runner_instance_id.as_str()),
            ("environment_lease_id", self.environment_lease_id.as_str()),
            ("run_id", self.run_id.as_str()),
            ("normalized_session_id", self.normalized_session_id.as_str()),
            ("turn_id", self.turn_id.as_str()),
            ("item_id", self.item_id.as_str()),
            ("runner_version", self.runner_version.as_str()),
            ("runner_digest", self.runner_digest.as_str()),
        ] {
            if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
                return Err(DurableRunnerError::invalid(format!(
                    "{name} must be a non-empty bounded string without control characters"
                )));
            }
        }
        if self.max_outbox_bytes == 0
            || self.max_outbox_bytes > MAX_OUTBOX_BYTES
            || self.p0_reserve_bytes >= self.max_outbox_bytes
        {
            return Err(DurableRunnerError::invalid(
                "P0 reserve must be smaller than an outbox limit no larger than 512 MiB",
            ));
        }
        if !(1024..=MAX_FRAME_BYTES).contains(&self.max_frame_bytes) {
            return Err(DurableRunnerError::invalid(
                "transport frame limit must be between 1 KiB and 16 MiB",
            ));
        }
        if self.max_runtime.is_zero() {
            return Err(DurableRunnerError::invalid(
                "durable runner max runtime must be non-zero",
            ));
        }
        if self.reconnect_delay.is_zero() || self.reconnect_delay > Duration::from_secs(60) {
            return Err(DurableRunnerError::invalid(
                "reconnect delay must be between one millisecond and 60 seconds",
            ));
        }
        if self.max_runtime > Duration::from_secs(7 * 24 * 60 * 60) {
            return Err(DurableRunnerError::invalid(
                "durable runner max runtime must not exceed seven days",
            ));
        }
        Ok(())
    }
}
