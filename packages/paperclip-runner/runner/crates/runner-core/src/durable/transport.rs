struct ParsedWsUrl {
    host: String,
    authority: String,
    port: u16,
    path: String,
}
fn parse_ws_url(input: &str) -> Result<ParsedWsUrl, DurableRunnerError> {
    let remainder = input
        .strip_prefix("ws://")
        .ok_or_else(|| DurableRunnerError::invalid("runner core accepts exactly the ws:// scheme"))?;
    if remainder.is_empty()
        || remainder
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        || remainder.contains(['?', '#', '\\'])
    {
        return Err(DurableRunnerError::invalid(
            "WebSocket URL contains malformed, query, fragment, or path ambiguity",
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
        let port = authority[closing + 1..]
            .strip_prefix(':')
            .ok_or_else(|| DurableRunnerError::invalid("bracketed IPv6 authority requires a port"))?;
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| DurableRunnerError::invalid("bracketed WebSocket host must be IPv6"))?;
        (host, port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| DurableRunnerError::invalid("WebSocket URL must include an explicit port"))?;
        if host.is_empty() || host.contains(':') {
            return Err(DurableRunnerError::invalid(
                "WebSocket host is empty or an unbracketed IPv6 literal",
            ));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .map_err(|error| DurableRunnerError::invalid(format!("invalid WebSocket port: {error}")))?;
    if port == 0 {
        return Err(DurableRunnerError::invalid("WebSocket port must be non-zero"));
    }
    Ok(ParsedWsUrl {
        host: host.to_owned(),
        authority: authority.to_owned(),
        port,
        path,
    })
}

struct ResolvedWsTarget {
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
}

impl ResolvedWsTarget {
    fn resolve(input: &str) -> Result<Self, DurableRunnerError> {
        resolve_ws_target_with(input, |host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    }
}

fn resolve_ws_target_with<F>(input: &str, resolver: F) -> Result<ResolvedWsTarget, DurableRunnerError>
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
    if addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err(DurableRunnerError::invalid(
            "every WebSocket destination must be loopback (127.0.0.0/8 or ::1)",
        ));
    }
    Ok(ResolvedWsTarget {
        authority: parsed.authority,
        path: parsed.path,
        addresses,
    })
}

struct WsClient {
    stream: TcpStream,
    mask_counter: u32,
    max_frame_bytes: usize,
    secure_channel: Option<SecureChannel>,
}

struct SecureChannel {
    send_cipher: Aes256Gcm,
    receive_cipher: Aes256Gcm,
    send_counter: u64,
    receive_counter: u64,
    session_id: String,
}

impl SecureChannel {
    fn new(
        auth_key: &[u8],
        challenge: &[u8],
        server_proof: &[u8],
        client_proof: &[u8],
    ) -> Result<Self, DurableRunnerError> {
        let session_binding = digest_domain(
            "paperclip-runner-session-binding-v1",
            &[challenge, server_proof, client_proof],
        );
        let send_key = hmac_domain(
            auth_key,
            "paperclip-runner-client-to-core-key-v1",
            &[&session_binding],
        );
        let receive_key = hmac_domain(
            auth_key,
            "paperclip-runner-core-to-client-key-v1",
            &[&session_binding],
        );
        Ok(Self {
            send_cipher: Aes256Gcm::new_from_slice(&send_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize transport encryption"))?,
            receive_cipher: Aes256Gcm::new_from_slice(&receive_key)
                .map_err(|_| DurableRunnerError::invalid("failed to initialize transport decryption"))?,
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

    fn encrypt(&mut self, plaintext: &[u8]) -> Result<Value, DurableRunnerError> {
        let counter = self.send_counter;
        let nonce = Self::nonce(b"P3C1", counter);
        let aad = self.aad("client_to_core", counter);
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
            .ok_or_else(|| DurableRunnerError::invalid("secure transport send counter exhausted"))?;
        Ok(json!({
            "schema": SECURE_FRAME_SCHEMA,
            "counter": counter,
            "ciphertext": hex_encode(&ciphertext),
        }))
    }

    fn decrypt(&mut self, frame: &Value) -> Result<Value, DurableRunnerError> {
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
        let nonce = Self::nonce(b"P3S1", counter);
        let aad = self.aad("core_to_client", counter);
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
            .ok_or_else(|| DurableRunnerError::invalid("secure transport receive counter exhausted"))?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            DurableRunnerError::invalid(format!("secure frame JSON is malformed: {error}"))
        })
    }
}

fn encode_masked_frame(
    opcode: u8,
    payload: &[u8],
    mask: [u8; 4],
    max_frame_bytes: usize,
) -> Result<Vec<u8>, DurableRunnerError> {
    if payload.len() > max_frame_bytes {
        return Err(DurableRunnerError::invalid(
            "outbound WebSocket frame exceeds the limit",
        ));
    }
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        length if length <= 125 => frame.push(0x80 | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    Ok(frame)
}

fn checked_inbound_frame_length(length: u64, max_frame_bytes: usize) -> Result<usize, DurableRunnerError> {
    let length = usize::try_from(length)
        .map_err(|_| DurableRunnerError::invalid("WebSocket frame length overflow"))?;
    if length > max_frame_bytes {
        return Err(DurableRunnerError::invalid(
            "inbound WebSocket frame exceeds the limit",
        ));
    }
    Ok(length)
}

impl WsClient {
    fn connect(target: &ResolvedWsTarget, max_frame_bytes: usize) -> Result<Self, DurableRunnerError> {
        let mut stream = TcpStream::connect(target.addresses.as_slice())
            .map_err(|error| DurableRunnerError::invalid(format!("WebSocket connect failed: {error}")))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n",
            target.path,
            target.authority,
            STATIC_WEBSOCKET_KEY
        )
        .into_bytes();
        let write_result = stream.write_all(&request).and_then(|_| stream.flush());
        // Keep the request buffer short-lived even though it contains only public data.
        // Authentication capabilities never cross the socket.
        request.fill(0);
        request.clear();
        write_result.map_err(|error| {
            DurableRunnerError::invalid(format!("WebSocket upgrade write failed: {error}"))
        })?;

        let mut response = Vec::new();
        let mut byte = [0_u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            if response.len() >= MAX_HTTP_HEADER_BYTES {
                return Err(DurableRunnerError::invalid(
                    "WebSocket response headers are too large",
                ));
            }
            stream.read_exact(&mut byte).map_err(|error| {
                DurableRunnerError::invalid(format!("WebSocket upgrade response failed: {error}"))
            })?;
            response.push(byte[0]);
        }
        let response = String::from_utf8(response)
            .map_err(|error| DurableRunnerError::invalid(format!("invalid HTTP response: {error}")))?;
        if !response.starts_with("HTTP/1.1 101 ") {
            let status = response
                .lines()
                .next()
                .unwrap_or("HTTP response unavailable");
            return Err(DurableRunnerError::invalid(format!(
                "WebSocket authentication or upgrade rejected: {status}"
            )));
        }
        let accept_valid = response.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("sec-websocket-accept")
                    && value.trim() == STATIC_WEBSOCKET_ACCEPT
            })
        });
        if !accept_valid {
            return Err(DurableRunnerError::invalid(
                "WebSocket server returned an invalid acceptance proof",
            ));
        }
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        Ok(Self {
            stream,
            mask_counter: 1,
            max_frame_bytes,
            secure_channel: None,
        })
    }

    fn send_json(&mut self, value: &Value) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            DurableRunnerError::invalid(format!("frame serialization failed: {error}"))
        })?;
        let frame = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("secure transport is not authenticated"))?
            .encrypt(&bytes)?;
        self.send_plain_json(&frame)
    }

    fn send_plain_json(&mut self, value: &Value) -> Result<(), DurableRunnerError> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            DurableRunnerError::invalid(format!("frame serialization failed: {error}"))
        })?;
        self.send_frame(0x1, &bytes)
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), DurableRunnerError> {
        let mask = self.mask_counter.to_be_bytes();
        self.mask_counter = self.mask_counter.wrapping_add(1);
        let frame = encode_masked_frame(opcode, payload, mask, self.max_frame_bytes)?;
        self.stream
            .write_all(&frame)
            .and_then(|_| self.stream.flush())
            .map_err(|error| DurableRunnerError::invalid(format!("WebSocket frame write failed: {error}")))
    }

    fn receive_json(&mut self) -> Result<Option<Value>, DurableRunnerError> {
        let Some(frame) = self.receive_plain_json()? else {
            return Ok(None);
        };
        let value = self
            .secure_channel
            .as_mut()
            .ok_or_else(|| DurableRunnerError::invalid("secure transport is not authenticated"))?
            .decrypt(&frame)?;
        Ok(Some(value))
    }

    fn receive_plain_json(&mut self) -> Result<Option<Value>, DurableRunnerError> {
        loop {
            let mut header = [0_u8; 2];
            match self.stream.read_exact(&mut header) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(error) => {
                    return Err(DurableRunnerError::invalid(format!(
                        "WebSocket connection closed: {error}"
                    )))
                }
            }
            let opcode = header[0] & 0x0f;
            let masked = header[1] & 0x80 != 0;
            let mut length = u64::from(header[1] & 0x7f);
            if length == 126 {
                let mut extended = [0_u8; 2];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0_u8; 8];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                length = u64::from_be_bytes(extended);
            }
            let length = checked_inbound_frame_length(length, self.max_frame_bytes)?;
            let mut mask = [0_u8; 4];
            if masked {
                self.stream
                    .read_exact(&mut mask)
                    .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            }
            let mut payload = vec![0_u8; length];
            self.stream
                .read_exact(&mut payload)
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            match opcode {
                0x1 => {
                    let value = serde_json::from_slice(&payload).map_err(|error| {
                        DurableRunnerError::invalid(format!("malformed WebSocket JSON: {error}"))
                    })?;
                    return Ok(Some(value));
                }
                0x8 => return Err(DurableRunnerError::invalid("WebSocket peer closed the connection")),
                0x9 => self.send_frame(0xA, &payload)?,
                0xA => {}
                _ => return Err(DurableRunnerError::invalid("unsupported WebSocket frame opcode")),
            }
        }
    }

    fn enable_secure_channel(&mut self, channel: SecureChannel) {
        self.secure_channel = Some(channel);
    }
}

