use std::io::{self, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::server::ErrorResponse;
use tungstenite::handshake::HandshakeError;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{accept_hdr_with_config, client_tls_with_config, Connector, Message, WebSocket};

use super::state::{open_private_regular_file, Command, DurableState};
use super::{
    BootstrapTicket, DurableRunnerConfig, DurableRunnerError, Secret, PROTOCOL, PROTOCOL_VERSION,
};

const SECURE_FRAME_SCHEMA: &str = "paperclip.runner.secure-frame.v1";
const AUTH_TIMEOUT: Duration = Duration::from_secs(2);
const WELCOME_TIMEOUT: Duration = Duration::from_secs(2);
const RUNTIME_READ_TIMEOUT: Duration = Duration::from_millis(250);
const CONNECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CA_BUNDLE_BYTES: u64 = 4 * 1024 * 1024;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug)]
struct ParsedWsUrl {
    secure: bool,
    host: String,
    authority: String,
    port: u16,
    path: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedWsTarget {
    secure: bool,
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
}

impl ResolvedWsTarget {
    pub(crate) fn resolve(input: &str) -> Result<Self, DurableRunnerError> {
        resolve_ws_target_with(input, |host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    }

    fn request_url(&self) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{}{}", self.authority, self.path)
    }
}

fn parse_ws_url(input: &str) -> Result<ParsedWsUrl, DurableRunnerError> {
    let (secure, remainder, default_port) = if let Some(value) = input.strip_prefix("ws://") {
        (false, value, 80)
    } else if let Some(value) = input.strip_prefix("wss://") {
        (true, value, 443)
    } else {
        return Err(DurableRunnerError::invalid(
            "runner connect URL must use ws:// or wss://",
        ));
    };
    if remainder.is_empty()
        || remainder
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        || remainder.contains(['?', '#', '\\'])
    {
        return Err(DurableRunnerError::invalid(
            "WebSocket URL contains query, fragment, whitespace, or path ambiguity",
        ));
    }
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, "/".to_owned()), |(authority, path)| {
            (authority, format!("/{path}"))
        });
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(DurableRunnerError::invalid(
            "WebSocket authority must not contain userinfo or encoding ambiguity",
        ));
    }
    let (host, port) = if authority.starts_with('[') {
        let closing = authority
            .find(']')
            .ok_or_else(|| DurableRunnerError::invalid("bracketed IPv6 authority is malformed"))?;
        let host = &authority[1..closing];
        let suffix = &authority[closing + 1..];
        let port = if suffix.is_empty() {
            default_port.to_string()
        } else {
            suffix
                .strip_prefix(':')
                .ok_or_else(|| {
                    DurableRunnerError::invalid("bracketed IPv6 authority is malformed")
                })?
                .to_owned()
        };
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| DurableRunnerError::invalid("bracketed WebSocket host must be IPv6"))?;
        (host, port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .map_or((authority, default_port.to_string()), |(host, port)| {
                (host, port.to_owned())
            });
        if host.is_empty() || host.contains(':') {
            return Err(DurableRunnerError::invalid(
                "WebSocket host is empty or contains unbracketed IPv6",
            ));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .map_err(|error| DurableRunnerError::invalid(format!("invalid WebSocket port: {error}")))?;
    if port == 0 {
        return Err(DurableRunnerError::invalid(
            "WebSocket port must be non-zero",
        ));
    }
    Ok(ParsedWsUrl {
        secure,
        host: host.to_owned(),
        authority: authority.to_owned(),
        port,
        path,
    })
}

fn resolve_ws_target_with<F>(
    input: &str,
    resolver: F,
) -> Result<ResolvedWsTarget, DurableRunnerError>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    let parsed = parse_ws_url(input)?;
    let mut addresses = resolver(&parsed.host, parsed.port).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to resolve WebSocket destination: {error}"))
    })?;
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(DurableRunnerError::invalid(
            "WebSocket destination resolved to no addresses",
        ));
    }
    if !parsed.secure && addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err(DurableRunnerError::invalid(
            "plaintext WebSocket destinations must all resolve to loopback",
        ));
    }
    Ok(ResolvedWsTarget {
        secure: parsed.secure,
        authority: parsed.authority,
        path: parsed.path,
        addresses,
    })
}

pub(crate) enum RunnerTransportEndpoint {
    Dial(ResolvedWsTarget),
    Listen { listener: TcpListener, path: String },
}

impl RunnerTransportEndpoint {
    pub(crate) fn new(input: &str, run_id: &str) -> Result<Self, DurableRunnerError> {
        if let Some(remainder) = input.strip_prefix("listen://") {
            let (authority, path) = remainder.split_once('/').ok_or_else(|| {
                DurableRunnerError::invalid(
                    "runner_ingress_bind_conflict: listener path is required",
                )
            })?;
            if authority != "0.0.0.0:43127" {
                return Err(DurableRunnerError::invalid(
                    "runner_ingress_bind_conflict: listener must bind 0.0.0.0:43127",
                ));
            }
            let path = format!("/{path}");
            validate_listener_path(&path)?;
            if path != format!("/api/runner/v1/connect/{run_id}") {
                return Err(DurableRunnerError::invalid(
                    "runner listener path does not match the configured run",
                ));
            }
            let listener = TcpListener::bind(authority).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "runner_ingress_bind_conflict: failed to bind fixed listener: {error}"
                ))
            })?;
            listener.set_nonblocking(true).map_err(|error| {
                DurableRunnerError::invalid(format!(
                    "runner_ingress_bind_conflict: failed to configure listener: {error}"
                ))
            })?;
            return Ok(Self::Listen { listener, path });
        }
        Ok(Self::Dial(ResolvedWsTarget::resolve(input)?))
    }

    fn open(
        &self,
        max_frame_bytes: usize,
        ca_bundle_path: Option<&Path>,
        connect_deadline: Instant,
    ) -> Result<Option<RunnerSocket>, DurableRunnerError> {
        ensure_connection_deadline(connect_deadline)?;
        let websocket_config = || {
            WebSocketConfig::default()
                .max_message_size(Some(max_frame_bytes))
                .max_frame_size(Some(max_frame_bytes))
        };
        match self {
            Self::Dial(target) => {
                if ca_bundle_path.is_some() && !target.secure {
                    return Err(DurableRunnerError::invalid(
                        "--ca-bundle-path is accepted only with wss://",
                    ));
                }
                let stream = connect_pinned_addresses(&target.addresses, connect_deadline)?;
                let request = target
                    .request_url()
                    .into_client_request()
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!("invalid WebSocket request: {error}"))
                    })?;
                let deadline = bounded_operation_deadline(connect_deadline, AUTH_TIMEOUT)?;
                let connector = ca_bundle_path.map(custom_tls_connector).transpose()?;
                ensure_connection_deadline(deadline)?;
                stream.set_nonblocking(true).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "WebSocket stream configuration failed: {error}"
                    ))
                })?;
                let mut handshake =
                    client_tls_with_config(request, stream, Some(websocket_config()), connector);
                let mut socket = loop {
                    match handshake {
                        Ok((socket, _)) => break socket,
                        Err(HandshakeError::Interrupted(mid_handshake)) => {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            if remaining.is_zero() {
                                return Err(DurableRunnerError::invalid(
                                    "WebSocket upgrade deadline elapsed",
                                ));
                            }
                            thread::sleep(Duration::from_millis(5).min(remaining));
                            handshake = mid_handshake.handshake();
                        }
                        Err(error) => {
                            return Err(DurableRunnerError::invalid(format!(
                                "WebSocket upgrade failed: {error}"
                            )))
                        }
                    }
                };
                set_dial_stream_nonblocking(socket.get_mut(), false)?;
                let mut socket = RunnerSocket::Dial(socket);
                socket.configure_auth_timeouts(connect_deadline)?;
                Ok(Some(socket))
            }
            Self::Listen { listener, path } => {
                if ca_bundle_path.is_some() {
                    return Err(DurableRunnerError::invalid(
                        "--ca-bundle-path is not accepted in listener mode",
                    ));
                }
                let (stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                    Err(error) => {
                        return Err(DurableRunnerError::invalid(format!(
                            "runner ingress listener accept failed: {error}"
                        )))
                    }
                };
                stream.set_nonblocking(true).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "runner ingress stream configuration failed: {error}"
                    ))
                })?;
                let expected_path = path.clone();
                let mut handshake = accept_hdr_with_config(
                    stream,
                    move |request: &tungstenite::handshake::server::Request, response| {
                        if request.uri().path() != expected_path
                            || request.uri().query().is_some()
                            || request.headers().contains_key("sec-websocket-extensions")
                        {
                            let mut rejection = ErrorResponse::new(Some(
                                "runner listener requires the configured path without extensions"
                                    .to_owned(),
                            ));
                            *rejection.status_mut() = tungstenite::http::StatusCode::BAD_REQUEST;
                            return Err(rejection);
                        }
                        Ok(response)
                    },
                    Some(websocket_config()),
                );
                let deadline = bounded_operation_deadline(connect_deadline, AUTH_TIMEOUT)?;
                let mut socket = loop {
                    match handshake {
                        Ok(socket) => break socket,
                        Err(HandshakeError::Interrupted(mid_handshake)) => {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            if remaining.is_zero() {
                                return Err(DurableRunnerError::invalid(
                                    "runner ingress WebSocket upgrade deadline elapsed",
                                ));
                            }
                            thread::sleep(Duration::from_millis(5).min(remaining));
                            handshake = mid_handshake.handshake();
                        }
                        Err(error) => {
                            return Err(DurableRunnerError::invalid(format!(
                                "runner ingress WebSocket upgrade failed: {error}"
                            )))
                        }
                    }
                };
                socket.get_mut().set_nonblocking(false).map_err(|error| {
                    DurableRunnerError::invalid(format!(
                        "runner ingress stream configuration failed: {error}"
                    ))
                })?;
                configure_auth_timeouts(socket.get_ref(), connect_deadline)?;
                Ok(Some(RunnerSocket::Listen(socket)))
            }
        }
    }
}

