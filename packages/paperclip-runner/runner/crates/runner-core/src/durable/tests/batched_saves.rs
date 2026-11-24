// Saves per provider batch and per cumulative ACK. Shares the helpers of
// `durable::runner::tests`.

#[test]
fn provider_batch_commits_with_one_durable_save() {
    for size in [8_usize, 48] {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-group-commit-{size}-{}",
            uuid::Uuid::new_v4()
        ));
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: (1..=size)
                .map(|index| PolledEvent {
                    executor_event_id: format!("provider-event-{index}"),
                    event_type: "item.delta".to_owned(),
                    priority: EventPriority::P2,
                    payload: json!({"index": index}),
                })
                .collect(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };

        let saves = store.save_count();
        poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();

        assert_eq!(
            store.save_count() - saves,
            1,
            "a batch of {size} events must commit with one save"
        );
        assert_eq!(executor.acknowledgements, vec![size]);
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(reloaded.outbox, state.outbox);
        assert_eq!(reloaded.highest_source_seq(), size as u64);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn streamed_rounds_save_once_when_the_ack_rides_the_next_batch() {
    // One event per poll, each ACKed before the next poll, as in a
    // streamed turn over the connected loop.
    const ROUNDS: u64 = 20;
    for (persistence, expected_saves) in [
        (CumulativeAckPersistence::riding_next_save(), ROUNDS),
        (CumulativeAckPersistence::default(), 2 * ROUNDS),
    ] {
        let mut persistence = persistence;
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-streamed-rounds-{}",
            uuid::Uuid::new_v4()
        ));
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::new(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        let saves = store.save_count();
        for round in 1..=ROUNDS {
            executor.events.push_back(PolledEvent {
                executor_event_id: format!("streamed-{round}"),
                event_type: "item.delta".to_owned(),
                priority: EventPriority::P2,
                payload: json!({"index": round}),
            });
            poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();
            persistence.apply(&mut state, &store, round, 2).unwrap();
        }
        assert_eq!((store.save_count() - saves) as u64, expected_saves);

        let (mut reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(reloaded.highest_source_seq(), ROUNDS);
        if persistence.empty_outbox_rides_next_save {
            // The last ACK waits for the next save. Recovery replays that
            // event under its original identity, and the controller's
            // same cumulative ACK removes it again.
            assert_eq!(reloaded.acked_source_seq, ROUNDS - 1);
            assert_eq!(reloaded.outbox.len(), 1);
            assert_eq!(reloaded.outbox[0].source_seq, ROUNDS);
            assert!(reloaded
                .has_executor_event_receipt(
                    &format!("streamed-{ROUNDS}"),
                    "item.delta",
                    EventPriority::P2,
                    &json!({"index": ROUNDS}),
                )
                .unwrap());
            reloaded.apply_ack(ROUNDS, 2).unwrap();
            assert!(reloaded.outbox.is_empty());
        } else {
            assert_eq!(reloaded.acked_source_seq, ROUNDS);
            assert!(reloaded.outbox.is_empty());
        }
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn leaving_backpressure_saves_the_emptying_ack_at_once() {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-backpressure-ack-{}",
        uuid::Uuid::new_v4()
    ));
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).unwrap();
    let (mut state, _) = store.load_or_create(&config).unwrap();
    state
        .enqueue_event(
            &config,
            "provider.notice.recorded",
            EventPriority::P1,
            json!({}),
        )
        .unwrap();
    state.backpressure = true;
    state.lifecycle = "backpressure".to_owned();
    store.save(&state).unwrap();

    CumulativeAckPersistence::riding_next_save()
        .apply(&mut state, &store, 1, 2)
        .unwrap();

    let (reloaded, _) = store.load_or_create(&config).unwrap();
    assert_eq!(reloaded.acked_source_seq, 1);
    assert!(!reloaded.backpressure);
    assert_eq!(reloaded.lifecycle, "ready");
    fs::remove_dir_all(directory).unwrap();
}

