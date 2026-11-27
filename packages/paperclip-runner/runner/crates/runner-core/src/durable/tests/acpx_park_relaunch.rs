#[test]
fn parked_acpx_relaunch_replays_an_interrupted_attachment_before_admitting_work() {
    use crate::acpx_provider_backend::{
        park_relaunch_tests::parked_acpx_fixture, ACPX_PROVIDER_STATE_FILE,
    };
    use crate::durable::state::{
        PendingWarmRunTransition, WarmRunIdentity, WarmRunTransition, TRANSITION_STATE_SCHEMA,
    };
    use crate::native_provider_backend::NativeProviderCommandExecutor;

    struct ResumedExecutor(bool);
    impl CommandExecutor for ResumedExecutor {
        fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            assert!(self.0, "commands are fenced until activation");
            assert_eq!(command.command_type, "turn.start", "attachment must only replay");
            Ok(CommandExecution {
                result: json!({"runId":"run-2"}),
                events: vec![],
            })
        }

        fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
            assert_eq!(config.run_id, "run-2");
            self.0 = true;
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let (directory, mut old, mut attach, _, _) = parked_acpx_fixture("claude", false);
    old.connect_url = format!("ws://{}/api/runner/v1/connect/run-1", listener.local_addr().unwrap());
    old.max_runtime = Duration::from_secs(10);
    old.runner_digest = format!("sha256:{}", "a".repeat(64));
    let mut next = old.clone();
    next.run_id = "run-2".into();
    next.turn_id = "turn-2".into();
    next.item_id = "item-2".into();
    attach.payload["paperclipNextAuthority"] = json!({
        "identity": WarmRunIdentity::from_config(&next),
        "connection": {"mode":"external"},
    });
    let store = DurableStateStore::new(&directory).unwrap();
    let mut state = DurableState::new(&old);
    state.lifecycle = "ready".into();
    let mut prior = NativeProviderCommandExecutor::with_runner_config(&directory, &old);
    prior.observe_recovery_state(&state).unwrap();
    prior.defer_parked_acpx_restore().unwrap();
    state.begin_command(&attach).unwrap();
    let execution = prior.execute(&attach).unwrap();
    assert_eq!(execution.result["status"], "resumed");
    let result = state.complete_command(&attach, execution.result).unwrap();
    let expires = current_unix_ms().unwrap() + 60_000;
    let receipt = WarmRunTransition::new(
        &old, &next, &attach, &result, state.acked_source_seq, "lease_1".into(), expires, 1,
    ).unwrap();
    state.schema = TRANSITION_STATE_SCHEMA.into();
    state.warm_transition = Some(PendingWarmRunTransition {
        receipt: receipt.clone(),
        phase: "prepared".into(),
        command: attach,
        result,
    });
    store.save(&state).unwrap();
    drop(prior);

    let provider_path = directory.join(ACPX_PROVIDER_STATE_FILE);
    let provider = std::fs::read(&provider_path).unwrap();
    let provider_state: Value = serde_json::from_slice(&provider).unwrap();
    assert_eq!(provider_state["descriptor"]["runId"], next.run_id);
    assert!(store.load_or_create(&next).is_err(), "incoming authority is still fenced");

    let (socket, host) = UnixStream::pair().unwrap();
    let runner_config = old.clone();
    let runner = thread::spawn(move || {
        run_durable_runner_with_host_control(
            runner_config,
            BootstrapTicket::new("recovery-bootstrap".into()).unwrap(),
            ResumedExecutor(false),
            Some(HostControl::new(socket).unwrap().with_acpx_park_relaunch()),
        )
    });
    let receipt_value = serde_json::to_value(&receipt).unwrap();
    let turn = json!({
        "schema":"paperclip.prp.command.v1", "commandId":"next-turn",
        "controllerSeq":1, "type":"turn.start", "issuedAt":"2026-01-01T00:00:00Z", "payload":{}
    });
    let mut prior_turn = turn.clone();
    prior_turn["controllerSeq"] = json!(2);
    let mut new_state = DurableState::new(&next);
    new_state.warm_transition = state.warm_transition.clone();
    listener.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    for (expected, config, activating) in [(&state, &old, false), (&new_state, &next, true)] {
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("accept recovery connection: {e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut socket = accept(stream).unwrap();
        let mut secure = server_authenticate(&mut socket, config, expected, ServerCredential {
            token: if activating { "recovery-lease" } else { "recovery-bootstrap" },
            kind: if activating { "lease" } else { "bootstrap" },
            lease_id: activating.then_some("lease_1"),
            expires_at_unix_ms: expires,
            revocation_epoch: 1,
        });
        let mut welcome = welcome(
            expected, "recovery", (!activating).then_some("recovery-lease"), expires, 0,
            if activating { vec![] } else { vec![prior_turn.clone()] },
        );
        welcome["payload"]["warmTransitionVersion"] = json!(1);
        if activating {
            welcome["payload"]["warmTransitionPhase"] = json!("activated");
            welcome["payload"]["warmTransition"] = receipt_value.clone();
        }
        send_secure(&mut socket, &mut secure, config, &welcome);
        let replay = receive_secure(&mut socket, &mut secure, config);
        assert_eq!(replay["runId"], expected.run_id);
        let ack = if activating {
            assert_eq!(replay["kind"], "warm_transition_activated");
            assert_eq!(replay["payload"]["transitionId"], receipt.transition_id);
            control(expected, "recovery", "warm_transition_activated_ack",
                json!({"transitionId": receipt.transition_id}))
        } else {
            assert_eq!(replay["kind"], "command_result");
            assert_eq!(replay["payload"]["commandId"], receipt.command_id);
            control(expected, "recovery", "command_result_ack", json!({
                "commandId":receipt.command_id, "controllerSeq":receipt.controller_seq,
                "commandType":"run.attach", "status":"completed", "warmTransition":receipt_value,
            }))
        };
        send_secure(&mut socket, &mut secure, config, &ack);
        if activating {
            send_secure(&mut socket, &mut secure, config,
                &control(expected, "recovery", "command", turn.clone()));
            let result = receive_secure(&mut socket, &mut secure, config);
            assert_eq!(result["payload"]["commandId"], "next-turn");
            assert_eq!(result["payload"]["result"]["runId"], "run-2");
        }
    }
    drop(host);
    assert!(runner.join().unwrap().is_err());
    assert!(store.load_or_create(&old).is_err());
    let (active, _) = store.load_or_create(&next).unwrap();
    assert!(active.warm_transition.is_none());
    assert_eq!(std::fs::read(provider_path).unwrap(), provider);
    assert_eq!(std::fs::read_to_string(directory.join("starts")).unwrap(), "x");
    std::fs::remove_dir_all(directory).unwrap();
}