fn validate_listener_path(path: &str) -> Result<(), DurableRunnerError> {
    let run_id = path
        .strip_prefix("/api/runner/v1/connect/")
        .filter(|run_id| !run_id.is_empty() && !run_id.contains('/'));
    if run_id.is_none()
        || path.contains(['?', '#', '\\', '%'])
        || path
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
    {
        return Err(DurableRunnerError::invalid(
            "runner listener path is invalid",
        ));
    }
    Ok(())
}

fn ensure_connection_deadline(deadline: Instant) -> Result<(), DurableRunnerError> {
    if Instant::now() >= deadline {
        return Err(DurableRunnerError::invalid(
            "transport connection lifecycle deadline elapsed",
        ));
    }
    Ok(())
}

fn bounded_operation_deadline(
    lifecycle_deadline: Instant,
    operation_budget: Duration,
) -> Result<Instant, DurableRunnerError> {
    ensure_connection_deadline(lifecycle_deadline)?;
    Ok(lifecycle_deadline.min(Instant::now() + operation_budget))
}

fn configure_auth_timeouts(
    stream: &TcpStream,
    lifecycle_deadline: Instant,
) -> Result<(), DurableRunnerError> {
    let deadline = bounded_operation_deadline(lifecycle_deadline, AUTH_TIMEOUT)?;
    let timeout = deadline.saturating_duration_since(Instant::now());
    if timeout.is_zero() {
        return Err(DurableRunnerError::invalid(
            "transport connection lifecycle deadline elapsed",
        ));
    }
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))
}

fn set_dial_stream_nonblocking(
    stream: &mut MaybeTlsStream<TcpStream>,
    nonblocking: bool,
) -> Result<(), DurableRunnerError> {
    let result = match stream {
        MaybeTlsStream::Plain(stream) => stream.set_nonblocking(nonblocking),
        MaybeTlsStream::Rustls(stream) => stream.sock.set_nonblocking(nonblocking),
        _ => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported TLS stream",
        )),
    };
    result.map_err(|error| {
        DurableRunnerError::invalid(format!("WebSocket stream configuration failed: {error}"))
    })
}

fn connect_pinned_addresses(
    addresses: &[SocketAddr],
    lifecycle_deadline: Instant,
) -> Result<TcpStream, DurableRunnerError> {
    connect_pinned_addresses_with(
        addresses,
        lifecycle_deadline,
        CONNECT_TOTAL_TIMEOUT,
        CONNECT_ATTEMPT_TIMEOUT,
        TcpStream::connect_timeout,
    )
}

fn connect_pinned_addresses_with<T, F>(
    addresses: &[SocketAddr],
    lifecycle_deadline: Instant,
    total_budget: Duration,
    attempt_budget: Duration,
    mut connect: F,
) -> Result<T, DurableRunnerError>
where
    F: FnMut(&SocketAddr, Duration) -> io::Result<T>,
{
    if addresses.is_empty() || total_budget.is_zero() || attempt_budget.is_zero() {
        return Err(DurableRunnerError::invalid(
            "WebSocket connect requires pinned addresses and non-zero timeout budgets",
        ));
    }
    let started = Instant::now();
    let transport_deadline = started + total_budget;
    let deadline = lifecycle_deadline.min(transport_deadline);
    if deadline <= started {
        return Err(DurableRunnerError::invalid(
            "WebSocket connect lifecycle deadline elapsed before dialing",
        ));
    }
    let effective_budget = deadline.saturating_duration_since(started);
    let mut ordered = addresses.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    let mut attempted = 0_usize;
    let mut last_failure: Option<(SocketAddr, io::Error)> = None;
    for address in &ordered {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        attempted += 1;
        match connect(address, attempt_budget.min(remaining)) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_failure = Some((*address, error)),
        }
    }
    let suffix = last_failure.map_or_else(
        || "the total connection budget elapsed before an attempt".to_owned(),
        |(address, error)| format!("last attempt {address} failed: {error}"),
    );
    Err(DurableRunnerError::invalid(format!(
        "WebSocket connect failed after {attempted}/{} pinned address attempts within {} ms; {suffix}",
        ordered.len(),
        effective_budget.as_millis(),
    )))
}

fn custom_tls_connector(path: &Path) -> Result<Connector, DurableRunnerError> {
    let file = open_private_regular_file(path).map_err(|error| {
        DurableRunnerError::invalid(format!("failed to open private CA bundle: {error}"))
    })?;
    if file
        .metadata()
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?
        .len()
        > MAX_CA_BUNDLE_BYTES
    {
        return Err(DurableRunnerError::invalid(
            "private CA bundle exceeds the 4 MiB limit",
        ));
    }
    let native = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(native.certs);
    let mut reader = BufReader::new(file);
    let certificates = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DurableRunnerError::invalid(format!("invalid CA bundle: {error}")))?;
    if certificates.is_empty() {
        return Err(DurableRunnerError::invalid(
            "private CA bundle contains no certificates",
        ));
    }
    let (added, _) = roots.add_parsable_certificates(certificates);
    if added == 0 {
        return Err(DurableRunnerError::invalid(
            "private CA bundle contains no usable certificates",
        ));
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

enum RunnerSocket {
    Dial(WebSocket<MaybeTlsStream<TcpStream>>),
    Listen(WebSocket<TcpStream>),
}

trait WebSocketMessages {
    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error>;
    fn read_message(&mut self) -> Result<Message, tungstenite::Error>;
}

impl<S: Read + Write> WebSocketMessages for WebSocket<S> {
    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
        self.send(message)
    }

    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        self.read()
    }
}

impl WebSocketMessages for RunnerSocket {
    fn send_message(&mut self, message: Message) -> Result<(), tungstenite::Error> {
        match self {
            Self::Dial(socket) => socket.send(message),
            Self::Listen(socket) => socket.send(message),
        }
    }

    fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
        match self {
            Self::Dial(socket) => socket.read(),
            Self::Listen(socket) => socket.read(),
        }
    }
}

impl RunnerSocket {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Dial(socket) => match socket.get_mut() {
                MaybeTlsStream::Plain(stream) => stream.set_read_timeout(timeout),
                MaybeTlsStream::Rustls(stream) => stream.sock.set_read_timeout(timeout),
                _ => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "unsupported TLS stream",
                )),
            },
            Self::Listen(socket) => socket.get_mut().set_read_timeout(timeout),
        }
    }

    fn set_write_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Dial(socket) => match socket.get_mut() {
                MaybeTlsStream::Plain(stream) => stream.set_write_timeout(timeout),
                MaybeTlsStream::Rustls(stream) => stream.sock.set_write_timeout(timeout),
                _ => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "unsupported TLS stream",
                )),
            },
            Self::Listen(socket) => socket.get_mut().set_write_timeout(timeout),
        }
    }

    #[cfg(test)]
    fn read_timeout(&self) -> io::Result<Option<Duration>> {
        match self {
            Self::Dial(socket) => match socket.get_ref() {
                MaybeTlsStream::Plain(stream) => stream.read_timeout(),
                MaybeTlsStream::Rustls(stream) => stream.sock.read_timeout(),
                _ => Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "unsupported TLS stream",
                )),
            },
            Self::Listen(socket) => socket.get_ref().read_timeout(),
        }
    }

    fn configure_auth_timeouts(
        &mut self,
        lifecycle_deadline: Instant,
    ) -> Result<Instant, DurableRunnerError> {
        let deadline = bounded_operation_deadline(lifecycle_deadline, AUTH_TIMEOUT)?;
        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            return Err(DurableRunnerError::invalid(
                "transport connection lifecycle deadline elapsed",
            ));
        }
        self.set_read_timeout(Some(timeout))
            .and_then(|()| self.set_write_timeout(Some(timeout)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        Ok(deadline)
    }
}

fn send_auth_plain(
    socket: &mut RunnerSocket,
    value: &Value,
    max_frame_bytes: usize,
    lifecycle_deadline: Instant,
) -> Result<(), DurableRunnerError> {
    socket.configure_auth_timeouts(lifecycle_deadline)?;
    send_plain(socket, value, max_frame_bytes)?;
    ensure_connection_deadline(lifecycle_deadline)
}

