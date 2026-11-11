/// A runnerd killed inside `runner.suspend` leaves it journaled but unfinished.
/// The next process replays it as `indeterminate`, sends it as `failed`, and the
/// controller acknowledges the `failed` it received. That acknowledgement names
/// the same receipt: the runner finishes the suspension instead of exiting with
/// "terminal command result acknowledgement changed its durable identity".
#[test]
fn indeterminate_suspend_replay_accepts_the_acknowledged_wire_status() {
    for acknowledged in ["failed", "indeterminate"] {
        indeterminate_suspend_replay_is_acknowledged(acknowledged);
    }
}

fn indeterminate_suspend_replay_is_acknowledged(acknowledged_status: &'static str) {
    struct NeverExecutes;

    impl super::super::CommandExecutor for NeverExecutes {
        fn execute(
            &mut self,
            command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            panic!("an indeterminate {} must never execute again", command.command_type);
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut config = config(port);
    config.max_runtime = Duration::from_secs(5);
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-indeterminate-terminal-ack-{}-{acknowledged_status}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    config.state_dir = directory.clone();
    let suspend = json!({
        "schema": "paperclip.prp.command.v1",
        "commandId": "command_suspend",
        "controllerSeq": 1,
        "type": "runner.suspend",
        "issuedAt": "2026-11-11T01:34:11.000Z",
        "payload": {},
    });
    {
        // The prior process journaled the suspend before its effect and died.
        let store = super::super::DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let command: Command = serde_json::from_value(suspend.clone()).unwrap();
        assert_eq!(
            state.begin_command(&command).unwrap(),
            super::super::CommandDisposition::Execute
        );
        store.save(&state).unwrap();
    }

    let state = test_state(&config);
    let expires = current_unix_ms().unwrap() + 60_000;
    let server_config = config.clone();
    let server_state = state.clone();
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
                vec![suspend],
            ),
        );
        let result = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(result["kind"], "command_result");
        assert_eq!(result["payload"]["commandId"], "command_suspend");
        assert_eq!(result["payload"]["status"], "failed");
        assert_eq!(
            result["payload"]["result"]["code"],
            "execution_indeterminate"
        );
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(
                &server_state,
                "connection_1",
                "command_result_ack",
                json!({
                    "commandId": "command_suspend",
                    "commandType": "runner.suspend",
                    "controllerSeq": 1,
                    "status": acknowledged_status,
                }),
            ),
        );
        // Acknowledge any terminal suffix until the runner closes.
        while let Ok(frame) = receive_plain(&mut socket, server_config.max_frame_bytes) {
            let message = secure.decrypt(&frame, true).unwrap();
            if message["kind"] == "event" {
                send_secure(
                    &mut socket,
                    &mut secure,
                    &server_config,
                    &control(
                        &server_state,
                        "connection_1",
                        "ack",
                        json!({"ackedSourceSeq": message["payload"]["sourceSeq"]}),
                    ),
                );
            }
        }
    });

    super::super::run_durable_runner(
        config.clone(),
        BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
        NeverExecutes,
    )
    .unwrap();
    server.join().unwrap();
    let store = super::super::DurableStateStore::new(&directory).unwrap();
    let (state, _) = store.load_or_create(&config).unwrap();
    assert_eq!(state.lifecycle, "suspended");
    assert!(state.pending_terminal_delivery.is_none());
    std::fs::remove_dir_all(directory).unwrap();
}