fn authentication_hello_envelope(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential_id: &str,
    client_nonce: &str,
) -> Value {
    let unacked_range = state
        .outbox
        .first()
        .zip(state.outbox.last())
        .map(|(first, last)| json!([first.source_seq, last.source_seq]));
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_hello",
        "payload": {
            "credentialId": credential_id,
            "clientNonce": client_nonce,
            "protocolMin": 1,
            "protocolMax": 1,
            "runnerInstanceId": state.runner_instance_id,
            "runnerVersion": config.runner_version,
            "runnerDigest": config.runner_digest,
            "environmentLeaseId": state.environment_lease_id,
            "runId": state.run_id,
            "normalizedSessionId": state.normalized_session_id,
            "turnId": state.turn_id,
            "itemId": state.item_id,
            "sandboxProvider": "standalone_mock",
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": "redacted-standalone-runner",
            },
            "drivers": [{
                "kind": "fake",
                "version": "1.0.0",
                "capabilities": { "resume": true, "interrupt": true },
            }],
            "resume": {
                "lastControllerCommandSeq": state.last_controller_command_seq,
                "nextSourceEventSeq": state.next_source_seq,
                "ackedSourceSeq": state.acked_source_seq,
                "unackedEventRange": unacked_range,
            },
        },
    })
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, DurableRunnerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DurableRunnerError::invalid(format!("{field} is required")))
}

