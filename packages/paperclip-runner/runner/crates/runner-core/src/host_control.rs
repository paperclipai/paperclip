//! Task-private host retention channel. Credentials never enter durable state.
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::durable::DurableRunnerError;

const MAX_FRAME_BYTES: usize = 16 * 1024;

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostIdentity {
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum HostRequest {
    #[serde(rename_all = "camelCase")]
    Park {
        id: String,
        identity: HostIdentity,
        last_controller_command_seq: u64,
        acked_source_seq: u64,
    },
    #[serde(rename_all = "camelCase")]
    Claim {
        id: String,
        park_id: String,
        bootstrap_ticket: String,
    },
    #[serde(rename_all = "camelCase")]
    Retire { id: String, park_id: String },
}

impl HostRequest {
    pub fn id(&self) -> &str {
        match self {
            Self::Park { id, .. } | Self::Claim { id, .. } | Self::Retire { id, .. } => id,
        }
    }
    fn valid(&self) -> bool {
        let id_valid =
            |id: &str| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control);
        id_valid(self.id())
            && match self {
                Self::Claim {
                    park_id,
                    bootstrap_ticket,
                    ..
                } => {
                    id_valid(park_id)
                        && !bootstrap_ticket.trim().is_empty()
                        && bootstrap_ticket.len() <= 8192
                }
                Self::Retire { park_id, .. } => id_valid(park_id),
                Self::Park { .. } => true,
            }
    }
    fn fingerprint(&self) -> [u8; 32] {
        Sha256::digest(serde_json::to_vec(self).expect("closed host request encodes")).into()
    }
}

pub struct HostControl {
    socket: UnixStream,
    input: Vec<u8>,
    receipts: BTreeMap<String, ([u8; 32], &'static str)>,
    pub(crate) park_id: Option<String>,
    pub(crate) claiming_park_id: Option<String>,
}

fn failure() -> DurableRunnerError {
    DurableRunnerError::invalid("host control channel failed closed")
}

impl HostControl {
    pub fn new(socket: UnixStream) -> Result<Self, DurableRunnerError> {
        if rustix::net::sockopt::socket_type(&socket).map_err(|_| failure())?
            != rustix::net::SocketType::STREAM
        {
            return Err(failure());
        }
        if !rustix::net::getpeername(&socket)
            .map_err(|_| failure())?
            // Unnamed Unix socketpairs have no returned address on Darwin.
            .is_none_or(|address| address.address_family() == rustix::net::AddressFamily::UNIX)
        {
            return Err(failure());
        }
        let flags = rustix::io::fcntl_getfd(&socket).map_err(|_| failure())?;
        rustix::io::fcntl_setfd(&socket, flags | rustix::io::FdFlags::CLOEXEC)
            .map_err(|_| failure())?;
        socket.set_nonblocking(true).map_err(|_| failure())?;
        socket
            .set_write_timeout(Some(Duration::from_secs(1)))
            .map_err(|_| failure())?;
        Ok(Self {
            socket,
            input: Vec::new(),
            receipts: BTreeMap::new(),
            park_id: None,
            claiming_park_id: None,
        })
    }

    pub(crate) fn receive(
        &mut self,
        parked: bool,
        remaining: Option<Duration>,
    ) -> Result<Option<HostRequest>, DurableRunnerError> {
        self.socket
            .set_nonblocking(!parked)
            .map_err(|_| failure())?;
        let deadline = remaining.map(|duration| Instant::now() + duration);
        loop {
            if let Some(end) = self.input.iter().position(|byte| *byte == b'\n') {
                let frame: Vec<_> = self.input.drain(..=end).collect();
                let request: HostRequest = serde_json::from_slice(&frame).map_err(|_| failure())?;
                return if request.valid() {
                    Ok(Some(request))
                } else {
                    Err(failure())
                };
            }
            if self.input.len() >= MAX_FRAME_BYTES {
                return Err(failure());
            }
            let mut bytes = [0; 1024];
            let available = bytes.len().min(MAX_FRAME_BYTES - self.input.len());
            let remaining =
                deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
            if remaining.is_some_and(|duration| duration.is_zero()) {
                return Ok(None);
            }
            self.socket
                .set_read_timeout(remaining)
                .map_err(|_| failure())?;
            match self.socket.read(&mut bytes[..available]) {
                Ok(0) => return Err(failure()),
                Ok(count) => self.input.extend_from_slice(&bytes[..count]),
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Ok(None)
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return Err(failure()),
            }
        }
    }

    /// A repeated successful request only replays its receipt, never its effect.
    pub(crate) fn replay(&mut self, request: &HostRequest) -> Result<bool, DurableRunnerError> {
        if let Some((fingerprint, status)) = self.receipts.get(request.id()) {
            let status = if *fingerprint == request.fingerprint() {
                *status
            } else {
                "conflict"
            };
            self.send(request.id(), status)?;
            return Ok(true);
        }
        Ok(false)
    }

    pub(crate) fn reply(
        &mut self,
        request: &HostRequest,
        status: &'static str,
    ) -> Result<(), DurableRunnerError> {
        if status != "conflict" {
            // A new exact park cut proves the preceding claim and run.attach
            // settled. Older requests now fail the identity/cut or parkId fence.
            if status == "parked" {
                self.receipts.clear();
            }
            self.receipts
                .insert(request.id().to_owned(), (request.fingerprint(), status));
        }
        self.send(request.id(), status)
    }

    fn send(&mut self, id: &str, status: &str) -> Result<(), DurableRunnerError> {
        let mut bytes = serde_json::to_vec(&serde_json::json!({"id":id,"status":status}))
            .map_err(|_| failure())?;
        bytes.push(b'\n');
        self.socket.set_nonblocking(false).map_err(|_| failure())?;
        let sent = self.socket.write_all(&bytes).map_err(|_| failure());
        self.socket.set_nonblocking(true).map_err(|_| failure())?;
        sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixDatagram;

    #[test]
    fn validates_connected_stream_and_sets_close_on_exec() {
        let (socket, _host) = UnixStream::pair().unwrap();
        let control = HostControl::new(socket).unwrap();
        assert!(rustix::io::fcntl_getfd(&control.socket)
            .unwrap()
            .contains(rustix::io::FdFlags::CLOEXEC));
        let (socket, _host) = UnixDatagram::pair().unwrap();
        let owned: OwnedFd = socket.into();
        assert!(HostControl::new(UnixStream::from(owned)).is_err());
    }

    #[test]
    fn bounds_frames_rejects_unknown_fields_and_observes_eof_without_logging_secrets() {
        for payload in ["x".repeat(MAX_FRAME_BYTES),
            "{\"op\":\"claim\",\"id\":\"claim\",\"parkId\":\"park\",\"bootstrapTicket\":\"private-ticket\",\"extra\":true}\n".to_owned()] {
            let (socket, mut host) = UnixStream::pair().unwrap();
            let mut control = HostControl::new(socket).unwrap();
            let writer = std::thread::spawn(move || host.write_all(payload.as_bytes()).unwrap());
            let error = match control.receive(true, Some(Duration::from_secs(1))) { Err(error) => error, _ => panic!("malformed input accepted") };
            assert_eq!(error.to_string(), "host control channel failed closed");
            writer.join().unwrap();
        }
        let (socket, host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        drop(host);
        assert!(control.receive(true, None).is_err());
    }

    #[test]
    fn partial_frame_cannot_extend_the_absolute_lifetime() {
        let (socket, mut host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        host.write_all(b"{").unwrap();
        let started = Instant::now();
        assert!(control
            .receive(true, Some(Duration::from_millis(30)))
            .unwrap()
            .is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
