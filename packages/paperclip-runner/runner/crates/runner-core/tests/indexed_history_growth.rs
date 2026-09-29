use paperclip_runner_core::indexed_store::{ExactReceipt, IndexedStore};
use std::{fs, path::Path, time::Instant};

fn tree_metrics(path: &Path, depth: usize) -> (u64, u64, u64) {
    assert!(depth <= 2, "partition directory fanout exceeded the bound");
    let root_metadata = fs::symlink_metadata(path).unwrap();
    assert!(root_metadata.is_dir() && !root_metadata.file_type().is_symlink());
    let mut physical = 0u64;
    let mut allocated = 0u64;
    let mut largest_file = 0u64;
    // Iterate entries as a stream: routing history is a bounded-depth hash
    // fanout, so qualification does not materialize the file list in memory.
    for entry in fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(!kind.is_symlink(), "partition tree contains a symlink");
        if kind.is_dir() {
            let (child_physical, child_allocated, child_largest) =
                tree_metrics(&entry.path(), depth + 1);
            physical += child_physical;
            allocated += child_allocated;
            largest_file = largest_file.max(child_largest);
            continue;
        }
        assert!(kind.is_file(), "partition entry is not a regular file");
        let metadata = fs::symlink_metadata(entry.path()).unwrap();
        assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        physical += metadata.len();
        largest_file = largest_file.max(metadata.len());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            allocated += metadata.blocks() * 512;
        }
        #[cfg(not(unix))]
        {
            allocated += metadata.len();
        }
    }
    (physical, allocated, largest_file)
}

#[test]
#[ignore = "explicit 10 GiB storage qualification; requires local disk space"]
fn ten_gib_history_keeps_resume_and_ancient_replay_indexed() {
    let root =
        std::env::temp_dir().join(format!("paperclip-history-growth-{}", uuid::Uuid::new_v4()));
    let path = root.join("state.sqlite");
    let mut store = IndexedStore::open(&path, "growth-qualification", true).unwrap();
    let mut payload = vec![0u8; 64 * 1024];
    let mut random = 0x12345678u32;
    for byte in &mut payload {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        *byte = random as u8;
    }
    let current = b"bounded-current-state";
    let mut generation = paperclip_runner_core::indexed_revision::Revision::Absent;
    let mut written = 0u64;
    let started = Instant::now();
    let gib = std::env::var("PAPERCLIP_HISTORY_QUALIFICATION_GIB")
        .unwrap_or_else(|_| "10".into())
        .parse::<u64>()
        .unwrap();
    assert!(
        [10, 100].contains(&gib),
        "qualification size must be 10 or 100 GiB"
    );
    let mut targets = vec![
        16 * 1024 * 1024u64,
        1024 * 1024 * 1024,
        10 * 1024 * 1024 * 1024,
    ];
    if gib == 100 {
        targets.push(100 * 1024 * 1024 * 1024);
    }
    for target in targets {
        let mut commits = Vec::new();
        while written < target {
            let first = written / payload.len() as u64;
            let receipts = (first..first + 256)
                .map(|id| ExactReceipt {
                    namespace: "history".into(),
                    key: format!("event-{id:020}"),
                    bytes: payload.clone(),
                })
                .collect();
            let now = Instant::now();
            generation = store
                .commit("authority", generation, current.to_vec(), receipts)
                .unwrap();
            commits.push(now.elapsed().as_secs_f64() * 1000.0);
            written += 256 * payload.len() as u64;
        }
        drop(store);
        let now = Instant::now();
        store = IndexedStore::open(&path, "growth-qualification", false).unwrap();
        let restored = store.read_state("authority").unwrap().unwrap();
        let reopen_ms = now.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(restored.bytes, current);
        assert_eq!(restored.generation, generation);
        assert_eq!(
            store
                .receipt("history", "event-00000000000000000000")
                .unwrap()
                .unwrap(),
            payload
        );
        let mut reads = Vec::new();
        for _ in 0..100 {
            let now = Instant::now();
            assert_eq!(
                store.read_state("authority").unwrap().unwrap().bytes,
                current
            );
            reads.push(now.elapsed().as_secs_f64() * 1000.0);
        }
        reads.sort_by(f64::total_cmp);
        commits.sort_by(f64::total_cmp);
        let mut partitions = 0usize;
        let mut largest_logical_partition = 0u64;
        let mut after: Option<String> = None;
        loop {
            let page = store.partitions(after.as_deref(), 128).unwrap();
            if page.is_empty() {
                break;
            }
            partitions += page.len();
            largest_logical_partition = largest_logical_partition.max(
                page.iter()
                    .map(|partition| partition.bytes)
                    .max()
                    .unwrap_or(0),
            );
            after = page.last().map(|partition| partition.lower_key.clone());
            if page.len() < 128 {
                break;
            }
        }
        let root_database_bytes = fs::metadata(&path).unwrap().len();
        let (partition_files_bytes, allocated_partition_bytes, largest_file) =
            tree_metrics(&root.join("state.sqlite.receipts"), 0);
        let (routing_page_files_bytes, allocated_routing_page_bytes, largest_routing_page_file) =
            tree_metrics(&root.join("state.sqlite.routing"), 0);
        if target >= 1024 * 1024 * 1024 {
            assert!(partitions > 1);
            assert!(
                largest_logical_partition < 1024 * 1024 * 1024,
                "partition grew beyond the maintenance envelope"
            );
        }
        println!(
            "history_bytes={written} root_database_bytes={root_database_bytes} receipt_partition_files_bytes={partition_files_bytes} allocated_receipt_partition_bytes={allocated_partition_bytes} receipt_partitions={partitions} largest_receipt_partition_file_bytes={largest_file} routing_page_files_bytes={routing_page_files_bytes} allocated_routing_page_bytes={allocated_routing_page_bytes} largest_routing_page_file_bytes={largest_routing_page_file} largest_logical_partition_bytes={largest_logical_partition} current_bytes={} reopen_ms={reopen_ms:.3} read_p95_ms={:.3} batch_commit_p95_ms={:.3}",
            current.len(),
            reads[94],
            commits[(commits.len() - 1) * 95 / 100]
        );
    }
    drop(store);
    fs::remove_dir_all(root).unwrap();
    println!(
        "qualification_elapsed_seconds={:.3}",
        started.elapsed().as_secs_f64()
    );
}
