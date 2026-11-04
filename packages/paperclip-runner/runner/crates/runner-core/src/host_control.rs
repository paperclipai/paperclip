//! Task-private host retention channel. Credentials never enter durable state.
//!
//! The host supplies a connected Unix stream inherited only by the Runner.
//! Requests and `{id, status}` responses are newline-delimited JSON. A request
//! frame is at most 16 KiB. `park` names the six-field Runner identity and the
//! acknowledged command/event cut; `claim` names that park and carries a fresh
//! bootstrap ticket; `retire` names the park and may include the claimed cut.
//!
//! This module parses and replies; it does not authorize or perform transitions.
//! The caller must validate the current identity, cut and park before acting.
//! It calls `replay` first: an identical completed request replays its response,
//! while a reused ID with a different payload returns `conflict`. A successful
//! `parked` reply starts a new receipt window. The caller must reject older
//! requests with the identity/cut/park fences after that window is cleared.
//!
//! Active reads are nonblocking. Parked reads wait on the socket, with an
//! optional absolute deadline for that receive. EOF and malformed frames fail
//! closed. No timer, process lifecycle, public endpoint or durable state is added.
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
    Retire {
        id: String,
        park_id: String,
        claim_id: Option<String>,
        identity: Option<HostIdentity>,
        last_controller_command_seq: Option<u64>,
        acked_source_seq: Option<u64>,
    },
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
                Self::Retire {
                    park_id, claim_id, ..
                } => id_valid(park_id) && claim_id.as_deref().is_none_or(id_valid),
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

    fn claim(id: &str, ticket: &str) -> HostRequest {
        HostRequest::Claim {
            id: id.into(),
            park_id: "park-1".into(),
            bootstrap_ticket: ticket.into(),
        }
    }

    fn read_reply(host: &mut UnixStream) -> serde_json::Value {
        use std::io::BufRead;
        host.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut line = String::new();
        std::io::BufReader::new(host).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn identical_retry_replays_response_and_changed_payload_conflicts() {
        let (socket, mut host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        let request = claim("claim-1", "private-ticket");
        assert!(!control.replay(&request).unwrap());
        control.reply(&request, "claimed").unwrap();
        let first = read_reply(&mut host);
        assert_eq!(
            first,
            serde_json::json!({"id":"claim-1", "status":"claimed"})
        );
        assert!(control.replay(&request).unwrap());
        assert_eq!(read_reply(&mut host), first);
        assert!(control.replay(&claim("claim-1", "changed-ticket")).unwrap());
        assert_eq!(
            read_reply(&mut host),
            serde_json::json!({"id":"claim-1", "status":"conflict"})
        );
        // A conflicting retry neither replaces the original receipt nor exposes a ticket.
        assert!(control.replay(&request).unwrap());
        assert_eq!(read_reply(&mut host), first);
    }

    #[test]
    fn conflict_does_not_reserve_a_request_id() {
        let (socket, mut host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        let request = claim("claim-1", "private-ticket");
        control.reply(&request, "conflict").unwrap();
        assert_eq!(read_reply(&mut host)["status"], "conflict");
        assert!(!control.replay(&request).unwrap());
    }

    #[test]
    fn successful_park_starts_a_new_receipt_window() {
        let (socket, mut host) = UnixStream::pair().unwrap();
        let mut control = HostControl::new(socket).unwrap();
        let old = claim("claim-1", "private-ticket");
        control.reply(&old, "claimed").unwrap();
        read_reply(&mut host);
        let park: HostRequest = serde_json::from_value(serde_json::json!({
            "op":"park", "id":"park-2", "identity": {
                "runnerInstanceId":"runner", "environmentLeaseId":"lease", "runId":"run",
                "normalizedSessionId":"session", "turnId":"turn", "itemId":"item"
            }, "lastControllerCommandSeq":12, "ackedSourceSeq":34
        }))
        .unwrap();
        control.reply(&park, "conflict").unwrap();
        read_reply(&mut host);
        assert!(control.replay(&old).unwrap());
        read_reply(&mut host);
        control.reply(&park, "parked").unwrap();
        let parked = read_reply(&mut host);
        assert!(!control.replay(&old).unwrap());
        assert!(control.replay(&park).unwrap());
        assert_eq!(read_reply(&mut host), parked);
        assert_eq!(control.receipts.len(), 1);
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