#[test]
#[cfg(unix)]
fn host_park_saves_the_ack_that_was_riding_the_next_save() {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    struct ParkableExecutor;
    impl CommandExecutor for ParkableExecutor {
        fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
            panic!("private control cannot execute PRP commands");
        }
        fn host_park_ready(&mut self) -> Result<bool, DurableRunnerError> {
            Ok(true)
        }
    }
    let directory =
        std::env::temp_dir().join(format!("paperclip-host-park-ack-{}", uuid::Uuid::new_v4()));
    let config = config(directory.clone());
    let store = DurableStateStore::new(&config.state_dir).unwrap();
    let (mut state, _) = store.load_or_create(&config).unwrap();
    state
        .enqueue_event(
            &config,
            "provider.notice.recorded",
            EventPriority::P1,
            json!({}),
        )
        .unwrap();
    store.save(&state).unwrap();
    CumulativeAckPersistence::riding_next_save()
        .apply(&mut state, &store, 1, 2)
        .unwrap();
    assert_eq!(store.durable_acked_source_seq(), Some(0));

    let (socket, mut host) = UnixStream::pair().unwrap();
    let mut reader = BufReader::new(host.try_clone().unwrap());
    let mut control = HostedRunnerControl::new(HostControl::new(socket).unwrap());
    let park = json!({"op":"park","id":"park-1","identity":{
        "runnerInstanceId":state.runner_instance_id,"environmentLeaseId":state.environment_lease_id,
        "runId":state.run_id,"normalizedSessionId":state.normalized_session_id,"turnId":state.turn_id,"itemId":state.item_id,
    },"lastControllerCommandSeq":0,"ackedSourceSeq":1});
    writeln!(host, "{park}").unwrap();
    let action = process_host_control(
        &mut control,
        &mut state,
        &store,
        &mut ParkableExecutor,
        false,
        Some(Duration::from_secs(1)),
    )
    .unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(matches!(action, HostAction::Park));
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["status"],
        "parked"
    );

    // A Runner relaunched from disk sees the exact cut it reported.
    let (reloaded, _) = DurableStateStore::new(&config.state_dir)
        .unwrap()
        .load_or_create(&config)
        .unwrap();
    assert_eq!(reloaded.acked_source_seq, 1);
    assert!(reloaded.outbox.is_empty());
    assert!(host_park_checkpoint_is_settled(&reloaded));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_deferred_ack_is_saved_when_no_other_save_carries_it() {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-deferred-ack-{}",
        uuid::Uuid::new_v4()
    ));
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).unwrap();
    let (mut state, _) = store.load_or_create(&config).unwrap();
    for _ in 0..2 {
        state
            .enqueue_event(
                &config,
                "provider.notice.recorded",
                EventPriority::P1,
                json!({}),
            )
            .unwrap();
    }
    store.save(&state).unwrap();
    let mut persistence = CumulativeAckPersistence::riding_next_save();

    // Another save carries the deferred cursor: no save of its own follows.
    persistence.apply(&mut state, &store, 1, 2).unwrap();
    assert!(persistence.deferred_since.is_none());
    persistence.apply(&mut state, &store, 2, 2).unwrap();
    let deferred_since = persistence.deferred_since.unwrap();
    assert_eq!(store.durable_acked_source_seq(), Some(0));
    // For example, the save of the next provider batch.
    store.save(&state).unwrap();
    let saves = store.save_count();
    persistence
        .save_deferred_ack(&state, &store, deferred_since + DEFERRED_ACK_SAVE_DELAY)
        .unwrap();
    assert_eq!(store.save_count(), saves);
    assert!(persistence.deferred_since.is_none());

    // Nothing carries it: the cursor waits for the delay, then is saved.
    state
        .enqueue_event(
            &config,
            "provider.notice.recorded",
            EventPriority::P1,
            json!({}),
        )
        .unwrap();
    store.save(&state).unwrap();
    persistence.apply(&mut state, &store, 3, 2).unwrap();
    let deferred_since = persistence.deferred_since.unwrap();
    persistence
        .save_deferred_ack(&state, &store, deferred_since)
        .unwrap();
    assert_eq!(store.durable_acked_source_seq(), Some(2));
    persistence
        .save_deferred_ack(&state, &store, deferred_since + DEFERRED_ACK_SAVE_DELAY)
        .unwrap();
    assert_eq!(store.durable_acked_source_seq(), Some(3));
    let (reloaded, _) = store.load_or_create(&config).unwrap();
    assert!(reloaded.outbox.is_empty());
    fs::remove_dir_all(directory).unwrap();
}
