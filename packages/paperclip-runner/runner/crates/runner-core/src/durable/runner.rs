pub fn run_durable_runner(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
) -> Result<(), DurableRunnerError> {
    if config.p0_reserve_bytes >= config.max_outbox_bytes {
        return Err(DurableRunnerError::invalid(
            "P0 reserve must be smaller than the outbox limit",
        ));
    }
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if recovered && state.lifecycle == "revoked" {
        // Revocation is durable and terminal. Dropping the fresh bootstrap capability before
        // destination resolution guarantees a restarted daemon cannot authenticate, reconnect,
        // advance cursors, or rewrite the preserved operator-recovery state.
        drop(bootstrap_ticket);
        return Ok(());
    }
    // Resolve once before authentication. Reconnects use only this validated,
    // concrete address set, so DNS cannot redirect a retry.
    let target = ResolvedWsTarget::resolve(&config.connect_url)?;
    if recovered {
        state.reconnect_count += 1;
        state.record_diagnostic("runner process restored the same durable identity");
        enqueue_event(
            &mut state,
            &config,
            "runner.reconciled",
            0,
            json!({
                "runnerInstanceId": config.runner_instance_id,
                "normalizedSessionId": config.normalized_session_id,
                "turnId": config.turn_id,
                "itemId": config.item_id,
                "outcome": "same_durable_session_resumed",
            }),
            None,
        )?;
        store.save(&state)?;
    }
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut connection_lease_token: Option<SensitiveString> = None;
    let mut connection_lease_id: Option<String> = None;
    let mut connection_lease_expires_at_unix_ms: Option<u64> = None;
    let mut connection_lease_revocation_epoch: Option<u64> = None;
    let started = Instant::now();

    loop {
        if started.elapsed() > config.max_runtime {
            state.recoverable_failure = Some("transport_reconnect_deadline_exceeded".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic("transport reconnect deadline exceeded");
            store.save(&state)?;
            return Err(DurableRunnerError::invalid(
                "transport reconnect deadline exceeded; durable state is preserved",
            ));
        }
        if connection_lease_expires_at_unix_ms
            .is_some_and(|expires_at| current_unix_ms().is_ok_and(|now| now >= expires_at))
        {
            state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic(
                "connection lease expired; a fresh bootstrap may resume this state",
            );
            store.save(&state)?;
            connection_lease_token.take();
            return Err(DurableRunnerError::invalid(
                "connection lease expired; durable state requires a fresh bootstrap",
            ));
        }
        let (credential_token, credential_kind) = connection_lease_token
            .as_ref()
            .map(|token| (token.expose(), "lease"))
            .or_else(|| {
                bootstrap_ticket
                    .as_ref()
                    .map(|ticket| (ticket.expose(), "bootstrap"))
            })
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "transport capability is unavailable; a fresh runner bootstrap is required",
                )
            })?;
        let credential = CredentialMaterial::from_token(credential_token);
        let mut client = match WsClient::connect(&target, config.max_frame_bytes) {
            Ok(client) => client,
            Err(error) => {
                let text = error.to_string();
                state.record_diagnostic(format!("transport reconnect scheduled: {text}"));
                store.save(&state)?;
                thread::sleep(config.reconnect_delay);
                continue;
            }
        };
        if let Err(error) = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            credential_kind,
            connection_lease_id.as_deref(),
            connection_lease_expires_at_unix_ms,
            connection_lease_revocation_epoch,
        ) {
            state.record_diagnostic(format!(
                "transport peer authentication failed closed: {error}"
            ));
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }
        let mut welcome = loop {
            match client.receive_json() {
                Ok(Some(value)) => break value,
                Ok(None) if started.elapsed() <= config.max_runtime => continue,
                Ok(None) => {
                    return Err(DurableRunnerError::invalid("welcome timed out"));
                }
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    store.save(&state)?;
                    thread::sleep(config.reconnect_delay);
                    continue;
                }
            }
        };
        let (_, connection) = validate_welcome(&welcome, &state)?;
        let next_lease_token = match welcome.pointer_mut("/payload/connectionLeaseToken") {
            Some(Value::String(value)) => {
                let token = std::mem::take(value);
                *value = "[REDACTED]".to_owned();
                Some(SensitiveString::new(token))
            }
            _ => None,
        };
        if credential_kind == "bootstrap" && next_lease_token.is_none() {
            return Err(DurableRunnerError::invalid(
                "authenticated bootstrap welcome did not issue a connection lease",
            ));
        }
        if let Some(token) = next_lease_token {
            connection_lease_token = Some(token);
        }
        connection_lease_id = Some(connection.lease_id.clone());
        connection_lease_expires_at_unix_ms = Some(connection.lease_expires_at_unix_ms);
        connection_lease_revocation_epoch = Some(connection.revocation_epoch);
        // A bootstrap ticket is one-use. Clear it only after the mutually authenticated,
        // encrypted welcome has exchanged it for a bound connection lease.
        bootstrap_ticket.take();
        let payload = welcome
            .get("payload")
            .ok_or_else(|| DurableRunnerError::invalid("welcome payload is required"))?;
        if let Some(acked_source_seq) = payload.get("ackedSourceSeq").and_then(Value::as_u64) {
            state.apply_ack(acked_source_seq)?;
        }
        state.lifecycle =
            if state.lifecycle == "connecting" || state.lifecycle == "recoverable_failure" {
                "ready".to_owned()
            } else {
                state.lifecycle.clone()
            };
        state.recoverable_failure = None;
        store.save(&state)?;

        let initial_delivery = (|| -> Result<(), DurableRunnerError> {
            if let Some(commands) = payload.get("pendingCommands").and_then(Value::as_array) {
                for command in commands {
                    match process_command(&mut state, &store, &config, command) {
                        Ok(processed) => {
                            client.send_json(&command_result_envelope(&state, &processed))?
                        }
                        Err(error) => {
                            state.record_diagnostic(error.to_string());
                            store.save(&state)?;
                        }
                    }
                }
            }
            send_outbox(&mut client, &state)
        })();
        if let Err(error) = initial_delivery {
            state.record_diagnostic(error.to_string());
            state.reconnect_count += 1;
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }

        let mut revoke_deadline: Option<Instant> = None;
        let disconnected = loop {
            if (state.stop_after_flush || state.lifecycle == "revoked") && state.outbox.is_empty() {
                state.lifecycle = if state.lifecycle == "revoked" {
                    "revoked".to_owned()
                } else {
                    "stopped".to_owned()
                };
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if revoke_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                state.record_diagnostic(
                    "revocation flush deadline elapsed; unacked durable events remain preserved",
                );
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if current_unix_ms()? >= connection.lease_expires_at_unix_ms {
                state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
                state.lifecycle = "recoverable_failure".to_owned();
                state.record_diagnostic(
                    "connection lease expired before more control data could be accepted",
                );
                store.save(&state)?;
                connection_lease_token.take();
                return Err(DurableRunnerError::invalid(
                    "connection lease expired; durable state requires a fresh bootstrap",
                ));
            }
            match client.receive_json() {
                Ok(None) => continue,
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    if state.lifecycle == "revoked" {
                        store.save(&state)?;
                        connection_lease_token.take();
                        bootstrap_ticket.take();
                        return Ok(());
                    }
                    state.reconnect_count += 1;
                    store.save(&state)?;
                    break true;
                }
                Ok(Some(message)) => {
                    if let Err(error) =
                        validate_control_identity(&message, &state, Some(&connection))
                    {
                        state.record_diagnostic(format!(
                            "control envelope identity mismatch failed closed: {error}"
                        ));
                        state.reconnect_count += 1;
                        store.save(&state)?;
                        break true;
                    }
                    match message.get("kind").and_then(Value::as_str) {
                        Some("ack") => {
                            let acked = message
                                .pointer("/payload/ackedSourceSeq")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| DurableRunnerError::invalid("ACK cursor is required"))?;
                            state.apply_ack(acked)?;
                            store.save(&state)?;
                        }
                        Some("command") => {
                            let command = message.get("payload").ok_or_else(|| {
                                DurableRunnerError::invalid("command payload is required")
                            })?;
                            match process_command(&mut state, &store, &config, command) {
                                Ok(processed) => {
                                    let delivery = client
                                        .send_json(&command_result_envelope(&state, &processed))
                                        .and_then(|()| send_outbox(&mut client, &state));
                                    if let Err(error) = delivery {
                                        state.record_diagnostic(error.to_string());
                                        if state.lifecycle == "revoked" {
                                            store.save(&state)?;
                                            connection_lease_token.take();
                                            bootstrap_ticket.take();
                                            return Ok(());
                                        }
                                        state.reconnect_count += 1;
                                        store.save(&state)?;
                                        break true;
                                    }
                                }
                                Err(error) => {
                                    state.record_diagnostic(error.to_string());
                                    store.save(&state)?;
                                }
                            }
                        }
                        Some("revoke") => {
                            let revocation_epoch = message
                                .pointer("/payload/revocationEpoch")
                                .and_then(Value::as_u64)
                                .ok_or_else(|| {
                                    DurableRunnerError::invalid("revoke revocation epoch is required")
                                })?;
                            if revocation_epoch <= connection.revocation_epoch {
                                return Err(DurableRunnerError::invalid(
                                    "revoke did not advance the authenticated revocation epoch",
                                ));
                            }
                            state.lifecycle = "revoked".to_owned();
                            state.stop_after_flush = true;
                            revoke_deadline.get_or_insert_with(|| {
                                Instant::now()
                                    .checked_add(REVOKE_FLUSH_TIMEOUT)
                                    .unwrap_or_else(Instant::now)
                            });
                            state.record_diagnostic(
                                "connection lease revoked; flushing durable events",
                            );
                            store.save(&state)?;
                            if let Err(error) = send_outbox(&mut client, &state) {
                                state.record_diagnostic(error.to_string());
                                store.save(&state)?;
                                connection_lease_token.take();
                                bootstrap_ticket.take();
                                return Ok(());
                            }
                        }
                        Some("ping") => {
                            let pong = client.send_json(&json!({
                                "protocol": PROTOCOL,
                                "version": PROTOCOL_VERSION,
                                "kind": "pong",
                                "runnerInstanceId": state.runner_instance_id,
                                "payload": {
                                    "lifecycle": state.lifecycle,
                                    "outboxBytes": state.outbox_bytes(),
                                    "ackedSourceSeq": state.acked_source_seq,
                                },
                            }));
                            if let Err(error) = pong {
                                state.record_diagnostic(error.to_string());
                                if state.lifecycle == "revoked" {
                                    store.save(&state)?;
                                    connection_lease_token.take();
                                    bootstrap_ticket.take();
                                    return Ok(());
                                }
                                state.reconnect_count += 1;
                                store.save(&state)?;
                                break true;
                            }
                        }
                        _ => {
                            state.record_diagnostic(
                                "malformed or unsupported control frame closed the connection",
                            );
                            store.save(&state)?;
                            if state.lifecycle == "revoked" {
                                connection_lease_token.take();
                                bootstrap_ticket.take();
                                return Ok(());
                            }
                            break true;
                        }
                    }
                }
            }
        };
        if disconnected {
            thread::sleep(config.reconnect_delay);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::{mpsc, Mutex};

    static ENVIRONMENT_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn config(root: &Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:1/durable_runner/connect".to_owned(),
            state_dir: root.to_path_buf(),
            runner_instance_id: "runner_durable_runner_stable".to_owned(),
            environment_lease_id: "lease_durable_runner_stable".to_owned(),
            run_id: "run_durable_runner_stable".to_owned(),
            normalized_session_id: "session_durable_runner_stable".to_owned(),
            turn_id: "turn_durable_runner_stable".to_owned(),
            item_id: "item_durable_runner_stable".to_owned(),
            runner_version: "0.3.0".to_owned(),
            runner_digest: "sha256:durable_runner-approved".to_owned(),
            fake_harness_path: None,
            fake_harness_script_path: None,
            max_outbox_bytes: 16 * 1024,
            p0_reserve_bytes: 8 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            max_runtime: Duration::from_millis(10),
        }
    }

    fn temporary_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperclip-runner-durable_runner-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Value {
        json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": id,
            "controllerSeq": sequence,
            "type": command_type,
            "issuedAt": deterministic_time(sequence),
            "payload": payload,
        })
    }

    fn read_masked_client_text(stream: &mut TcpStream) -> (Value, Vec<u8>) {
        let mut header = [0_u8; 2];
        stream.read_exact(&mut header).unwrap();
        assert_eq!(header[0] & 0x0f, 0x1);
        assert_ne!(header[1] & 0x80, 0);
        let mut captured = header.to_vec();
        let mut length = usize::from(header[1] & 0x7f);
        if length == 126 {
            let mut extended = [0_u8; 2];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0_u8; 8];
            stream.read_exact(&mut extended).unwrap();
            captured.extend_from_slice(&extended);
            length = usize::try_from(u64::from_be_bytes(extended)).unwrap();
        }
        let mut mask = [0_u8; 4];
        stream.read_exact(&mut mask).unwrap();
        captured.extend_from_slice(&mask);
        let mut payload = vec![0_u8; length];
        stream.read_exact(&mut payload).unwrap();
        captured.extend_from_slice(&payload);
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % mask.len()];
        }
        (serde_json::from_slice(&payload).unwrap(), captured)
    }

    fn send_server_json(stream: &mut TcpStream, value: &Value) {
        let payload = serde_json::to_vec(value).unwrap();
        let mut frame = vec![0x81];
        if payload.len() <= 125 {
            frame.push(payload.len() as u8);
        } else if payload.len() <= u16::MAX as usize {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        frame.extend_from_slice(&payload);
        stream.write_all(&frame).unwrap();
        stream.flush().unwrap();
    }

    #[test]
    fn durable_state_restores_identity_outbox_and_cumulative_ack() {
        let root = temporary_root("restore");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, recovered) = store.load_or_create(&config).unwrap();
        assert!(!recovered);
        let session_id = state.normalized_session_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "session.started",
            0,
            json!({ "session": session_id }),
            None,
        )
        .unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        let first_event_id = state.outbox[0].source_event_id.clone();
        store.save(&state).unwrap();

        let (mut restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(restored.runner_instance_id, config.runner_instance_id);
        assert_eq!(restored.normalized_session_id, config.normalized_session_id);
        assert_eq!(restored.outbox[0].source_event_id, first_event_id);
        restored.apply_ack(1).unwrap();
        assert_eq!(restored.acked_source_seq, 1);
        assert_eq!(restored.outbox.len(), 1);
        assert!(restored.apply_ack(0).is_err());
        assert!(restored.apply_ack(3).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_command_has_one_logical_effect_and_no_new_events() {
        let root = temporary_root("command-dedupe");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command("command_prepare", 1, "run.prepare", json!({}));
        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert!(first.command_digest.starts_with("sha256:"));
        assert_eq!(first.command_digest.len(), "sha256:".len() + 64);
        let event_count = state.outbox.len();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.result, second.result);
        assert_eq!(first.logical_effect_count, 1);
        assert_eq!(state.outbox.len(), event_count);
        assert_eq!(state.processed_commands.len(), 1);
        assert!(process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_prepare",
                1,
                "run.prepare",
                json!({ "changed": true })
            )
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn processed_command_ledger_compacts_to_a_fixed_bound_without_reenabling_effects() {
        let root = temporary_root("command-compaction");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        for sequence in 1..=256_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_256 = fs::metadata(store.path()).unwrap().len();
        for sequence in 257..=512_u64 {
            let command_id = format!("command_compaction_{sequence:04}");
            process_command(
                &mut state,
                &store,
                &config,
                &command(&command_id, sequence, "unsupported.compaction", json!({})),
            )
            .unwrap();
        }
        let size_after_512 = fs::metadata(store.path()).unwrap().len();
        assert_eq!(
            state.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        assert_eq!(state.compacted_command_count, 384);
        assert_eq!(
            state.compacted_command_filter.len(),
            COMPACTED_COMMAND_FILTER_BYTES * 2
        );
        assert!(size_after_512 <= size_after_256 + 1024);

        let replay = process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_compaction_0001",
                513,
                "run.prepare",
                json!({ "changed": true }),
            ),
        )
        .unwrap();
        assert_eq!(replay.status, "rejected");
        assert_eq!(replay.logical_effect_count, 0);
        assert_eq!(state.last_controller_command_seq, 513);
        assert!(!state
            .outbox
            .iter()
            .any(|event| event.event_type == "workspace.ready"));
        let (restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(
            restored.processed_commands.len(),
            MAX_RECENT_PROCESSED_COMMANDS
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malicious_loopback_listener_gets_no_capability_and_cannot_forge_control() {
        let root = temporary_root("malicious-loopback");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (state, _) = store.load_or_create(&config).unwrap();
        let secret = "bootstrap-malicious-listener-regression";
        let credential = CredentialMaterial::from_token(secret);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (wire_sender, wire_receiver) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
                )
                .unwrap();
            stream.flush().unwrap();
            let (hello, frame) = read_masked_client_text(&mut stream);
            let hello_payload = hello.get("payload").unwrap();
            let challenge_payload = json!({
                "credentialId": hello_payload.get("credentialId").unwrap(),
                "credentialKind": "bootstrap",
                "clientNonce": hello_payload.get("clientNonce").unwrap(),
                "serverNonce": "malicious-server-nonce",
                "runnerInstanceId": hello_payload.get("runnerInstanceId").unwrap(),
                "environmentLeaseId": hello_payload.get("environmentLeaseId").unwrap(),
                "runId": hello_payload.get("runId").unwrap(),
                "normalizedSessionId": hello_payload.get("normalizedSessionId").unwrap(),
                "turnId": hello_payload.get("turnId").unwrap(),
                "itemId": hello_payload.get("itemId").unwrap(),
                "runnerVersion": hello_payload.get("runnerVersion").unwrap(),
                "runnerDigest": hello_payload.get("runnerDigest").unwrap(),
                "selectedVersion": PROTOCOL_VERSION,
                "credentialLeaseId": Value::Null,
                "credentialExpiresAt": "2099-01-01T00:00:00.000Z",
                "credentialExpiresAtUnixMs": 4_070_908_800_000_u64,
                "revocationEpoch": 0,
                "serverProof": "00".repeat(32),
            });
            send_server_json(
                &mut stream,
                &json!({
                    "protocol": PROTOCOL,
                    "version": PROTOCOL_VERSION,
                    "kind": "auth_challenge",
                    "payload": challenge_payload,
                }),
            );
            request.extend_from_slice(&frame);
            wire_sender.send(request).unwrap();
        });
        let target =
            resolve_ws_target_with(&format!("ws://{address}/durable_runner/connect"), |_host, _port| {
                Ok(vec![address])
            })
            .unwrap();
        let mut client = WsClient::connect(&target, config.max_frame_bytes).unwrap();
        let error = authenticate_transport(
            &mut client,
            &state,
            &config,
            &credential,
            "bootstrap",
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("transport authentication proof is invalid"));
        assert!(client.secure_channel.is_none());
        let wire = wire_receiver.recv().unwrap();
        assert!(!wire
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
        assert_eq!(state.acked_source_seq, 0);
        assert!(state.processed_commands.is_empty());
        server.join().unwrap();
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_terminal_command_failure_restores_exact_prior_state_on_every_retry() {
        let root = temporary_root("command-atomic-p1");
        let mut config = config(&root);
        let sizing_state = DurableRunnerState::new(&config);
        let accepted_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            1,
            "turn.accepted",
            0,
            json!({ "turnId": sizing_state.turn_id, "sameSession": true }),
            None,
        ))
        .unwrap()
        .len();
        let started_size = serde_json::to_vec(&event_envelope(
            &sizing_state,
            2,
            "item.started",
            1,
            json!({ "kind": "assistant_message" }),
            Some(&sizing_state.item_id),
        ))
        .unwrap()
        .len();
        let non_p0_limit = accepted_size + started_size - 1;
        config.p0_reserve_bytes = 8 * 1024;
        config.max_outbox_bytes = non_p0_limit + config.p0_reserve_bytes;

        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let before_state = serde_json::to_vec(&state).unwrap();
        let before_file = fs::read(store.path()).unwrap();
        let value = command("command_tight_p1", 1, "turn.start", json!({}));

        let first_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        let second_error = process_command(&mut state, &store, &config, &value).unwrap_err();
        assert_eq!(second_error, first_error);
        assert_eq!(serde_json::to_vec(&state).unwrap(), before_state);
        assert_eq!(fs::read(store.path()).unwrap(), before_file);
        assert!(state.outbox.is_empty());
        assert!(state.processed_commands.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn p0_exhaustion_commits_only_unrecoverable_result_and_retry_is_stable() {
        let root = temporary_root("command-atomic-p0");
        let mut probe_config = config(&root);
        probe_config.max_outbox_bytes = 128 * 1024;
        probe_config.p0_reserve_bytes = 1;
        let mut probe = DurableRunnerState::new(&probe_config);
        execute_command_effect(
            &mut probe,
            &probe_config,
            "turn.start",
            &json!({ "text": "Durable runner" }),
        )
        .unwrap();
        assert!(probe.outbox.len() >= 5);
        let bytes_before_mandatory_p0 = probe
            .outbox
            .iter()
            .take(4)
            .map(|event| event.byte_size)
            .sum::<usize>();

        let mut config = config(&root);
        config.p0_reserve_bytes = 1;
        config.max_outbox_bytes = bytes_before_mandatory_p0 + 1;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command(
            "command_tight_p0",
            1,
            "turn.start",
            json!({ "text": "Durable runner" }),
        );

        let first = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.status, "failed");
        assert_eq!(first.logical_effect_count, 0);
        assert_eq!(state.lifecycle, "unrecoverable");
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.next_source_seq, 1);
        assert!(state.outbox.is_empty());
        assert_eq!(state.processed_commands.len(), 1);
        let after_first = serde_json::to_vec(&state).unwrap();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(second.result, first.result);
        assert_eq!(serde_json::to_vec(&state).unwrap(), after_first);
        let (persisted, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert!(persisted.outbox.is_empty());
        assert_eq!(persisted.next_source_seq, 1);
        assert_eq!(persisted.processed_commands.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pressure_coalesces_p2_preserves_p0_and_stays_bounded() {
        let root = temporary_root("pressure");
        let mut config = config(&root);
        config.max_outbox_bytes = 12 * 1024;
        config.p0_reserve_bytes = 6 * 1024;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_pressure", 1, "fault.storage_pressure", json!({})),
        )
        .unwrap();
        assert!(state.backpressure);
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "item.delta")
                .count(),
            1
        );
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        let persisted = fs::read_to_string(store.path()).unwrap();
        assert!(!persisted.contains("must-not-persist"));
        assert!(persisted.contains("[REDACTED]"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_coalesced_p2_retains_prior_event_and_never_exceeds_bounds() {
        let root = temporary_root("oversized-p2-coalesce");
        let mut config = config(&root);
        config.max_outbox_bytes = 8 * 1024;
        config.p0_reserve_bytes = 4 * 1024;
        let mut state = DurableRunnerState::new(&config);
        let item_id = state.item_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "small durable delta" }),
            Some(&item_id),
        )
        .unwrap();
        let prior = state.outbox[0].clone();

        enqueue_event(
            &mut state,
            &config,
            "item.delta",
            2,
            json!({ "text": "x".repeat(16 * 1024) }),
            Some(&item_id),
        )
        .unwrap();

        let retained = state
            .outbox
            .iter()
            .find(|event| event.event_type == "item.delta")
            .unwrap();
        assert_eq!(retained, &prior);
        assert!(state.backpressure);
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert!(state.peak_outbox_bytes <= config.max_outbox_bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drain_rejects_new_turn_and_revoke_preserves_unacked_events() {
        let root = temporary_root("drain");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_drain", 1, "runner.drain", json!({})),
        )
        .unwrap();
        let before = state.outbox.len();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_turn", 2, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox.len(), before);
        state.lifecycle = "revoked".to_owned();
        store.save(&state).unwrap();
        let (restored, _) = store.load_or_create(&config).unwrap();
        assert_eq!(restored.lifecycle, "revoked");
        assert_eq!(restored.outbox.len(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_p0_records_an_explicit_unrecoverable_outcome() {
        let root = temporary_root("unrecoverable");
        let mut config = config(&root);
        config.max_outbox_bytes = 512;
        config.p0_reserve_bytes = 256;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let result = enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "evidence": "x".repeat(4_096) }),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.lifecycle, "unrecoverable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_validation_rejects_public_private_wildcard_and_mixed_answers() {
        for (label, url, addresses) in [
            (
                "public",
                "ws://8.8.8.8:443/durable_runner/connect",
                vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()],
            ),
            (
                "private",
                "ws://10.1.2.3:3100/durable_runner/connect",
                vec!["10.1.2.3:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "wildcard",
                "ws://0.0.0.0:3100/durable_runner/connect",
                vec!["0.0.0.0:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "mixed-answer",
                "ws://mixed.test:3100/durable_runner/connect",
                vec![
                    "127.0.0.1:3100".parse::<SocketAddr>().unwrap(),
                    "192.0.2.9:3100".parse::<SocketAddr>().unwrap(),
                ],
            ),
        ] {
            let result = resolve_ws_target_with(url, |_host, _port| Ok(addresses));
            assert!(result.is_err(), "{label} destination must fail closed");
        }
    }

    #[test]
    fn destination_validation_rejects_malformed_userinfo_query_and_fragment_before_resolution() {
        for url in [
            "wss://127.0.0.1:3100/durable_runner/connect",
            "WS://127.0.0.1:3100/durable_runner/connect",
            "ws://127.0.0.1/durable_runner/connect",
            "ws://127.0.0.1:0/durable_runner/connect",
            "ws://[::1:3100/durable_runner/connect",
            "ws://user@127.0.0.1:3100/durable_runner/connect",
            "ws://127.0.0.1:3100/durable_runner/connect?ticket=ambiguous",
            "ws://127.0.0.1:3100/durable_runner/connect#fragment",
            "ws://127.0.0.1:3100/durable_runner\\connect",
        ] {
            let mut resolution_attempted = false;
            let result = resolve_ws_target_with(url, |_host, _port| {
                resolution_attempted = true;
                Ok(vec!["127.0.0.1:3100".parse().unwrap()])
            });
            assert!(result.is_err(), "ambiguous URL must be rejected: {url}");
            assert!(
                !resolution_attempted,
                "malformed URL reached destination resolution: {url}"
            );
        }
    }

    #[test]
    fn destination_validation_accepts_only_concrete_loopback_answers() {
        let target =
            resolve_ws_target_with("ws://localhost:3100/durable_runner/connect", |_host, _port| {
                Ok(vec![
                    "127.42.0.9:3100".parse().unwrap(),
                    "[::1]:3100".parse().unwrap(),
                ])
            })
            .unwrap();
        assert_eq!(target.addresses.len(), 2);
        assert!(target
            .addresses
            .iter()
            .all(|address| address.ip().is_loopback()));
    }

    #[test]
    fn oversized_outbound_websocket_frame_is_rejected_before_write() {
        let error = encode_masked_frame(0x1, b"ninebytes", [0; 4], 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("outbound WebSocket frame exceeds"));
    }

    #[test]
    fn oversized_inbound_websocket_frame_is_rejected_before_allocation() {
        let error = checked_inbound_frame_length(9, 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("inbound WebSocket frame exceeds"));
    }

    #[test]
    fn revoked_runner_rejects_turn_with_zero_effects_and_preserves_existing_outbox() {
        let root = temporary_root("revoked-command");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        state.lifecycle = "revoked".to_owned();
        let before = state.outbox.clone();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_after_revoke", 1, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox, before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_state_write_ignores_preplanted_predictable_symlink_and_uses_private_modes() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-symlink");
        let victim = root.join("victim.txt");
        fs::write(&victim, "unchanged").unwrap();
        let planted = root.join("runner-state.json.next");
        symlink(&victim, &planted).unwrap();
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        store.save(&DurableRunnerState::new(&config)).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "unchanged");
        assert!(fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(store.path()).unwrap().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn durable_state_load_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-load-symlink");
        let config = config(&root);
        let victim = root.join("victim.json");
        fs::write(
            &victim,
            serde_json::to_vec(&DurableRunnerState::new(&config)).unwrap(),
        )
        .unwrap();
        symlink(&victim, root.join("runner-state.json")).unwrap();
        let store = DurableStateStore::new(&root).unwrap();
        assert!(store.load_or_create(&config).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn captured_bootstrap_is_removed_and_absent_from_a_real_child_environment() {
        let _guard = ENVIRONMENT_TEST_LOCK.lock().unwrap();
        let secret = format!("bootstrap-environment-regression-{}", std::process::id());
        std::env::set_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", &secret);
        let ticket = capture_bootstrap_ticket().unwrap().unwrap();
        assert!(std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET").is_none());

        let mut child = SupervisedProcess::spawn(
            Path::new("/usr/bin/env"),
            &[],
            Duration::from_millis(50),
            16 * 1024,
        )
        .unwrap();
        let mut environment = Vec::new();
        while let Some(line) = child
            .receive_stdout_line(Duration::from_millis(250))
            .unwrap()
        {
            environment.push(line);
        }
        let exit = child.wait().unwrap();
        assert!(exit.success);
        let dump = environment.join("\n");
        assert!(!dump.contains("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"));
        assert!(!dump.contains(&secret));
        drop(ticket);
    }
}
