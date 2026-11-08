// Shares this module's authenticated PRP server helpers.
use crate::durable::{
    run_durable_runner_with_host_control, CommandExecution, CommandExecutor, DurableStateStore,
    PolledEvent,
};
use crate::host_control::HostControl;
use std::io::BufRead;
use std::os::unix::net::UnixStream;

struct RetentionExecutor {
    polls: Arc<AtomicUsize>,
    shutdowns: Arc<AtomicUsize>,
}
impl CommandExecutor for RetentionExecutor {
    fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
        panic!("host control must not execute business commands");
    }
    fn host_park_ready(&mut self) -> Result<bool, DurableRunnerError> {
        Ok(true)
    }
    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Ok(vec![])
    }
    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn host_exchange(host: &mut UnixStream, request: Value) -> Value {
    writeln!(host, "{request}").unwrap();
    let mut line = String::new();
    BufReader::new(host).read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn hosted_loop_parks_and_reclaims_with_fresh_bootstrap_during_busy_prp() {
    exercise_hosted_loop(None);
}

#[test]
fn hosted_claim_blocks_pending_and_live_work_before_attachment() {
    for pending in [true, false] {
        exercise_hosted_loop(Some(pending));
    }
}

fn exercise_hosted_loop(blocked_work: Option<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut config = config(listener.local_addr().unwrap().port());
    let directory =
        std::env::temp_dir().join(format!("paperclip-host-loop-{}", uuid::Uuid::new_v4()));
    config.state_dir = directory.clone();
    config.max_runtime = Duration::from_secs(15);
    config.reconnect_grace = Some(Duration::from_millis(20));
    let state = test_state(&config);
    let server_config = config.clone();
    let server_state = state.clone();
    let (busy_tx, busy_rx) = mpsc::channel();
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let expires = current_unix_ms().unwrap() + 60_000;
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let mut secure = server_authenticate(
            &mut socket,
            &server_config,
            &server_state,
            ServerCredential {
                token: "initial-private-bootstrap",
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
                "connection-1",
                Some("old-private-lease"),
                expires,
                0,
                vec![],
            ),
        );
        let mut announced = false;
        // Keep PRP readable. Host control must not depend on an idle socket read.
        loop {
            let ping = control(&server_state, "connection-1", "ping", json!({}));
            let encrypted = secure
                .encrypt(&serde_json::to_vec(&ping).unwrap(), true)
                .unwrap();
            if send_plain(&mut socket, &encrypted, server_config.max_frame_bytes).is_err() {
                break;
            }
            let Ok(frame) = receive_plain(&mut socket, server_config.max_frame_bytes) else {
                break;
            };
            assert_eq!(secure.decrypt(&frame, true).unwrap()["kind"], "pong");
            if !announced {
                busy_tx.send(()).unwrap();
                announced = true;
            }
        }
        drop(socket);
        // A parked Runner must accept the new bootstrap, never the old lease.
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut socket = accept(stream).unwrap();
        let mut secure = server_authenticate(
            &mut socket,
            &server_config,
            &server_state,
            ServerCredential {
                token: "fresh-private-bootstrap",
                kind: "bootstrap",
                lease_id: None,
                expires_at_unix_ms: expires,
                revocation_epoch: 0,
            },
        );
        let forbidden = json!({
            "schema":"paperclip.prp.command.v1", "commandId":"premature-turn",
            "controllerSeq":1, "type":"turn.start", "issuedAt":"2026-01-01T00:00:00Z", "payload":{}
        });
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &welcome(
                &server_state,
                "connection-2",
                Some("new-private-lease"),
                expires,
                0,
                if blocked_work == Some(true) { vec![forbidden.clone()] } else { vec![] },
            ),
        );
        if let Some(pending) = blocked_work {
            if !pending {
                send_secure(&mut socket, &mut secure, &server_config,
                    &control(&server_state, "connection-2", "command", forbidden));
            }
            finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            return;
        }
        send_secure(
            &mut socket,
            &mut secure,
            &server_config,
            &control(&server_state, "connection-2", "ping", json!({})),
        );
        assert_eq!(
            receive_secure(&mut socket, &mut secure, &server_config)["kind"],
            "pong"
        );
        claimed_tx.send(()).unwrap();
        finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    let polls = Arc::new(AtomicUsize::new(0));
    let shutdowns = Arc::new(AtomicUsize::new(0));
    let executor = RetentionExecutor {
        polls: polls.clone(),
        shutdowns: shutdowns.clone(),
    };
    let (socket, mut host) = UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let runner_config = config.clone();
    let runner = thread::spawn(move || {
        run_durable_runner_with_host_control(
            runner_config,
            BootstrapTicket::new("initial-private-bootstrap".to_owned()).unwrap(),
            executor,
            Some(HostControl::new(socket).unwrap()),
        )
    });
    busy_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let identity = json!({"runnerInstanceId":state.runner_instance_id,"environmentLeaseId":state.environment_lease_id,
        "runId":state.run_id,"normalizedSessionId":state.normalized_session_id,"turnId":state.turn_id,"itemId":state.item_id});
    assert_eq!(
        host_exchange(
            &mut host,
            json!({"op":"park","id":"park-1","identity":identity,
        "lastControllerCommandSeq":0,"ackedSourceSeq":0})
        )["status"],
        "parked"
    );
    let parked_polls = polls.load(Ordering::SeqCst);
    assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    thread::sleep(Duration::from_millis(80));
    assert_eq!(polls.load(Ordering::SeqCst), parked_polls);
    assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(
        host_exchange(
            &mut host,
            json!({"op":"claim","id":"claim-1","parkId":"park-1",
        "bootstrapTicket":"fresh-private-bootstrap"})
        )["status"],
        "claimed"
    );
    if blocked_work.is_some() {
        let error = runner.join().unwrap().unwrap_err();
        assert_eq!(error.to_string(), "claimed Runner requires authority attachment before execution");
        finish_tx.send(()).unwrap();
        server.join().unwrap();
        let retained = DurableStateStore::new(&directory).unwrap().load_or_create(&config).unwrap().0;
        assert_eq!(retained.last_controller_command_seq, 0);
        assert!(retained.processed_commands.is_empty());
        std::fs::remove_dir_all(directory).unwrap();
        return;
    }
    claimed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    thread::sleep(Duration::from_millis(400));
    assert_eq!(polls.load(Ordering::SeqCst), parked_polls);
    // A stale parked-only retirement cannot kill a newly claimed process.
    assert_eq!(
        host_exchange(
            &mut host,
            json!({"op":"retire","id":"stale-retire","parkId":"park-1"})
        )["status"],
        "conflict"
    );
    assert_eq!(
        host_exchange(
            &mut host,
            json!({"op":"retire","id":"retire-claim","parkId":"park-1",
        "claimId":"claim-1","identity":identity,"lastControllerCommandSeq":0,"ackedSourceSeq":0})
        )["status"],
        "retired"
    );
    assert!(runner.join().unwrap().is_ok());
    finish_tx.send(()).unwrap();
    server.join().unwrap();
    assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(
        DurableStateStore::new(&directory)
            .unwrap()
            .load_or_create(&config)
            .unwrap()
            .0
            .lifecycle,
        "suspended"
    );
    std::fs::remove_dir_all(directory).unwrap();
}