fn authenticate_transport(
    client: &mut WsClient,
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
    credential: &CredentialMaterial,
    credential_kind: &str,
    expected_lease_id: Option<&str>,
    expected_expires_at_unix_ms: Option<u64>,
    expected_revocation_epoch: Option<u64>,
) -> Result<(), DurableRunnerError> {
    let client_nonce = random_suffix()?;
    client.send_plain_json(&authentication_hello_envelope(
        state,
        config,
        &credential.credential_id,
        &client_nonce,
    ))?;
    let deadline = Instant::now()
        .checked_add(Duration::from_secs(2))
        .ok_or_else(|| DurableRunnerError::invalid("transport authentication deadline overflowed"))?;
    let challenge = loop {
        match client.receive_plain_json()? {
            Some(value) => break value,
            None if Instant::now() < deadline => continue,
            None => return Err(DurableRunnerError::invalid("transport authentication timed out")),
        }
    };
    if challenge.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || challenge.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || challenge.get("kind").and_then(Value::as_str) != Some("auth_challenge")
    {
        return Err(DurableRunnerError::invalid(
            "core did not return an authenticated transport challenge",
        ));
    }
    let payload = challenge
        .get("payload")
        .ok_or_else(|| DurableRunnerError::invalid("authentication challenge payload is required"))?;
    for (field, expected) in [
        ("credentialId", credential.credential_id.as_str()),
        ("credentialKind", credential_kind),
        ("clientNonce", client_nonce.as_str()),
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
        ("turnId", state.turn_id.as_str()),
        ("itemId", state.item_id.as_str()),
        ("runnerVersion", config.runner_version.as_str()),
        ("runnerDigest", config.runner_digest.as_str()),
    ] {
        if required_string(payload, field)? != expected {
            return Err(DurableRunnerError::invalid(format!(
                "authentication challenge {field} does not match the requested session"
            )));
        }
    }
    required_string(payload, "serverNonce")?;
    required_string(payload, "credentialExpiresAt")?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge selected an unsupported protocol",
        ));
    }
    let expires_at_unix_ms = payload
        .get("credentialExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            DurableRunnerError::invalid("authentication challenge credential expiry is required")
        })?;
    if expires_at_unix_ms <= current_unix_ms()? {
        return Err(DurableRunnerError::invalid(
            "transport credential expired before authentication completed",
        ));
    }
    if expected_expires_at_unix_ms.is_some_and(|expected| expected != expires_at_unix_ms) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge changed the connection lease expiry",
        ));
    }
    let revocation_epoch = payload
        .get("revocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("authentication revocation epoch is required"))?;
    if expected_revocation_epoch.is_some_and(|expected| expected != revocation_epoch) {
        return Err(DurableRunnerError::invalid(
            "authentication challenge changed the connection lease revocation epoch",
        ));
    }
    match (expected_lease_id, payload.get("credentialLeaseId")) {
        (Some(expected), Some(Value::String(actual))) if actual == expected => {}
        (None, Some(Value::Null)) => {}
        _ => {
            return Err(DurableRunnerError::invalid(
                "authentication challenge lease identity does not match the credential",
            ))
        }
    }

    let server_proof = required_string(payload, "serverProof")?.to_owned();
    let mut authenticated_payload = payload.clone();
    authenticated_payload
        .as_object_mut()
        .ok_or_else(|| DurableRunnerError::invalid("authentication challenge payload must be an object"))?
        .remove("serverProof");
    let canonical_challenge = canonical_json(&authenticated_payload);
    verify_hmac_hex(
        &credential.auth_key,
        "paperclip-runner-server-proof-v1",
        &[canonical_challenge.as_bytes()],
        &server_proof,
    )?;
    let client_proof = hex_encode(&hmac_domain(
        &credential.auth_key,
        "paperclip-runner-client-proof-v1",
        &[canonical_challenge.as_bytes(), server_proof.as_bytes()],
    ));
    client.send_plain_json(&json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "auth_response",
        "payload": {
            "credentialId": credential.credential_id,
            "clientNonce": client_nonce,
            "serverNonce": required_string(payload, "serverNonce")?,
            "clientProof": client_proof,
        },
    }))?;
    let secure_channel = SecureChannel::new(
        &credential.auth_key,
        canonical_challenge.as_bytes(),
        server_proof.as_bytes(),
        client_proof.as_bytes(),
    )?;
    client.enable_secure_channel(secure_channel);
    Ok(())
}

