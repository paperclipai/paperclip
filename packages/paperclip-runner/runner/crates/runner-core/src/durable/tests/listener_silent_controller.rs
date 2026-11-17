#[test]
fn listener_accepts_a_new_controller_after_the_current_one_goes_silent() {
    struct ShutdownOnly(Arc<std::sync::Mutex<Vec<String>>>);

    impl super::super::CommandExecutor for ShutdownOnly {
        fn execute(
            &mut self,
            command: &Command,
        ) -> Result<super::super::CommandExecution, DurableRunnerError> {
            self.0.lock().unwrap().push(command.command_type.clone());
            Ok(super::super::CommandExecution::result(
                json!({"status": "completed"}),
            ))
        }
    }

    let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = reservation.local_addr().unwrap();
    drop(reservation);
    let path = "/api/runner/v1/connect/run_1";
    let mut config = config(address.port());
    config.connect_url = format!("listen://0.0.0.0:{}{path}", address.port());
    config.max_runtime = Duration::from_secs(10);
    config.controller_silence = Duration::from_millis(500);
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-listener-silent-controller-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    config.state_dir = directory.clone();
    let state = test_state(&config);
    let expires = current_unix_ms().unwrap() + 60_000;
    let server_config = config.clone();
    let server_state = state.clone();
    let (outcome, received) = mpsc::channel();
    let server = thread::spawn(move || {
        let open = |deadline: Instant| loop {
            match TcpStream::connect(address) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                Err(error) => panic!("Runner never listened: {error}"),
            }
        };
        let stream = open(Instant::now() + Duration::from_secs(5));
        let (mut silent, _) = client(format!("ws://{address}{path}"), stream).unwrap();
        let mut silent_secure = server_authenticate(
            &mut silent,
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
            &mut silent,
            &mut silent_secure,
            &server_config,
            &welcome(&server_state, "connection_1", Some("lease-secret"), expires, 0, vec![]),
        );
        let replacement = open(Instant::now() + Duration::from_secs(5));
        replacement
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let (mut socket, _) = match client(format!("ws://{address}{path}"), replacement) {
            Ok(connected) => connected,
            Err(error) => {
                outcome.send(format!("replacement was not accepted: {error}")).unwrap();
                return;
            }
        };
        let mut secure = server_authenticate(
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
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &welcome(&server_state, "connection_2", None, expires, 0, vec![]),
        );
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(
                &server_state,
                "connection_2",
                "command",
                json!({
                    "schema": "paperclip.prp.command.v1",
                    "commandId": "command_1",
                    "controllerSeq": 1,
                    "type": "runner.shutdown",
                    "issuedAt": "2026-11-17T19:52:17.000Z",
                    "payload": {},
                }),
            ),
        );
        let result = receive_secure(&mut socket, &mut secure, &server_config);
        assert_eq!(result["kind"], "command_result");
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(
                &server_state,
                "connection_2",
                "command_result_ack",
                json!({
                    "commandId": "command_1",
                    "commandType": "runner.shutdown",
                    "controllerSeq": 1,
                    "status": "completed",
                }),
            ),
        );
        outcome.send("accepted".to_owned()).unwrap();
        drop(silent);
    });

    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let run = super::super::run_durable_runner(
        config,
        BootstrapTicket::new("bootstrap-secret".to_owned()).unwrap(),
        ShutdownOnly(log.clone()),
    );
    let outcome = received.recv_timeout(Duration::from_secs(10)).unwrap();
    server.join().unwrap();
    assert_eq!(outcome, "accepted");
    run.unwrap();
    assert_eq!(*log.lock().unwrap(), ["runner.shutdown"]);
    std::fs::remove_dir_all(directory).unwrap();
}
