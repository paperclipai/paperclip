// Included in transport's private test module to exercise the actual mutually
// authenticated, encrypted lane and normal durable runner command loop.
#[test]
fn storage_wait_distinguishes_socket_loss_from_invalid_protocol() {
    assert!(map_websocket_error(tungstenite::Error::ConnectionClosed).is_transport_unavailable());
    assert!(
        map_websocket_error(tungstenite::Error::Io(std::io::Error::from(
            std::io::ErrorKind::BrokenPipe
        )))
        .is_transport_unavailable()
    );
    assert!(map_websocket_error(tungstenite::Error::Protocol(
        tungstenite::error::ProtocolError::ResetWithoutClosingHandshake
    ))
    .is_transport_unavailable());
    assert!(!map_websocket_error(tungstenite::Error::Protocol(
        tungstenite::error::ProtocolError::SendAfterClosing
    ))
    .is_transport_unavailable());
    assert!(!DurableRunnerError::invalid("authentication failed").is_transport_unavailable());
}

#[test]
fn storage_pressure_coalesces_ack_debt_without_reordering_commands() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (_server, _) = listener.accept().unwrap();
    let mut transport = AuthenticatedTransport {
        socket: RunnerSocket::Listen(WebSocket::from_raw_socket(
            client,
            tungstenite::protocol::Role::Client,
            None,
        )),
        secure_channel: SecureChannel::client(&[1; 32], b"challenge", b"server", b"client")
            .unwrap(),
        max_frame_bytes: 16 * 1024 * 1024,
        deferred: Default::default(),
        deferred_bytes: 0,
    };
    for seq in 0..10_000 {
        transport
            .defer_control(json!({"kind":"ack","payload":{"ackedSourceSeq":seq}}))
            .unwrap();
    }
    let command = json!({"kind":"command","payload":{"commandId":"after-acks"}});
    transport.defer_control(command.clone()).unwrap();
    for seq in 10_000..20_000 {
        transport
            .defer_control(json!({"kind":"ack","payload":{"ackedSourceSeq":seq}}))
            .unwrap();
    }
    assert_eq!(transport.deferred.len(), 3);
    assert!(transport
        .defer_control(json!({"kind":"ack","payload":{"ackedSourceSeq":7}}))
        .is_err());
    assert_eq!(
        transport.receive_json().unwrap().unwrap()["payload"]["ackedSourceSeq"],
        9_999
    );
    assert_eq!(transport.receive_json().unwrap().unwrap(), command);
    assert_eq!(
        transport.receive_json().unwrap().unwrap()["payload"]["ackedSourceSeq"],
        19_999
    );
    assert_eq!(transport.deferred_bytes, 0);
    for _ in 0..128 {
        transport.defer_control(command.clone()).unwrap();
    }
    assert!(transport.defer_control(command).is_err());
    assert_eq!(transport.deferred.len(), 128);
}

#[test]
fn storage_pressure_recovers_without_reexecuting_effects_or_losing_the_lease() {
    storage_pressure_transport_case(None, false, None);
}

#[test]
fn storage_pressure_revocation_stops_owned_execution_while_sqlite_remains_full() {
    storage_pressure_transport_case(Some("revoke"), false, None);
}

#[test]
fn storage_pressure_stop_is_responsive_without_a_false_terminal_receipt() {
    storage_pressure_transport_case(Some("stop"), false, None);
}

#[test]
fn storage_pressure_recovers_a_command_delivered_in_the_welcome() {
    storage_pressure_transport_case(None, true, None);
}

#[test]
fn storage_pressure_recovers_after_a_socket_disconnect_without_repeating_the_effect() {
    storage_pressure_transport_case(None, false, Some(false));
}

#[test]
fn storage_pressure_disconnect_cannot_extend_the_authenticated_lease() {
    storage_pressure_transport_case(None, false, Some(true));
}