fn send_auth_response_plain(
    socket: &mut RunnerSocket,
    value: &Value,
    max_frame_bytes: usize,
    lifecycle_deadline: Instant,
    send_started: &mut bool,
) -> Result<(), DurableRunnerError> {
    socket.configure_auth_timeouts(lifecycle_deadline)?;
    let message = encode_plain_message(value, max_frame_bytes)?;
    // A write error can occur after the peer receives the complete response,
    // so the one-use ticket becomes ambiguous immediately before this call.
    *send_started = true;
    socket.send_message(message).map_err(map_websocket_error)?;
    ensure_connection_deadline(lifecycle_deadline)
}

#[derive(Debug)]
struct CredentialMaterial {
    credential_id: String,
    auth_key: [u8; 32],
}

impl CredentialMaterial {
    fn from_token(token: &str) -> Self {
        Self {
            credential_id: format!(
                "sha256:{}",
                hex_encode(&digest_domain(
                    "paperclip-runner-credential-id-v1",
                    &[token.as_bytes()]
                ))
            ),
            auth_key: digest_domain("paperclip-runner-auth-key-v1", &[token.as_bytes()]),
        }
    }
}

impl Drop for CredentialMaterial {
    fn drop(&mut self) {
        self.auth_key.fill(0);
    }
}

#[derive(Debug)]
pub(crate) struct LeaseCredential {
    pub(crate) lease_id: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) revocation_epoch: u64,
    token: Secret,
}

impl LeaseCredential {
    fn expose(&self) -> Result<&str, DurableRunnerError> {
        self.token.expose()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ConnectionMetadata {
    pub(crate) connection_id: String,
    pub(crate) lease_id: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) revocation_epoch: u64,
}

#[derive(Debug)]
pub(crate) struct Welcome {
    pub(crate) connection: ConnectionMetadata,
    pub(crate) lease: Option<LeaseCredential>,
    pub(crate) acked_source_seq: Option<u64>,
    pub(crate) pending_commands: Vec<Command>,
}

struct SecureChannel {
    send_cipher: Aes256Gcm,
    receive_cipher: Aes256Gcm,
    send_counter: u64,
    receive_counter: u64,
    session_id: String,
}

impl SecureChannel {
    fn client(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
    ) -> Result<Self, DurableRunnerError> {
        Self::new(auth_key, challenge, server_proof, client_proof, false)
    }

    #[cfg(test)]
    fn server(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
    ) -> Result<Self, DurableRunnerError> {
        Self::new(auth_key, challenge, server_proof, client_proof, true)
    }

    fn new(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
        server_direction: bool,
    ) -> Result<Self, DurableRunnerError> {
        let session_binding = digest_domain(
            "paperclip-runner-session-binding-v1",
            &[challenge, server_proof, client_proof],
        );
        let client_to_server = hmac_domain(
            auth_key,
            "paperclip-runner-client-to-core-key-v1",
            &[&session_binding],
        );
        let server_to_client = hmac_domain(
            auth_key,
            "paperclip-runner-core-to-client-key-v1",
            &[&session_binding],
        );
        let (send_key, receive_key) = if server_direction {
            (server_to_client, client_to_server)
        } else {
            (client_to_server, server_to_client)
        };
        Ok(Self {
            send_cipher: Aes256Gcm::new_from_slice(&send_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize encryption"))?,
            receive_cipher: Aes256Gcm::new_from_slice(&receive_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize decryption"))?,
            send_counter: 0,
            receive_counter: 0,
            session_id: format!("sha256:{}", hex_encode(&session_binding)),
        })
    }

    fn nonce(direction: &[u8; 4], counter: u64) -> [u8; 12] {
        let mut nonce = [0_u8; 12];
        nonce[..4].copy_from_slice(direction);
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    fn aad(&self, direction: &str, counter: u64) -> Vec<u8> {
        format!(
            "{SECURE_FRAME_SCHEMA}\0{}\0{direction}\0{counter}",
            self.session_id
        )
        .into_bytes()
    }

    fn encrypt(
        &mut self,
        plaintext: &[u8],
        server_direction: bool,
    ) -> Result<Value, DurableRunnerError> {
        let counter = self.send_counter;
        let direction = if server_direction { b"P3S1" } else { b"P3C1" };
        let label = if server_direction {
            "core_to_client"
        } else {
            "client_to_core"
        };
        let nonce = Self::nonce(direction, counter);
        let aad = self.aad(label, counter);
        let ciphertext = self
            .send_cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| DurableRunnerError::invalid("secure transport encryption failed"))?;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("secure send counter exhausted"))?;
        Ok(json!({
            "schema": SECURE_FRAME_SCHEMA,
            "counter": counter,
            "ciphertext": hex_encode(&ciphertext),
        }))
    }

    fn decrypt(
        &mut self,
        frame: &Value,
        server_direction: bool,
    ) -> Result<Value, DurableRunnerError> {
        if frame.get("schema").and_then(Value::as_str) != Some(SECURE_FRAME_SCHEMA) {
            return Err(DurableRunnerError::invalid(
                "unauthenticated plaintext control frame was rejected",
            ));
        }
        let counter = frame
            .get("counter")
            .and_then(Value::as_u64)
            .ok_or_else(|| DurableRunnerError::invalid("secure frame counter is required"))?;
        if counter != self.receive_counter {
            return Err(DurableRunnerError::invalid(
                "secure frame counter was replayed or arrived out of order",
            ));
        }
        let ciphertext = frame
            .get("ciphertext")
            .and_then(Value::as_str)
            .ok_or_else(|| DurableRunnerError::invalid("secure frame ciphertext is required"))?;
        let ciphertext = hex_decode(ciphertext)?;
        let direction = if server_direction { b"P3C1" } else { b"P3S1" };
        let label = if server_direction {
            "client_to_core"
        } else {
            "core_to_client"
        };
        let nonce = Self::nonce(direction, counter);
        let aad = self.aad(label, counter);
        let plaintext = self
            .receive_cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| DurableRunnerError::invalid("secure frame authentication failed"))?;
        self.receive_counter = self
            .receive_counter
            .checked_add(1)
            .ok_or_else(|| DurableRunnerError::invalid("secure receive counter exhausted"))?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            DurableRunnerError::invalid(format!("secure JSON is malformed: {error}"))
        })
    }
}

pub(crate) struct AuthenticatedTransport {
    socket: RunnerSocket,
    secure_channel: SecureChannel,
    max_frame_bytes: usize,
}

#[derive(Debug)]
pub(crate) struct ConnectFailure {
    error: DurableRunnerError,
    pub(crate) bootstrap_maybe_consumed: bool,
}

impl std::fmt::Display for ConnectFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl ConnectFailure {
    fn retryable(error: DurableRunnerError) -> Self {
        Self {
            error,
            bootstrap_maybe_consumed: false,
        }
    }

    fn after_auth_started(
        error: DurableRunnerError,
        credential_kind: &str,
        bootstrap_may_have_been_consumed: bool,
    ) -> Self {
        Self {
            error,
            bootstrap_maybe_consumed: credential_kind == "bootstrap"
                && bootstrap_may_have_been_consumed,
        }
    }
}

impl AuthenticatedTransport {
    pub(crate) fn connect(
        endpoint: &RunnerTransportEndpoint,
        config: &DurableRunnerConfig,
        state: &DurableState,
        bootstrap: Option<&BootstrapTicket>,
        lease: Option<&LeaseCredential>,
        connect_deadline: Instant,
    ) -> Result<Option<(Self, Welcome)>, ConnectFailure> {
        let (credential_token, credential_kind, expected_lease) = match (lease, bootstrap) {
            (Some(lease), _) => (
                lease.expose().map_err(ConnectFailure::retryable)?,
                "lease",
                Some(lease),
            ),
            (None, Some(bootstrap)) => (
                bootstrap.expose().map_err(ConnectFailure::retryable)?,
                "bootstrap",
                None,
            ),
            (None, None) => {
                return Err(ConnectFailure::retryable(DurableRunnerError::invalid(
                    "a bootstrap or unexpired connection lease is required",
                )))
            }
        };
        let credential = CredentialMaterial::from_token(credential_token);
        let Some(mut socket) = endpoint
            .open(
                config.max_frame_bytes,
                config.ca_bundle_path.as_deref(),
                connect_deadline,
            )
            .map_err(ConnectFailure::retryable)?
        else {
            return Ok(None);
        };
        let mut auth_response_send_started = false;

        let authenticate = || -> Result<(Self, Welcome), DurableRunnerError> {
            let client_nonce = random_nonce()?;
            send_auth_plain(
                &mut socket,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_hello",
                    "payload": {
                        "credentialId": credential.credential_id,
                        "credentialKind": credential_kind,
                        "clientNonce": client_nonce,
                        "protocolMin": PROTOCOL_VERSION,
                        "protocolMax": PROTOCOL_VERSION,
                        "runnerInstanceId": state.runner_instance_id,
                        "environmentLeaseId": state.environment_lease_id,
                        "runId": state.run_id,
                        "normalizedSessionId": state.normalized_session_id,
                        "turnId": state.turn_id,
                        "itemId": state.item_id,
                        "runnerVersion": config.runner_version,
                        "runnerDigest": config.runner_digest,
                        "resume": {
                            "lastControllerCommandSeq": state.last_controller_command_seq,
                            "nextSourceEventSeq": state.next_source_seq,
                            "ackedSourceSeq": state.acked_source_seq,
                        },
                    },
                }),
                config.max_frame_bytes,
                connect_deadline,
            )?;