fn send_outbox(client: &mut WsClient, state: &DurableRunnerState) -> Result<(), DurableRunnerError> {
    for event in &state.outbox {
        client.send_json(&event.envelope)?;
    }
    Ok(())
}

struct ConnectionMetadata {
    connection_id: String,
    lease_id: String,
    lease_expires_at_unix_ms: u64,
    revocation_epoch: u64,
}

fn validate_control_identity(
    value: &Value,
    state: &DurableRunnerState,
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
        {
            return Err(DurableRunnerError::invalid(
                "control envelope connection lease identity does not match the authenticated session",
            ));
        }
        if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
            return Err(DurableRunnerError::invalid(
                "connection lease expired before the control envelope was applied",
            ));
        }
    }
    Ok(())
}

fn validate_welcome<'a>(
    value: &'a Value,
    state: &DurableRunnerState,
) -> Result<(&'a Value, ConnectionMetadata), DurableRunnerError> {
    validate_control_identity(value, state, None)?;
    if value.get("kind").and_then(Value::as_str) != Some("welcome") {
        return Err(DurableRunnerError::invalid("expected a PRP v1 welcome envelope"));
    }
    let connection_id = required_string(value, "connectionId")?.to_owned();
    let lease_id = required_string(value, "connectionLeaseId")?.to_owned();
    let payload = value
        .get("payload")
        .ok_or_else(|| DurableRunnerError::invalid("welcome payload is required"))?;
    if payload.get("selectedVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "core selected an unsupported protocol version",
        ));
    }
    if required_string(payload, "connectionLeaseId")? != lease_id {
        return Err(DurableRunnerError::invalid(
            "welcome lease identity is internally inconsistent",
        ));
    }
    required_string(payload, "connectionLeaseExpiresAt")?;
    let lease_expires_at_unix_ms = payload
        .get("connectionLeaseExpiresAtUnixMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome lease expiry is required"))?;
    if lease_expires_at_unix_ms <= current_unix_ms()? {
        return Err(DurableRunnerError::invalid(
            "welcome carried an already-expired connection lease",
        ));
    }
    let revocation_epoch = payload
        .get("connectionLeaseRevocationEpoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| DurableRunnerError::invalid("welcome revocation epoch is required"))?;
    let binding = payload
        .get("leaseBinding")
        .ok_or_else(|| DurableRunnerError::invalid("welcome lease binding is required"))?;
    for (field, expected) in [
        ("runnerInstanceId", state.runner_instance_id.as_str()),
        ("environmentLeaseId", state.environment_lease_id.as_str()),
        ("runId", state.run_id.as_str()),
        ("normalizedSessionId", state.normalized_session_id.as_str()),
    ] {
        if required_string(binding, field)? != expected {
            return Err(DurableRunnerError::invalid(format!(
                "welcome lease binding {field} does not match the authenticated session"
            )));
        }
    }
    if binding.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err(DurableRunnerError::invalid(
            "welcome lease binding protocol is invalid",
        ));
    }
    Ok((
        payload,
        ConnectionMetadata {
            connection_id,
            lease_id,
            lease_expires_at_unix_ms,
            revocation_epoch,
        },
    ))
}
