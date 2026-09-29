use paperclip_runner_core::indexed_store::{ExactReceipt, IndexedStore};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn sigkill_during_native_snapshot_resumes_exact_receipts_and_restores_without_source() {
    let root =
        std::env::temp_dir().join(format!("paperclip-snapshot-crash-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let source = root.join("source");
    let destination = root.join("snapshot");
    let names = ["runner-state", "codex-provider-state"];
    let bindings = ["runner/r/s", "provider/r/s"];
    let keys = ["runner", "codex-provider"];
    let mut hashes = vec![];
    for i in 0..2 {
        let store = IndexedStore::open(
            &source.join(format!("{}.sqlite", names[i])),
            bindings[i],
            true,
        )
        .unwrap();
        let locator = json!({"schema":if i==0 {"paperclip.runner.durable.state.indexed.v1"} else {"paperclip.runner.codex-provider-state.indexed.v1"},"binding":bindings[i]});
        let file = source.join(format!("{}.json", names[i]));
        fs::write(&file, serde_json::to_vec(&locator).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let state = if i == 0 {
            json!({"lifecycle":"suspended","runnerInstanceId":"r","normalizedSessionId":"s","nextSourceSeq":2,"ackedSourceSeq":1})
        } else {
            json!({"lifecycle":"ready","pendingEvents":[],"queuedEvents":[]})
        };
        let bytes = serde_json::to_vec(&state).unwrap();
        hashes.push(format!("{:x}", Sha256::digest(&bytes)));
        store
            .commit(
                keys[i],
                0,
                bytes,
                (0..2000)
                    .map(|n| ExactReceipt {
                        namespace: "ancient".into(),
                        key: format!("{n:08}"),
                        bytes: vec![(n % 251) as u8; 16 * 1024],
                    })
                    .collect(),
            )
            .unwrap();
    }
    let args = vec![
        "storage".to_owned(),
        "snapshot-session".into(),
        "--directory".into(),
        source.to_string_lossy().into_owned(),
        "--destination".into(),
        destination.to_string_lossy().into_owned(),
        "--runner-generation".into(),
        "1".into(),
        "--runner-sha256".into(),
        hashes[0].clone(),
        "--provider-generation".into(),
        "1".into(),
        "--provider-sha256".into(),
        hashes[1].clone(),
    ];
    let mut child = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"))
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut copied = false;
    while Instant::now() < deadline {
        let db = Connection::open_with_flags(
            source.join("runner-state.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let staging = db.query_row(
            "SELECT staging FROM receipt_backup WHERE phase='copying'",
            [],
            |row| row.get::<_, String>(0),
        );
        if let Ok(staging) = staging {
            if let Ok(target) = Connection::open_with_flags(
                PathBuf::from(staging).join("runner-state.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            ) {
                copied = target
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM backup_copy WHERE cursor>0)",
                        [],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false);
            }
        }
        if copied {
            break;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("snapshot exited before crash boundary: {status}");
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    // Kill only the exact child owned by this test, and reap it before reopening.
    child.kill().unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success());
    assert!(copied, "no durable partial copy observed");
    assert!(
        !destination.exists(),
        "partial snapshot must not be published"
    );
    let resumed = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"))
        .args(&args)
        .output()
        .unwrap();
    assert!(
        resumed.status.success(),
        "{}",
        String::from_utf8_lossy(&resumed.stderr)
    );
    fs::remove_dir_all(&source).unwrap();
    for i in 0..2 {
        let restored = IndexedStore::open(
            &destination.join(format!("{}.sqlite", names[i])),
            bindings[i],
            false,
        )
        .unwrap();
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(restored.read_state(keys[i]).unwrap().unwrap().bytes)
            ),
            hashes[i]
        );
        for n in [0, 127, 1024, 1999] {
            assert_eq!(
                restored.receipt("ancient", &format!("{n:08}")).unwrap(),
                Some(vec![(n % 251) as u8; 16 * 1024])
            );
        }
    }
    fs::remove_dir_all(root).unwrap();
}