            let challenge_deadline = socket.configure_auth_timeouts(connect_deadline)?;
            let challenge_value =
                receive_plain_until(&mut socket, config.max_frame_bytes, challenge_deadline)?;
            validate_envelope_kind(&challenge_value, "auth_challenge")?;
            let challenge: AuthChallenge = serde_json::from_value(
                challenge_value
                    .get("payload")
                    .cloned()
                    .ok_or_else(|| DurableRunnerError::invalid("challenge payload is required"))?,
            )
            .map_err(|error| {
                DurableRunnerError::invalid(format!("invalid auth challenge: {error}"))
            })?;
            validate_challenge(
                &challenge,
                state,
                config,
                &credential,
                credential_kind,
                &client_nonce,
                expected_lease,
            )?;
            let signing_bytes = challenge_signing_bytes(&challenge);
            verify_hmac_hex(
                &credential.auth_key,
                "paperclip-runner-server-proof-v1",
                &[&signing_bytes],
                &challenge.server_proof,
            )?;
            let client_proof = hex_encode(&hmac_domain(
                &credential.auth_key,
                "paperclip-runner-client-proof-v1",
                &[&signing_bytes, challenge.server_proof.as_bytes()],
            ));
            send_auth_response_plain(
                &mut socket,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_response",
                    "payload": {
                        "credentialId": credential.credential_id,
                        "clientNonce": client_nonce,
                        "serverNonce": challenge.server_nonce,
                        "clientProof": client_proof,
                    },
                }),
                config.max_frame_bytes,
                connect_deadline,
                &mut auth_response_send_started,
            )?;
            let secure_channel = SecureChannel::client(
                &credential.auth_key,
                &signing_bytes,
                challenge.server_proof.as_bytes(),
                client_proof.as_bytes(),
            )?;
            let mut transport = Self {
                socket,
                secure_channel,
                max_frame_bytes: config.max_frame_bytes,
            };
            // Ticket validation and lease persistence happen before the server
            // emits welcome. Keep that work bounded without assuming a loaded
            // control-plane event loop can always respond within 250 ms.
            let welcome_deadline = bounded_operation_deadline(connect_deadline, WELCOME_TIMEOUT)?;
            let welcome_timeout = welcome_deadline.saturating_duration_since(Instant::now());
            if welcome_timeout.is_zero() {
                return Err(DurableRunnerError::invalid(
                    "transport connection lifecycle deadline elapsed",
                ));
            }
            transport
                .socket
                .set_read_timeout(Some(welcome_timeout))
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            let mut welcome_value = transport
                .receive_json_until(Some(welcome_deadline))?
                .ok_or_else(|| DurableRunnerError::invalid("authenticated welcome timed out"))?;
            let welcome =
                validate_welcome(&mut welcome_value, state, credential_kind, expected_lease)?;
            // Authentication can wait longer for control-plane validation, but
            // the steady-state runner loop must return to provider polling
            // promptly when no control message is available.
            transport
                .socket
                .set_read_timeout(Some(RUNTIME_READ_TIMEOUT))
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            ensure_connection_deadline(connect_deadline)?;
            Ok((transport, welcome))
        };
        let result = authenticate();
        result.map(Some).map_err(|error| {
            ConnectFailure::after_auth_started(error, credential_kind, auth_response_send_started)
        })
    }

    pub(crate) fn send_json(&mut self, value: &Value) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec(value)
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        if bytes.len() > self.max_frame_bytes {
            return Err(DurableRunnerError::invalid(
                "outbound secure frame exceeds the configured limit",
            ));
        }
        let frame = self.secure_channel.encrypt(&bytes, false)?;
        send_plain(&mut self.socket, &frame, self.max_frame_bytes)
    }

    pub(crate) fn receive_json(&mut self) -> Result<Option<Value>, DurableRunnerError> {
        self.receive_json_until(None)
    }

    fn receive_json_until(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<Option<Value>, DurableRunnerError> {
        let frame =
            match receive_plain_optional_until(&mut self.socket, self.max_frame_bytes, deadline)? {
                Some(frame) => frame,
                None => return Ok(None),
            };
        self.secure_channel.decrypt(&frame, false).map(Some)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthChallenge {
    credential_id: String,
    credential_kind: String,
    client_nonce: String,
    server_nonce: String,
    runner_instance_id: String,
    environment_lease_id: String,
    run_id: String,
    normalized_session_id: String,
    turn_id: String,
    item_id: String,
    runner_version: String,
    runner_digest: String,
    selected_version: u64,
    credential_expires_at: String,
    credential_expires_at_unix_ms: u64,
    credential_lease_id: Option<String>,
    revocation_epoch: u64,
    server_proof: String,
}

fn validate_challenge(
    challenge: &AuthChallenge,
    state: &DurableState,
    config: &DurableRunnerConfig,
    credential: &CredentialMaterial,
    credential_kind: &str,
    client_nonce: &str,
    expected_lease: Option<&LeaseCredential>,
) -> Result<(), DurableRunnerError> {
    for (field, actual, expected) in [
        (
            "credentialId",
            challenge.credential_id.as_str(),
            credential.credential_id.as_str(),
        ),
        (
            "credentialKind",
            challenge.credential_kind.as_str(),
            credential_kind,
        ),
        ("clientNonce", challenge.client_nonce.as_str(), client_nonce),
        (
            "runnerInstanceId",
            challenge.runner_instance_id.as_str(),
            state.runner_instance_id.as_str(),
        ),
        (
            "environmentLeaseId",
            challenge.environment_lease_id.as_str(),
            state.environment_lease_id.as_str(),
        ),
        ("runId", challenge.run_id.as_str(), state.run_id.as_str()),
        (
            "normalizedSessionId",
            challenge.normalized_session_id.as_str(),
            state.normalized_session_id.as_str(),
        ),
        ("turnId", challenge.turn_id.as_str(), state.turn_id.as_str()),
        ("itemId", challenge.item_id.as_str(), state.item_id.as_str()),
        (
            "runnerVersion",
            challenge.runner_version.as_str(),
            config.runner_version.as_str(),
        ),
        (
            "runnerDigest",
            challenge.runner_digest.as_str(),
            config.runner_digest.as_str(),
        ),
    ] {
        if actual != expected {
            return Err(DurableRunnerError::invalid(format!(
                "authentication challenge {field} does not match this session"
            )));
        }
    }
    if challenge.server_nonce.is_empty()
        || challenge.selected_version != PROTOCOL_VERSION
        || challenge.credential_expires_at_unix_ms <= current_unix_ms()?
    {
        return Err(DurableRunnerError::invalid(
            "authentication challenge is expired or selected an unsupported protocol",
        ));
    }
    match expected_lease {
        Some(lease)
            if challenge.credential_lease_id.as_deref() == Some(lease.lease_id.as_str())
                && challenge.credential_expires_at_unix_ms == lease.expires_at_unix_ms
                && challenge.revocation_epoch == lease.revocation_epoch => {}
        None if challenge.credential_lease_id.is_none() => {}
        _ => {
            return Err(DurableRunnerError::invalid(
                "authentication challenge changed the credential lease binding",
            ))
        }
    }
    Ok(())
}

fn challenge_signing_bytes(challenge: &AuthChallenge) -> Vec<u8> {
    canonical_json(&json!({
        "credentialId": challenge.credential_id,
        "credentialKind": challenge.credential_kind,
        "clientNonce": challenge.client_nonce,
        "serverNonce": challenge.server_nonce,
        "runnerInstanceId": challenge.runner_instance_id,
        "environmentLeaseId": challenge.environment_lease_id,
        "runId": challenge.run_id,
        "normalizedSessionId": challenge.normalized_session_id,
        "turnId": challenge.turn_id,
        "itemId": challenge.item_id,
        "runnerVersion": challenge.runner_version,
        "runnerDigest": challenge.runner_digest,
        "selectedVersion": challenge.selected_version,
        "credentialLeaseId": challenge.credential_lease_id,
        "credentialExpiresAt": challenge.credential_expires_at,
        "credentialExpiresAtUnixMs": challenge.credential_expires_at_unix_ms,
        "revocationEpoch": challenge.revocation_epoch,
    }))
    .into_bytes()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("serialize JSON string"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("serialize JSON key"),
                        canonical_json(&values[*key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn validate_welcome(
    value: &mut Value,
    state: &DurableState,
    credential_kind: &str,
    expected_lease: Option<&LeaseCredential>,
) -> Result<Welcome, DurableRunnerError> {
    validate_control_identity(value, state, None)?;
    validate_envelope_kind(value, "welcome")?;
    let connection_id = required_string(value, "connectionId")?.to_owned();
    let connection_lease_id = required_string(value, "connectionLeaseId")?.to_owned();
    let payload = value
        .get_mut("payload")
        .ok_or_else(|| DurableRunnerError::invalid("welcome payload is required"))?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || payload.get("connectionLeaseId").and_then(Value::as_str)
            != Some(connection_lease_id.as_str())
    {
        return Err(DurableRunnerError::invalid(
            "welcome protocol or lease identity is inconsistent",
        ));
    }
    let expires_at_unix_ms = payload
        .get("connectionLeaseExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome lease expiry is required"))?;
    if expires_at_unix_ms <= current_unix_ms()? {
        return Err(DurableRunnerError::invalid(
            "welcome carried an expired connection lease",
        ));
    }
    let revocation_epoch = payload
        .get("connectionLeaseRevocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome revocation epoch is required"))?;
    if let Some(expected) = expected_lease {
        if connection_lease_id != expected.lease_id
            || expires_at_unix_ms != expected.expires_at_unix_ms
            || revocation_epoch != expected.revocation_epoch
        {
            return Err(DurableRunnerError::invalid(
                "welcome changed the authenticated connection lease binding",
            ));
        }
    }
    let lease = match payload.get_mut("connectionLeaseToken") {
        Some(Value::String(token)) if credential_kind == "bootstrap" && !token.is_empty() => {
            let token = std::mem::take(token);
            Some(LeaseCredential {
                lease_id: connection_lease_id.clone(),
                expires_at_unix_ms,
                revocation_epoch,
                token: Secret::new(token),
            })
        }
        None | Some(Value::Null) if credential_kind == "lease" => None,
        _ => {
            return Err(DurableRunnerError::invalid(
                "bootstrap welcome must exchange the ticket for a connection lease token",
            ))
        }
    };
    let pending_commands = payload
        .get("pendingCommands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .cloned()
                .map(|command| {
                    serde_json::from_value(command).map_err(|error| {
                        DurableRunnerError::invalid(format!("invalid pending command: {error}"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Welcome {
        connection: ConnectionMetadata {
            connection_id,
            lease_id: connection_lease_id,
            expires_at_unix_ms,
            revocation_epoch,
        },
        lease,
        acked_source_seq: payload.get("ackedSourceSeq").and_then(Value::as_u64),
        pending_commands,
    })
}

pub(crate) fn validate_control_identity(
    value: &Value,
    state: &DurableState,
    connection: Option<&ConnectionMetadata>,
) -> Result<(), DurableRunnerError> {
    if value.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
    {
        return Err(DurableRunnerError::invalid(
            "control envelope protocol identity is invalid",
        ));
    }
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
        ("turnId", state.turn_id.as_str()),
        ("itemId", state.item_id.as_str()),
    ] {
        if required_string(value, field)? != expected {
            return Err(DurableRunnerError::invalid(format!(
                "control envelope {field} does not match the authenticated session"
            )));
        }
    }
    if let Some(connection) = connection {
        if required_string(value, "connectionId")? != connection.connection_id
            || required_string(value, "connectionLeaseId")? != connection.lease_id
            || current_unix_ms()? >= connection.expires_at_unix_ms
        {
            return Err(DurableRunnerError::invalid(
                "control envelope connection lease is mismatched or expired",
            ));
        }
    }
    Ok(())
}

fn validate_envelope_kind(value: &Value, kind: &str) -> Result<(), DurableRunnerError> {
    if value.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || value.get("kind").and_then(Value::as_str) != Some(kind)
    {
        return Err(DurableRunnerError::invalid(format!(
            "expected a PRP v1 {kind} envelope"
        )));
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, DurableRunnerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DurableRunnerError::invalid(format!("{field} is required")))
}

fn send_plain(
    socket: &mut (impl WebSocketMessages + ?Sized),
    value: &Value,
    max_frame_bytes: usize,
) -> Result<(), DurableRunnerError> {
    let message = encode_plain_message(value, max_frame_bytes)?;
    socket.send_message(message).map_err(map_websocket_error)
}

fn encode_plain_message(
    value: &Value,
    max_frame_bytes: usize,
) -> Result<Message, DurableRunnerError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    if bytes.len() > max_frame_bytes {
        return Err(DurableRunnerError::invalid(
            "outbound WebSocket message exceeds the configured limit",
        ));
    }
    let text =
        String::from_utf8(bytes).map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    Ok(Message::Text(text.into()))
}

fn receive_plain(
    socket: &mut (impl WebSocketMessages + ?Sized),
    max_frame_bytes: usize,
) -> Result<Value, DurableRunnerError> {
    receive_plain_optional_until(socket, max_frame_bytes, Some(Instant::now() + AUTH_TIMEOUT))?
        .ok_or_else(|| DurableRunnerError::invalid("WebSocket message timed out"))
}

fn receive_plain_until(
    socket: &mut (impl WebSocketMessages + ?Sized),
    max_frame_bytes: usize,
    deadline: Instant,
) -> Result<Value, DurableRunnerError> {
    receive_plain_optional_until(socket, max_frame_bytes, Some(deadline))?
        .ok_or_else(|| DurableRunnerError::invalid("WebSocket message timed out"))
}

fn receive_plain_optional_until(
    socket: &mut (impl WebSocketMessages + ?Sized),
    max_frame_bytes: usize,
    deadline: Option<Instant>,
) -> Result<Option<Value>, DurableRunnerError> {
    loop {
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(DurableRunnerError::invalid(
                "WebSocket authentication message deadline elapsed",
            ));
        }
        let message = socket.read_message();
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err(DurableRunnerError::invalid(
                "WebSocket authentication message deadline elapsed",
            ));
        }
        match message {
            Ok(Message::Text(text)) => {
                if text.len() > max_frame_bytes {
                    return Err(DurableRunnerError::invalid(
                        "inbound WebSocket message exceeds the configured limit",
                    ));
                }
                return serde_json::from_slice(text.as_bytes())
                    .map(Some)
                    .map_err(|error| {
                        DurableRunnerError::invalid(format!("malformed WebSocket JSON: {error}"))
                    });
            }
            Ok(Message::Ping(payload)) => socket
                .send_message(Message::Pong(payload))
                .map_err(map_websocket_error)?,
            Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => {
                return Err(DurableRunnerError::invalid(
                    "WebSocket peer closed the connection",
                ))
            }
            Ok(_) => {
                return Err(DurableRunnerError::invalid(
                    "binary and continuation WebSocket messages are not accepted",
                ))
            }
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(None)
            }
            Err(error) => return Err(map_websocket_error(error)),
        }
    }
}

fn map_websocket_error(error: tungstenite::Error) -> DurableRunnerError {
    DurableRunnerError::invalid(format!("WebSocket transport failed: {error}"))
}

fn random_nonce() -> Result<String, DurableRunnerError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        DurableRunnerError::invalid(format!("secure randomness failed: {error}"))
    })?;
    Ok(hex_encode(&bytes))
}

pub(crate) fn current_unix_ms() -> Result<u64, DurableRunnerError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| DurableRunnerError::invalid(format!("system clock is invalid: {error}")))?
        .as_millis();
    u64::try_from(millis).map_err(|_| DurableRunnerError::invalid("system clock overflowed"))
}