fn storage_pressure_transport_case(
    cancel: Option<&'static str>,
    pending_welcome: bool,
    disconnected_expiry: Option<bool>,
) {
    use crate::indexed_store::{ExactReceipt, IndexedStore};
    fn accept_before(listener: &TcpListener, deadline: std::time::Instant) -> TcpStream {
        listener.set_nonblocking(true).unwrap();
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "runner did not reconnect before the test deadline"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("controller accept failed: {error}"),
            }
        }
    }
    fn receive_before(
        socket: &mut WebSocket<TcpStream>,
        secure: &mut SecureChannel,
        config: &DurableRunnerConfig,
        deadline: std::time::Instant,
    ) -> Value {
        // Runtime storage waits use the test's execution deadline, not the
        // transport helper's short authentication deadline. Parallel fsync
        // qualifications can legitimately exceed the latter after admission.
        socket
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        loop {
            if let Some(frame) =
                receive_plain_optional_until(socket, config.max_frame_bytes, Some(deadline))
                    .unwrap()
            {
                return secure.decrypt(&frame, true).unwrap();
            }
        }
    }
    struct Executor {
        store: IndexedStore,
        effects: Arc<AtomicUsize>,
        shutdowns: Arc<AtomicUsize>,
    }
    impl super::super::CommandExecutor for Executor {
        fn execute(
            &mut self,
            command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            if command.command_type == "session.open" {
                self.effects.fetch_add(1, Ordering::SeqCst);
                self.store.commit(
                    "provider",
                    1,
                    b"completed".to_vec(),
                    vec![ExactReceipt {
                        namespace: "effects".into(),
                        key: "one-effect".into(),
                        bytes: vec![b'x'; 2 * 1024 * 1024],
                    }],
                )?;
            }
            Ok(super::super::CommandExecution::result(
                json!({"status":"completed"}),
            ))
        }
        fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut cfg = config(listener.local_addr().unwrap().port());
    cfg.max_runtime = Duration::from_secs(90);
    let directory =
        std::env::temp_dir().join(format!("paperclip-capacity-{}", uuid::Uuid::new_v4()));
    cfg.state_dir = directory.join("runner");
    let store = IndexedStore::open(
        &directory.join("provider/state.sqlite"),
        "pressure-test",
        true,
    )
    .unwrap();
    store
        .commit("provider", 0, b"before".to_vec(), vec![])
        .unwrap();
    store.test_capacity(true);
    let server_store = store.clone();
    let server_cfg = cfg.clone();
    let state = test_state(&cfg);
    let server = thread::spawn(move || {
        let deadline = std::time::Instant::now() + server_cfg.max_runtime;
        let stream = accept_before(&listener, deadline);
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let mut connection_id = "connection_1";
        // Keep the intentional expiry case short. Recovery cases leave time
        // for a real FULL-synchronous commit under the full suite's I/O load.
        let expires = current_unix_ms().unwrap()
            + if disconnected_expiry == Some(true) {
                4_000
            } else {
                30_000
            };
        let mut secure = server_authenticate(
            &mut socket,
            &server_cfg,
            &state,
            ServerCredential {
                token: "bootstrap-secret",
                kind: "bootstrap",
                lease_id: None,
                expires_at_unix_ms: expires,
                revocation_epoch: 0,
            },
        );
        let open = json!({
            "schema":"paperclip.prp.command.v1", "commandId":"command_open", "controllerSeq":1,
            "type":"session.open", "issuedAt":"2026-09-28T00:00:00Z", "payload":{},
        });
        let mut greeting = welcome(
            &state,
            connection_id,
            Some("lease-secret"),
            expires,
            0,
            if pending_welcome {
                vec![open.clone()]
            } else {
                vec![]
            },
        );
        greeting["payload"]["connectionLeaseRenewalVersion"] = json!(1);
        send_secure(&mut socket, &mut secure, &server_cfg, &greeting);
        if !pending_welcome {
            send_secure(
                &mut socket,
                &mut secure,
                &server_cfg,
                &control(&state, connection_id, "command", open.clone()),
            );
        }
        send_secure(
            &mut socket,
            &mut secure,
            &server_cfg,
            &control(&state, connection_id, "ack", json!({"ackedSourceSeq":0})),
        );
        send_secure(
            &mut socket,
            &mut secure,
            &server_cfg,
            &control(&state, connection_id, "ping", json!({})),
        );
        let mut pong = false;
        loop {
            let message = receive_before(&mut socket, &mut secure, &server_cfg, deadline);
            match message["kind"].as_str().unwrap() {
                "pong" => {
                    assert_eq!(message["payload"]["storagePressure"], true);
                    pong = true;
                    if let Some(expire) = disconnected_expiry {
                        drop(socket);
                        if expire {
                            return;
                        }
                        thread::sleep(Duration::from_millis(200));
                        server_store.test_capacity(false);
                        let stream = accept_before(&listener, deadline);
                        stream
                            .set_read_timeout(Some(Duration::from_secs(15)))
                            .unwrap();
                        socket = accept(stream).unwrap();
                        secure = server_authenticate(
                            &mut socket,
                            &server_cfg,
                            &state,
                            ServerCredential {
                                token: "lease-secret",
                                kind: "lease",
                                lease_id: Some("lease_1"),
                                expires_at_unix_ms: expires,
                                revocation_epoch: 1,
                            },
                        );
                        connection_id = "connection_2";
                        send_secure(
                            &mut socket,
                            &mut secure,
                            &server_cfg,
                            &welcome(&state, connection_id, None, expires, 0, vec![open.clone()]),
                        );
                        continue;
                    }
                    if let Some(cancel) = cancel {
                        let message = if cancel == "revoke" {
                            control(
                                &state,
                                connection_id,
                                "revoke",
                                json!({"revocationEpoch":2}),
                            )
                        } else {
                            control(
                                &state,
                                connection_id,
                                "command",
                                json!({
                                    "schema":"paperclip.prp.command.v1", "commandId":"command_stop", "controllerSeq":2,
                                    "type":"turn.stop", "issuedAt":"2026-09-28T00:00:01Z", "payload":{},
                                }),
                            )
                        };
                        send_secure(&mut socket, &mut secure, &server_cfg, &message);
                        return;
                    }
                }
                "lease_renew" => {
                    assert!(pong, "the ping must remain responsive before renewal");
                    send_secure(
                        &mut socket,
                        &mut secure,
                        &server_cfg,
                        &control(
                            &state,
                            connection_id,
                            "lease_renewed",
                            json!({
                                "previousExpiresAtUnixMs":expires, "connectionLeaseExpiresAtUnixMs":current_unix_ms().unwrap()+60_000,
                                "connectionLeaseRevocationEpoch":1,
                            }),
                        ),
                    );
                    server_store.test_capacity(false);
                }
                "command_result" => {
                    assert!(pong);
                    assert_eq!(message["payload"]["commandId"], "command_open");
                    assert_eq!(message["payload"]["status"], "completed");
                    break;
                }
                other => panic!("unexpected pressure response: {other}"),
            }
        }
        send_secure(
            &mut socket,
            &mut secure,
            &server_cfg,
            &control(
                &state,
                connection_id,
                "command",
                json!({
                    "schema":"paperclip.prp.command.v1", "commandId":"command_shutdown", "controllerSeq":2,
                    "type":"runner.shutdown", "issuedAt":"2026-09-28T00:00:01Z", "payload":{},
                }),
            ),
        );
        let message = receive_before(&mut socket, &mut secure, &server_cfg, deadline);
        assert_eq!(message["payload"]["commandId"], "command_shutdown");
        send_secure(
            &mut socket,
            &mut secure,
            &server_cfg,
            &control(
                &state,
                connection_id,
                "command_result_ack",
                json!({
                    "commandId":"command_shutdown", "commandType":"runner.shutdown", "controllerSeq":2, "status":"completed",
                }),
            ),
        );
    });
    let effects = Arc::new(AtomicUsize::new(0));
    let shutdowns = Arc::new(AtomicUsize::new(0));
    let result = super::super::run_indexed_durable_runner(
        cfg.clone(),
        BootstrapTicket::new("bootstrap-secret".into()).unwrap(),
        Executor {
            store: store.clone(),
            effects: effects.clone(),
            shutdowns: shutdowns.clone(),
        },
    );
    if let Err(error) = &result {
        eprintln!("pressure case cancel={cancel:?} welcome={pending_welcome} disconnected_expiry={disconnected_expiry:?}: {error}");
    }
    assert!(
        server.join().is_ok(),
        "pressure controller failed; runner result: {result:?}"
    );
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    let current = store.read_state("provider").unwrap().unwrap();
    if cancel.is_some() || disconnected_expiry == Some(true) {
        let error = result.unwrap_err();
        assert!(error.is_storage_wait_cancelled());
        assert!(
            error.to_string().contains(if cancel == Some("revoke") {
                "capability revoked"
            } else if cancel == Some("stop") {
                "stop requested"
            } else {
                "lease expired"
            }),
            "{error}"
        );
        assert_eq!(current.generation, 1);
        assert_eq!(current.bytes, b"before");
        assert!(store.receipt("effects", "one-effect").unwrap().is_none());
        // The effect happened before capacity failed. A stopped runner cannot
        // label it completed or execute it again when it later reopens.
        let runner = super::super::DurableStateStore::new_indexed(&cfg.state_dir).unwrap();
        let (mut recovered, existed) = runner.load_or_create(&cfg).unwrap();
        assert!(existed);
        let open: Command = serde_json::from_value(json!({
            "schema":"paperclip.prp.command.v1", "commandId":"command_open", "controllerSeq":1,
            "type":"session.open", "issuedAt":"2026-09-28T00:00:00Z", "payload":{},
        }))
        .unwrap();
        assert!(
            matches!(recovered.begin_command(&open).unwrap(), super::super::CommandDisposition::Replay(result) if result.status == "indeterminate")
        );
    } else {
        result.unwrap();
        assert_eq!(current.generation, 2);
        assert_eq!(current.bytes, b"completed");
        assert_eq!(
            store.receipt("effects", "one-effect").unwrap().unwrap(),
            vec![b'x'; 2 * 1024 * 1024]
        );
    }
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}
