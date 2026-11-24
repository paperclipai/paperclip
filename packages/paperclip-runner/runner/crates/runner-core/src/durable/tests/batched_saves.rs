// Saves per provider batch. Shares the helpers of
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
fn a_streamed_round_saves_its_batch_once_and_its_emptying_ack_once() {
    // Each round polls one batch, then the controller ACKs every event in it.
    for batch in [1_u64, 8] {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-streamed-rounds-{batch}-{}",
            uuid::Uuid::new_v4()
        ));
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::new(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        let mut persistence = CumulativeAckPersistence::default();
        let saves = store.save_count();
        let mut acked = 0;
        for round in 0..10 {
            for index in 0..batch {
                executor.events.push_back(PolledEvent {
                    executor_event_id: format!("streamed-{round}-{index}"),
                    event_type: "item.delta".to_owned(),
                    priority: EventPriority::P2,
                    payload: json!({"round": round, "index": index}),
                });
            }
            poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();
            for _ in 0..batch {
                acked += 1;
                persistence.apply(&mut state, &store, acked, 2).unwrap();
            }
        }
        assert_eq!(store.save_count() - saves, 20, "batch of {batch}");
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(reloaded.acked_source_seq, 10 * batch);
        assert!(reloaded.outbox.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