fn digest_domain(domain: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(domain.as_bytes());
    digest.update([0]);
    for part in parts {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    digest.finalize().into()
}

fn hmac_domain(key: &[u8], domain: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts keys of every length");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

fn verify_hmac_hex(
    key: &[u8],
    domain: &str,
    parts: &[&[u8]],
    expected: &str,
) -> Result<(), DurableRunnerError> {
    let expected = hex_decode(expected)?;
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts keys of every length");
    mac.update(domain.as_bytes());
    mac.update(&[0]);
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.verify_slice(&expected)
        .map_err(|_| DurableRunnerError::invalid("transport authentication proof is invalid"))
}

fn hex_encode(input: &[u8]) -> String {
    input.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(input: &str) -> Result<Vec<u8>, DurableRunnerError> {
    if input.len() % 2 != 0 {
        return Err(DurableRunnerError::invalid("hex value has an odd length"));
    }
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0])?;
            let low = hex_nibble(pair[1])?;
            Ok(high << 4 | low)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Result<u8, DurableRunnerError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(DurableRunnerError::invalid(
            "hex value contains invalid characters",
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, TcpListener};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    use tungstenite::{accept, client};

    use super::*;

    fn config(port: u16) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: format!("ws://127.0.0.1:{port}/api/runner/v1/connect/run_1"),
            ca_bundle_path: None,
            state_dir: PathBuf::from("unused"),
            runner_instance_id: "runner_1".to_owned(),
            environment_lease_id: "environment_1".to_owned(),
            run_id: "run_1".to_owned(),
            normalized_session_id: "session_1".to_owned(),
            turn_id: "turn_1".to_owned(),
            item_id: "item_1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 64 * 1024,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(1),
        }
    }

    fn test_state(config: &DurableRunnerConfig) -> DurableState {
        DurableState::new(config)
    }

    struct ServerCredential<'a> {
        token: &'a str,
        kind: &'a str,
        lease_id: Option<&'a str>,
        expires_at_unix_ms: u64,
        revocation_epoch: u64,
    }

    fn server_authenticate(
        socket: &mut WebSocket<TcpStream>,
        config: &DurableRunnerConfig,
        state: &DurableState,
        server_credential: ServerCredential<'_>,
    ) -> SecureChannel {
        let hello = receive_plain(socket, config.max_frame_bytes).unwrap();
        let payload = hello.get("payload").unwrap();
        let credential = CredentialMaterial::from_token(server_credential.token);
        assert_eq!(payload["credentialId"], credential.credential_id);
        assert_eq!(payload["credentialKind"], server_credential.kind);
        let mut challenge = AuthChallenge {
            credential_id: credential.credential_id.clone(),
            credential_kind: server_credential.kind.to_owned(),
            client_nonce: payload["clientNonce"].as_str().unwrap().to_owned(),
            server_nonce: random_nonce().unwrap(),
            runner_instance_id: state.runner_instance_id.clone(),
            environment_lease_id: state.environment_lease_id.clone(),
            run_id: state.run_id.clone(),
            normalized_session_id: state.normalized_session_id.clone(),
            turn_id: state.turn_id.clone(),
            item_id: state.item_id.clone(),
            runner_version: config.runner_version.clone(),
            runner_digest: config.runner_digest.clone(),
            selected_version: PROTOCOL_VERSION,
            credential_expires_at: "test-expiry".to_owned(),
            credential_expires_at_unix_ms: server_credential.expires_at_unix_ms,
            credential_lease_id: server_credential.lease_id.map(str::to_owned),
            revocation_epoch: server_credential.revocation_epoch,
            server_proof: String::new(),
        };
        let signing = challenge_signing_bytes(&challenge);
        challenge.server_proof = hex_encode(&hmac_domain(
            &credential.auth_key,
            "paperclip-runner-server-proof-v1",
            &[&signing],
        ));
        send_plain(
            socket,
            &json!({
                "protocol": PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "auth_challenge",
                "payload": {
                    "credentialId": &challenge.credential_id,
                    "credentialKind": &challenge.credential_kind,
                    "clientNonce": &challenge.client_nonce,
                    "serverNonce": &challenge.server_nonce,
                    "runnerInstanceId": &challenge.runner_instance_id,
                    "environmentLeaseId": &challenge.environment_lease_id,
                    "runId": &challenge.run_id,
                    "normalizedSessionId": &challenge.normalized_session_id,
                    "turnId": &challenge.turn_id,
                    "itemId": &challenge.item_id,
                    "runnerVersion": &challenge.runner_version,
                    "runnerDigest": &challenge.runner_digest,
                    "selectedVersion": challenge.selected_version,
                    "credentialExpiresAt": &challenge.credential_expires_at,
                    "credentialExpiresAtUnixMs": challenge.credential_expires_at_unix_ms,
                    "credentialLeaseId": &challenge.credential_lease_id,
                    "revocationEpoch": challenge.revocation_epoch,
                    "serverProof": &challenge.server_proof,
                },
            }),
            config.max_frame_bytes,
        )
        .unwrap();
        let response = receive_plain(socket, config.max_frame_bytes).unwrap();
        let client_proof = response["payload"]["clientProof"]
            .as_str()
            .unwrap()
            .to_owned();
        verify_hmac_hex(
            &credential.auth_key,
            "paperclip-runner-client-proof-v1",
            &[&signing, challenge.server_proof.as_bytes()],
            &client_proof,
        )
        .unwrap();
        SecureChannel::server(
            &credential.auth_key,
            &signing,
            challenge.server_proof.as_bytes(),
            client_proof.as_bytes(),
        )
        .unwrap()
    }

    fn send_secure(
        socket: &mut WebSocket<TcpStream>,
        secure: &mut SecureChannel,
        config: &DurableRunnerConfig,
        value: &Value,
    ) {
        let encrypted = secure
            .encrypt(&serde_json::to_vec(value).unwrap(), true)
            .unwrap();
        send_plain(socket, &encrypted, config.max_frame_bytes).unwrap();
    }

    fn receive_secure(
        socket: &mut WebSocket<TcpStream>,
        secure: &mut SecureChannel,
        config: &DurableRunnerConfig,
    ) -> Value {
        let frame = receive_plain(socket, config.max_frame_bytes).unwrap();
        secure.decrypt(&frame, true).unwrap()
    }

    fn welcome(
        state: &DurableState,
        connection_id: &str,
        lease_token: Option<&str>,
        expires_at_unix_ms: u64,
        acked_source_seq: u64,
        pending_commands: Vec<Value>,
    ) -> Value {
        json!({
            "protocol": PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": "welcome",
            "runnerInstanceId": state.runner_instance_id,
            "environmentLeaseId": state.environment_lease_id,
            "runId": state.run_id,
            "normalizedSessionId": state.normalized_session_id,
            "turnId": state.turn_id,
            "itemId": state.item_id,
            "connectionId": connection_id,
            "connectionLeaseId": "lease_1",
            "payload": {
                "selectedVersion": PROTOCOL_VERSION,
                "connectionLeaseId": "lease_1",
                "connectionLeaseToken": lease_token,
                "connectionLeaseExpiresAtUnixMs": expires_at_unix_ms,
                "connectionLeaseRevocationEpoch": 1,
                "ackedSourceSeq": acked_source_seq,
                "pendingCommands": pending_commands,
            },
        })
    }

    fn control(state: &DurableState, connection_id: &str, kind: &str, payload: Value) -> Value {
        json!({
            "protocol": PROTOCOL,
            "version": PROTOCOL_VERSION,
            "kind": kind,
            "runnerInstanceId": state.runner_instance_id,
            "environmentLeaseId": state.environment_lease_id,
            "runId": state.run_id,
            "normalizedSessionId": state.normalized_session_id,
            "turnId": state.turn_id,
            "itemId": state.item_id,
            "connectionId": connection_id,
            "connectionLeaseId": "lease_1",
            "payload": payload,
        })
    }

    #[test]
    fn url_resolution_rejects_non_loopback_and_ambiguous_inputs() {
        let public = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 80);
        assert!(
            resolve_ws_target_with("ws://example.test:80/path", |_, _| Ok(vec![public])).is_err()
        );
        let secure = resolve_ws_target_with("wss://example.test/path", |host, port| {
            assert_eq!(host, "example.test");
            assert_eq!(port, 443);
            Ok(vec![public])
        })
        .unwrap();
        assert!(secure.secure);
        assert_eq!(secure.request_url(), "wss://example.test/path");
        for input in [
            "ws://user@127.0.0.1:80/path",
            "ws://127.0.0.1:80/path?ticket=secret",
            "https://127.0.0.1/path",
        ] {
            assert!(
                resolve_ws_target_with(input, |_, _| Ok(vec![])).is_err(),
                "{input}"
            );
        }
    }

    #[test]
    fn pinned_connect_falls_back_in_deterministic_order_with_bounded_attempts() {
        let first = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3001);
        let second = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3002);
        let mut attempts = Vec::new();
        let connected = connect_pinned_addresses_with(
            &[second, first],
            Instant::now() + Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_millis(250),
            |address, timeout| {
                attempts.push((*address, timeout));
                if *address == first {
                    Err(io::Error::new(
                        io::ErrorKind::ConnectionRefused,
                        "first address refused",
                    ))
                } else {
                    Ok("connected")
                }
            },
        )
        .unwrap();
        assert_eq!(connected, "connected");
        assert_eq!(
            attempts.iter().map(|attempt| attempt.0).collect::<Vec<_>>(),
            vec![first, second]
        );
        assert!(attempts
            .iter()
            .all(|attempt| attempt.1 <= Duration::from_millis(250)));

        let failure = connect_pinned_addresses_with(
            &[second, first],
            Instant::now() + Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_millis(250),
            |_, _| -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::TimedOut, "simulated timeout"))
            },
        )
        .unwrap_err();
        assert!(failure.to_string().contains(&second.to_string()));
        assert!(failure.to_string().contains("2/2 pinned address attempts"));

        let lifecycle_budget = Duration::from_millis(40);
        let mut observed_timeout = None;
        connect_pinned_addresses_with(
            &[first],
            Instant::now() + lifecycle_budget,
            Duration::from_secs(2),
            Duration::from_millis(250),
            |_, timeout| -> io::Result<()> {
                observed_timeout = Some(timeout);
                Err(io::Error::new(io::ErrorKind::TimedOut, "simulated timeout"))
            },
        )
        .unwrap_err();
        assert!(observed_timeout.is_some_and(|timeout| timeout <= lifecycle_budget));
    }

    #[test]
    fn authentication_io_rejects_work_past_the_lifecycle_deadline() {
        struct DelayedSocket {
            delay: Duration,
            message: Option<Message>,
        }

        impl WebSocketMessages for DelayedSocket {
            fn send_message(&mut self, _message: Message) -> Result<(), tungstenite::Error> {
                Ok(())
            }

            fn read_message(&mut self) -> Result<Message, tungstenite::Error> {
                thread::sleep(self.delay);
                Ok(self.message.take().unwrap())
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        let lifecycle_budget = Duration::from_secs(1);
        configure_auth_timeouts(&stream, Instant::now() + lifecycle_budget).unwrap();
        assert!(stream
            .read_timeout()
            .unwrap()
            .is_some_and(|timeout| !timeout.is_zero() && timeout <= lifecycle_budget));
        assert!(stream
            .write_timeout()
            .unwrap()
            .is_some_and(|timeout| !timeout.is_zero() && timeout <= lifecycle_budget));
        drop(client);

        let mut delayed = DelayedSocket {
            delay: Duration::from_millis(5),
            message: Some(Message::Text("{}".into())),
        };
        let error = receive_plain_until(
            &mut delayed,
            1024,
            Instant::now() + Duration::from_millis(1),
        )
        .unwrap_err();
        assert!(error.to_string().contains("deadline elapsed"));
    }

    #[test]
    fn listener_path_is_exact_and_unambiguous() {
        validate_listener_path("/api/runner/v1/connect/run_1").unwrap();
        for path in [
            "/api/runner/v1/connect/",
            "/api/runner/v1/connect/run_1/extra",
            "/api/runner/v1/connect/run_1?ticket=secret",
            "/api/runner/v1/connect/run%5f1",
        ] {
            assert!(validate_listener_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn dial_bootstrap_failure_before_auth_response_is_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = config(port);
        let state = test_state(&config);
        let server_config = config.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            receive_plain(&mut socket, server_config.max_frame_bytes).unwrap();
            send_plain(
                &mut socket,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": {},
                }),
                server_config.max_frame_bytes,
            )
            .unwrap();
        });

        let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id).unwrap();
        let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
        let failure = match AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            Instant::now() + config.max_runtime,
        ) {
            Err(error) => error,
            Ok(_) => panic!("invalid challenge unexpectedly authenticated"),
        };
        assert!(!failure.bootstrap_maybe_consumed);
        server.join().unwrap();
    }

    #[test]
    fn dial_bootstrap_failure_after_auth_response_is_fail_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = config(port);
        let state = test_state(&config);
        let server_config = config.clone();
        let server_state = state.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            server_authenticate(
                &mut socket,
                &server_config,
                &server_state,
                ServerCredential {
                    token: "bootstrap-secret",
                    kind: "bootstrap",
                    lease_id: None,
                    expires_at_unix_ms: current_unix_ms().unwrap() + 60_000,
                    revocation_epoch: 0,
                },
            );
            // Disconnect after receiving the authenticated response but before
            // welcome, when the authority may already have consumed the ticket.
        });

        let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id).unwrap();
        let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
        let failure = match AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            Instant::now() + config.max_runtime,
        ) {
            Err(error) => error,
            Ok(_) => panic!("connection without welcome unexpectedly authenticated"),
        };
        assert!(failure.bootstrap_maybe_consumed);
        server.join().unwrap();
    }

    #[test]
    fn listener_rejects_invalid_peer_before_accepting_valid_bootstrap_peer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let path = "/api/runner/v1/connect/run_1".to_owned();
        let endpoint = RunnerTransportEndpoint::Listen {
            listener,
            path: path.clone(),
        };
        let config = config(address.port());
        let state = test_state(&config);
        let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();

        let (invalid_ready, invalid_connected) = mpsc::channel();
        let invalid_path = path.clone();
        let invalid_config = config.clone();
        let invalid_peer = thread::spawn(move || {
            let stream = TcpStream::connect(address).unwrap();
            invalid_ready.send(()).unwrap();
            let (mut socket, _) = client(format!("ws://{address}{invalid_path}"), stream).unwrap();
            receive_plain(&mut socket, invalid_config.max_frame_bytes).unwrap();
            send_plain(
                &mut socket,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": {},
                }),
                invalid_config.max_frame_bytes,
            )
            .unwrap();
        });
        invalid_connected.recv().unwrap();
        let invalid_failure = match AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            Instant::now() + config.max_runtime,
        ) {
            Err(error) => error,
            Ok(_) => panic!("invalid listener peer unexpectedly authenticated"),
        };
        assert!(!invalid_failure.bootstrap_maybe_consumed);
        invalid_peer.join().unwrap();

        let (valid_ready, valid_connected) = mpsc::channel();
        let valid_config = config.clone();
        let valid_state = state.clone();
        let valid_peer = thread::spawn(move || {
            let stream = TcpStream::connect(address).unwrap();
            valid_ready.send(()).unwrap();
            let (mut socket, _) = client(format!("ws://{address}{path}"), stream).unwrap();
            let expires = current_unix_ms().unwrap() + 60_000;
            let mut secure = server_authenticate(
                &mut socket,
                &valid_config,
                &valid_state,
                ServerCredential {
                    token: "bootstrap-secret",
                    kind: "bootstrap",
                    lease_id: None,
                    expires_at_unix_ms: expires,
                    revocation_epoch: 0,
                },
            );
            send_secure(
                &mut socket,
                &mut secure,
                &valid_config,
                &welcome(
                    &valid_state,
                    "connection_1",
                    Some("lease-secret"),
                    expires,
                    0,
                    vec![],
                ),
            );
        });
        valid_connected.recv().unwrap();
        let (_, accepted) = AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            Instant::now() + config.max_runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(accepted.connection.connection_id, "connection_1");
        assert_eq!(accepted.lease.unwrap().expose().unwrap(), "lease-secret");
        valid_peer.join().unwrap();
    }

    #[test]
    fn secure_frames_reject_replay_and_tampering() {
        let key = [7_u8; 32];
        let mut client = SecureChannel::client(&key, b"challenge", b"server", b"client").unwrap();
        let mut server = SecureChannel::server(&key, b"challenge", b"server", b"client").unwrap();
        let frame = client.encrypt(br#"{"ok":true}"#, false).unwrap();
        assert_eq!(server.decrypt(&frame, true).unwrap(), json!({"ok": true}));
        assert!(server.decrypt(&frame, true).is_err());

        let mut client = SecureChannel::client(&key, b"challenge", b"server", b"client").unwrap();
        let mut server = SecureChannel::server(&key, b"challenge", b"server", b"client").unwrap();
        let mut frame = client.encrypt(br#"{"ok":true}"#, false).unwrap();
        frame["ciphertext"] = Value::String("00".repeat(32));
        assert!(server.decrypt(&frame, true).is_err());
        assert!(hex_decode("éé").is_err());
        assert!(server.decrypt(&json!({"kind": "command"}), true).is_err());
    }

    #[test]
    fn control_identity_mismatch_fails_closed() {
        let config = config(3000);
        let state = test_state(&config);
        let mut envelope = control(&state, "connection_1", "ack", json!({"ackedSourceSeq": 0}));
        let connection = ConnectionMetadata {
            connection_id: "connection_1".to_owned(),
            lease_id: "lease_1".to_owned(),
            expires_at_unix_ms: current_unix_ms().unwrap() + 60_000,
            revocation_epoch: 1,
        };
        validate_control_identity(&envelope, &state, Some(&connection)).unwrap();
        envelope["runId"] = Value::String("run_from_another_binding".to_owned());
        assert!(validate_control_identity(&envelope, &state, Some(&connection)).is_err());
    }

    #[test]
    fn authenticates_bootstrap_and_receives_bound_lease() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = config(port);
        let state = test_state(&config);
        let server_config = config.clone();
        let server_state = state.clone();
        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut socket = accept(stream).unwrap();
            let hello = receive_plain(&mut socket, server_config.max_frame_bytes).unwrap();
            let payload = hello.get("payload").unwrap();
            let credential = CredentialMaterial::from_token("bootstrap-secret");
            assert_eq!(payload["credentialId"], credential.credential_id);
            let expires = current_unix_ms().unwrap() + 60_000;
            let mut challenge = AuthChallenge {
                credential_id: credential.credential_id.clone(),
                credential_kind: "bootstrap".to_owned(),
                client_nonce: payload["clientNonce"].as_str().unwrap().to_owned(),
                server_nonce: "server-nonce".to_owned(),
                runner_instance_id: server_state.runner_instance_id.clone(),
                environment_lease_id: server_state.environment_lease_id.clone(),
                run_id: server_state.run_id.clone(),
                normalized_session_id: server_state.normalized_session_id.clone(),
                turn_id: server_state.turn_id.clone(),
                item_id: server_state.item_id.clone(),
                runner_version: server_config.runner_version.clone(),
                runner_digest: server_config.runner_digest.clone(),
                selected_version: PROTOCOL_VERSION,
                credential_expires_at: "test-expiry".to_owned(),
                credential_expires_at_unix_ms: expires,
                credential_lease_id: None,
                revocation_epoch: 0,
                server_proof: String::new(),
            };
            let signing = challenge_signing_bytes(&challenge);
            challenge.server_proof = hex_encode(&hmac_domain(
                &credential.auth_key,
                "paperclip-runner-server-proof-v1",
                &[&signing],
            ));
            send_plain(
                &mut socket,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": {
                        "credentialId": challenge.credential_id,
                        "credentialKind": challenge.credential_kind,
                        "clientNonce": challenge.client_nonce,
                        "serverNonce": challenge.server_nonce,
                        "runnerInstanceId": challenge.runner_instance_id,
                        "environmentLeaseId": challenge.environment_lease_id,
                        "runId": challenge.run_id,
                        "normalizedSessionId": challenge.normalized_session_id,
                        "turnId": challenge.turn_id,
                        "itemId": challenge.item_id,
                        "runnerVersion": challenge.runner_version,
                        "runnerDigest": challenge.runner_digest,
                        "selectedVersion": challenge.selected_version,
                        "credentialExpiresAt": challenge.credential_expires_at,
                        "credentialExpiresAtUnixMs": challenge.credential_expires_at_unix_ms,
                        "credentialLeaseId": challenge.credential_lease_id,
                        "revocationEpoch": challenge.revocation_epoch,
                        "serverProof": challenge.server_proof,
                    },
                }),
                server_config.max_frame_bytes,
            )
            .unwrap();
            let response = receive_plain(&mut socket, server_config.max_frame_bytes).unwrap();
            let client_proof = response["payload"]["clientProof"].as_str().unwrap();
            verify_hmac_hex(
                &credential.auth_key,
                "paperclip-runner-client-proof-v1",
                &[&signing, challenge.server_proof.as_bytes()],
                client_proof,
            )
            .unwrap();
            let mut secure = SecureChannel::server(
                &credential.auth_key,
                &signing,
                challenge.server_proof.as_bytes(),
                client_proof.as_bytes(),
            )
            .unwrap();
            let welcome = json!({
                "protocol": PROTOCOL,
                "version": PROTOCOL_VERSION,
                "kind": "welcome",
                "runnerInstanceId": server_state.runner_instance_id,
                "environmentLeaseId": server_state.environment_lease_id,
                "runId": server_state.run_id,
                "normalizedSessionId": server_state.normalized_session_id,
                "turnId": server_state.turn_id,
                "itemId": server_state.item_id,
                "connectionId": "connection_1",
                "connectionLeaseId": "lease_1",
                "payload": {
                    "selectedVersion": PROTOCOL_VERSION,
                    "connectionLeaseId": "lease_1",
                    "connectionLeaseToken": "lease-secret",
                    "connectionLeaseExpiresAtUnixMs": expires,
                    "connectionLeaseRevocationEpoch": 1,
                    "ackedSourceSeq": 0,
                    "pendingCommands": [],
                },
            });
            let encrypted = secure
                .encrypt(&serde_json::to_vec(&welcome).unwrap(), true)
                .unwrap();
            send_plain(&mut socket, &encrypted, server_config.max_frame_bytes).unwrap();
        });

        let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id).unwrap();
        let ticket = BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap();
        let (transport, welcome) = AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            Some(&ticket),
            None,
            Instant::now() + config.max_runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            transport.socket.read_timeout().unwrap(),
            Some(RUNTIME_READ_TIMEOUT)
        );
        assert_eq!(welcome.connection.lease_id, "lease_1");
        assert_eq!(welcome.lease.unwrap().expose().unwrap(), "lease-secret");
        handle.join().unwrap();
    }

    #[test]
    fn reconnect_replays_unacked_events_and_not_command_effects() {
        struct EventExecutor {
            session_open_calls: Arc<AtomicUsize>,
            shutdown_calls: Arc<AtomicUsize>,
        }

        impl super::super::CommandExecutor for EventExecutor {
            fn execute(
                &mut self,
                command: &Command,
            ) -> Result<super::super::CommandExecution, DurableRunnerError> {
                if command.command_type == "session.open" {
                    let calls = self.session_open_calls.fetch_add(1, Ordering::SeqCst) + 1;
                    return Ok(super::super::CommandExecution {
                        result: json!({"status": "completed", "calls": calls}),
                        events: vec![(
                            "provider.notice.recorded".to_owned(),
                            super::super::EventPriority::P1,
                            json!({"message": "durable event"}),
                        )],
                    });
                }
                Ok(super::super::CommandExecution::result(
                    json!({"status": "completed"}),
                ))
            }

            fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
                self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut config = config(port);
        config.max_runtime = Duration::from_secs(5);
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-reconnect-fault-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        config.state_dir = directory.clone();
        let state = test_state(&config);
        let expires = current_unix_ms().unwrap() + 60_000;
        let open_command = json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": "command_open",
            "controllerSeq": 1,
            "type": "session.open",
            "issuedAt": "2026-08-24T00:00:00.000Z",
            "payload": {},
        });
        let shutdown_command = json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": "command_shutdown",
            "controllerSeq": 2,
            "type": "runner.shutdown",
            "issuedAt": "2026-08-24T00:00:01.000Z",
            "payload": {},
        });
        let server_config = config.clone();
        let server_state = state.clone();
        let server_open = open_command.clone();
        let server = thread::spawn(move || {
            let (first_stream, _) = listener.accept().unwrap();
            let mut first = accept(first_stream).unwrap();
            let mut first_secure = server_authenticate(
                &mut first,
                &server_config,
                &server_state,
                ServerCredential {
                    token: "bootstrap-secret",
                    kind: "bootstrap",
                    lease_id: None,
                    expires_at_unix_ms: expires,
                    revocation_epoch: 0,
                },
            );
            send_secure(
                &mut first,
                &mut first_secure,
                &server_config,
                &welcome(
                    &server_state,
                    "connection_1",
                    Some("lease-secret"),
                    expires,
                    0,
                    vec![server_open.clone()],
                ),
            );
            let first_result = receive_secure(&mut first, &mut first_secure, &server_config);
            let first_event = receive_secure(&mut first, &mut first_secure, &server_config);
            assert_eq!(first_result["kind"], "command_result");
            assert_eq!(first_event["kind"], "event");
            drop(first);

            let (second_stream, _) = listener.accept().unwrap();
            let mut second = accept(second_stream).unwrap();
            let mut second_secure = server_authenticate(
                &mut second,
                &server_config,
                &server_state,
                ServerCredential {
                    token: "lease-secret",
                    kind: "lease",
                    lease_id: Some("lease_1"),
                    expires_at_unix_ms: expires,
                    revocation_epoch: 1,
                },
            );
            send_secure(
                &mut second,
                &mut second_secure,
                &server_config,
                &welcome(
                    &server_state,
                    "connection_2",
                    None,
                    expires,
                    0,
                    vec![server_open],
                ),
            );
            let replayed_result = receive_secure(&mut second, &mut second_secure, &server_config);
            let replayed_event = receive_secure(&mut second, &mut second_secure, &server_config);
            assert_eq!(replayed_result, first_result);
            assert_eq!(replayed_event, first_event);
            send_secure(
                &mut second,
                &mut second_secure,
                &server_config,
                &control(
                    &server_state,
                    "connection_2",
                    "ack",
                    json!({"ackedSourceSeq": 1}),
                ),
            );
            send_secure(
                &mut second,
                &mut second_secure,
                &server_config,
                &control(&server_state, "connection_2", "command", shutdown_command),
            );
            let shutdown_result = receive_secure(&mut second, &mut second_secure, &server_config);
            assert_eq!(shutdown_result["kind"], "command_result");
            send_secure(
                &mut second,
                &mut second_secure,
                &server_config,
                &control(
                    &server_state,
                    "connection_2",
                    "command_result_ack",
                    json!({
                        "commandId": "command_shutdown",
                        "commandType": "runner.shutdown",
                        "controllerSeq": 2,
                        "status": "completed",
                    }),
                ),
            );
        });

        let session_open_calls = Arc::new(AtomicUsize::new(0));
        let shutdown_calls = Arc::new(AtomicUsize::new(0));
        super::super::run_durable_runner(
            config,
            BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
            EventExecutor {
                session_open_calls: session_open_calls.clone(),
                shutdown_calls: shutdown_calls.clone(),
            },
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(session_open_calls.load(Ordering::SeqCst), 1);
        assert_eq!(shutdown_calls.load(Ordering::SeqCst), 1);
        let store = super::super::DurableStateStore::new(&directory).unwrap();
        let state_bytes = std::fs::read(store.path()).unwrap();
        let final_state: DurableState = serde_json::from_slice(&state_bytes).unwrap();
        assert_eq!(final_state.acked_source_seq, 1);
        assert!(final_state.outbox.is_empty());
        assert!(final_state.pending_terminal_delivery.is_none());
        assert_eq!(final_state.reconnect_count, 1);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
