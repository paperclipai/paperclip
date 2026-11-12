#[test]
fn acknowledged_output_polls_the_provider_without_waiting_out_the_read_timeout() {
    acknowledged_prefix_releases_provider_output(AckRelease::Idle);
}

#[test]
fn control_queued_behind_an_ack_runs_before_the_next_provider_poll() {
    acknowledged_prefix_releases_provider_output(AckRelease::QueuedCommand);
}

#[test]
fn replayed_output_ack_keeps_the_read_timeout_before_the_provider_poll() {
    acknowledged_prefix_releases_provider_output(AckRelease::Replayed);
}

#[test]
fn welcome_command_output_polls_the_provider_without_waiting_out_the_read_timeout() {
    acknowledged_prefix_releases_provider_output(AckRelease::WelcomeCommand);
}

#[test]
fn restorable_provider_ack_keeps_the_read_timeout_before_the_provider_poll() {
    acknowledged_prefix_releases_provider_output(AckRelease::NotLive);
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum AckRelease {
    Idle,
    QueuedCommand,
    Replayed,
    NotLive,
    WelcomeCommand,
}

fn acknowledged_prefix_releases_provider_output(mode: AckRelease) {
    struct PollingExecutor {
        live: bool,
        opened: bool,
        emitted: bool,
        control_frame_read_at: Option<Instant>,
        poll_delay: Arc<std::sync::Mutex<Option<Duration>>>,
        log: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl super::super::CommandExecutor for PollingExecutor {
        fn execute(
            &mut self,
            command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            self.log.lock().unwrap().push(command.command_type.clone());
            if command.command_type != "session.open" {
                return Ok(super::super::CommandExecution::result(
                    json!({"status": "completed"}),
                ));
            }
            self.opened = true;
            Ok(super::super::CommandExecution {
                result: json!({"status": "completed"}),
                events: vec![(
                    "provider.notice.recorded".to_owned(),
                    super::super::EventPriority::P1,
                    json!({"message": "accepted"}),
                )],
            })
        }

        fn poll_events(&mut self) -> Result<Vec<super::super::PolledEvent>, DurableRunnerError> {
            if !self.opened || self.emitted {
                return Ok(Vec::new());
            }
            self.emitted = true;
            *self.poll_delay.lock().unwrap() =
                self.control_frame_read_at.map(|read_at| read_at.elapsed());
            self.log.lock().unwrap().push("poll".to_owned());
            Ok(vec![super::super::PolledEvent {
                executor_event_id: "provider_event_1".to_owned(),
                event_type: "provider.notice.recorded".to_owned(),
                priority: super::super::EventPriority::P1,
                payload: json!({"message": "started"}),
            }])
        }

        fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
            self.control_frame_read_at = Some(Instant::now());
            Ok(())
        }

        fn provider_poll_is_live(&self) -> bool {
            self.live && self.opened
        }
    }

    let command = |seq: u64, command_type: &str| {
        json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": format!("command_{seq}"),
            "controllerSeq": seq,
            "type": command_type,
            "issuedAt": "2026-08-24T00:00:00.000Z",
            "payload": {},
        })
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut config = config(port);
    config.max_runtime = Duration::from_secs(5);
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-ack-poll-{}-{mode:?}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    config.state_dir = directory.clone();
    let state = test_state(&config);
    let expires = current_unix_ms().unwrap() + 60_000;
    let server_config = config.clone();
    let server_state = state.clone();
    let open_command = command(1, "session.open");
    let snapshot_command = command(2, "session.snapshot");
    let fast_poll = matches!(mode, AckRelease::Idle | AckRelease::WelcomeCommand);
    let shutdown_seq = if fast_poll { 2 } else { 3 };
    let shutdown_command = command(shutdown_seq, "runner.shutdown");
    let server = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket = accept(stream).unwrap();
        let mut secure = server_authenticate(
            &mut socket,
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
            &mut socket,
            &mut secure,
            &server_config,
            &welcome(
                &server_state,
                "connection_1",
                Some("lease-secret"),
                expires,
                0,
                if mode == AckRelease::WelcomeCommand {
                    vec![open_command.clone()]
                } else {
                    Vec::new()
                },
            ),
        );
        if mode != AckRelease::WelcomeCommand {
            send_secure(
                &mut socket,
                &mut secure,
                &server_config,
                &control(
                    &server_state,
                    "connection_1",
                    "command",
                    open_command.clone(),
                ),
            );
        }
        let open_result = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(open_result["kind"], "command_result");
        let open_event = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(open_event["kind"], "event");
        let mut connection = "connection_1";
        if mode == AckRelease::Replayed {
            drop(socket);
            let (stream, _) = listener.accept().unwrap();
            socket = accept(stream).unwrap();
            secure = server_authenticate(
                &mut socket,
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
            connection = "connection_2";
            send_secure(
                &mut socket,
                &mut secure,
                &server_config,
                &welcome(
                    &server_state,
                    connection,
                    None,
                    expires,
                    0,
                    vec![open_command],
                ),
            );
            assert_eq!(
                receive_secure(&mut socket, &mut secure, &server_config),
                open_result
            );
            assert_eq!(
                receive_secure(&mut socket, &mut secure, &server_config),
                open_event
            );
        }
        let ack = control(
            &server_state,
            connection,
            "ack",
            json!({"ackedSourceSeq": 1}),
        );
        let snapshot = control(&server_state, connection, "command", snapshot_command);
        match mode {
            AckRelease::Idle | AckRelease::WelcomeCommand => {
                send_secure(&mut socket, &mut secure, &server_config, &ack)
            }
            AckRelease::QueuedCommand => {
                for value in [ack, snapshot] {
                    let encrypted = secure
                        .encrypt(&serde_json::to_vec(&value).unwrap(), true)
                        .unwrap();
                    socket
                        .write(
                            encode_plain_message(&encrypted, server_config.max_frame_bytes)
                                .unwrap(),
                        )
                        .unwrap();
                }
                socket.flush().unwrap();
            }
            AckRelease::Replayed | AckRelease::NotLive => {
                send_secure(&mut socket, &mut secure, &server_config, &ack);
                thread::sleep(Duration::from_millis(50));
                send_secure(&mut socket, &mut secure, &server_config, &snapshot);
            }
        }
        if !fast_poll {
            let result = receive_secure(&mut socket, &mut secure, &server_config);
            assert_eq!(result["kind"], "command_result");
            assert_eq!(result["payload"]["commandType"], "session.snapshot");
        }
        let polled = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(polled["kind"], "event");
        assert_eq!(polled["payload"]["payload"]["message"], "started");
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(
                &server_state,
                connection,
                "ack",
                json!({"ackedSourceSeq": 2}),
            ),
        );
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(&server_state, connection, "command", shutdown_command),
        );
        let shutdown_result = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(shutdown_result["kind"], "command_result");
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(
                &server_state,
                connection,
                "command_result_ack",
                json!({
                    "commandId": format!("command_{shutdown_seq}"),
                    "commandType": "runner.shutdown",
                    "controllerSeq": shutdown_seq,
                    "status": "completed",
                }),
            ),
        );
    });

    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let poll_delay = Arc::new(std::sync::Mutex::new(None));
    super::super::run_durable_runner(
        config,
        BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
        PollingExecutor {
            live: mode != AckRelease::NotLive,
            opened: false,
            emitted: false,
            control_frame_read_at: None,
            poll_delay: poll_delay.clone(),
            log: log.clone(),
        },
    )
    .unwrap();
    server.join().unwrap();
    let expected: &[&str] = if fast_poll {
        &["session.open", "poll", "runner.shutdown"]
    } else {
        &[
            "session.open",
            "session.snapshot",
            "poll",
            "runner.shutdown",
        ]
    };
    assert_eq!(*log.lock().unwrap(), expected);
    if fast_poll {
        let delay = poll_delay.lock().unwrap().unwrap();
        assert!(
            delay < RUNTIME_READ_TIMEOUT,
            "the provider poll waited {delay:?} after its ACK was read"
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
