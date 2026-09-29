use std::{fs, path::PathBuf, process::Command};

use paperclip_runner_core::indexed_store::{read_only_receipt, ExactReceipt, IndexedStore};
use rusqlite::{Connection, OpenFlags};

const TEST: &str = "preserves_sqlite_locks_across_same_process_opens_and_external_readers";

#[test]
fn preserves_sqlite_locks_across_same_process_opens_and_external_readers() {
    let role = std::env::var("PAPERCLIP_SQLITE_LOCK_TEST_ROLE").ok();
    let root = std::env::var_os("PAPERCLIP_SQLITE_LOCK_TEST_ROOT").map(PathBuf::from);
    if role.as_deref() == Some("reader") {
        let db = Connection::open_with_flags(
            fs::canonicalize(root.unwrap().join("authority.sqlite")).unwrap(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM current_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        return;
    }
    if role.as_deref() == Some("writer") {
        let root = root.unwrap();
        let path = root.join("authority.sqlite");
        let store = IndexedStore::open(&path, "lock-regression", true).unwrap();
        let mut generation = paperclip_runner_core::indexed_revision::Revision::Absent;
        for sequence in 0..24 {
            generation = store
                .commit(
                    "authority",
                    generation,
                    serde_json::to_vec(
                        &serde_json::json!({"sequence":sequence,"padding":"x".repeat(64 * 1024)}),
                    )
                    .unwrap(),
                    vec![ExactReceipt {
                        namespace: "receipts".into(),
                        key: sequence.to_string(),
                        bytes: sequence.to_string().into_bytes(),
                    }],
                )
                .unwrap();
            // These public paths used to open and close SQLite's database/SHM
            // descriptors outside its VFS, silently cancelling POSIX locks.
            let second = IndexedStore::open(&path, "lock-regression", false).unwrap();
            assert_eq!(
                second.read_state("authority").unwrap().unwrap().generation,
                generation
            );
            drop(second);
            assert_eq!(
                read_only_receipt(&path, "lock-regression", generation, "receipts", "0").unwrap(),
                Some(b"0".to_vec())
            );
            let result = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env("PAPERCLIP_SQLITE_LOCK_TEST_ROLE", "reader")
                .env("PAPERCLIP_SQLITE_LOCK_TEST_ROOT", &root)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "external reader failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        assert_eq!(
            store.read_state("authority").unwrap().unwrap().generation,
            24
        );
        return;
    }
    let root =
        std::env::temp_dir().join(format!("paperclip-sqlite-locks-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    // A regression can SIGBUS on macOS or corrupt state on other systems. Keep
    // it in a child so the test reports the failure instead of losing its suite.
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture"])
        .env("PAPERCLIP_SQLITE_LOCK_TEST_ROLE", "writer")
        .env("PAPERCLIP_SQLITE_LOCK_TEST_ROOT", &root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "writer exited {:?}; retained evidence at {}: {}",
        result.status,
        root.display(),
        String::from_utf8_lossy(&result.stderr)
    );
    fs::remove_dir_all(root).unwrap();
}
