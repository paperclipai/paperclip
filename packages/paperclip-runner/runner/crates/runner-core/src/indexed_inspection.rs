//! Read-only current-state inspection for remote recovery. No receipt/history
//! enumeration, owner recovery, SQLite checkpoint, or writable connection.
use crate::indexed_revision::Revision;
use crate::{
    durable::{open_private_regular_file, verify_private_directory, DurableRunnerError},
    indexed_store::{read_state, storage_error},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, DurableRunnerError>;
fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
pub const INSPECTION_CHUNK_BYTES: usize = 192 * 1024;

pub fn inspect(path: &Path) -> Result<Value> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("indexed inspection has no parent"))?;
    verify_private_directory(parent)?;
    let key = match path.file_name().and_then(|name| name.to_str()) {
        Some("runner-state.json") => "runner",
        Some("codex-provider-state.json") => "codex-provider",
        _ => return Err(invalid("unsupported indexed inspection locator")),
    };
    let mut bytes = Vec::new();
    open_private_regular_file(path)
        .map_err(storage_error)?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    if bytes.len() > 4096 {
        return Err(invalid("indexed inspection locator exceeds capacity"));
    }
    let locator: Value = serde_json::from_slice(&bytes).map_err(storage_error)?;
    let schema = if key == "runner" {
        "paperclip.runner.durable.state.indexed.v1"
    } else {
        "paperclip.runner.codex-provider-state.indexed.v1"
    };
    let binding = locator["binding"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
        .ok_or_else(|| invalid("invalid indexed inspection binding"))?;
    if locator["schema"] != schema {
        return Err(invalid("invalid indexed inspection schema"));
    }
    let database = parent
        .canonicalize()
        .map_err(storage_error)?
        .join(path.with_extension("sqlite").file_name().unwrap());
    let _lifetime = crate::indexed_lifetime::StoreLifetime::existing_shared(&database)?;
    for suffix in ["", "-wal", "-shm"] {
        match crate::indexed_store::verify_sqlite_file(&PathBuf::from(format!(
            "{}{suffix}",
            database.display()
        ))) {
            Ok(_) => {}
            Err(e) if !suffix.is_empty() && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(storage_error(e)),
        }
    }
    let db = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(storage_error)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage_error)?;
    db.execute_batch(
        "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; BEGIN;",
    )
    .map_err(storage_error)?;
    let stored: (i64, String) = db
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if ![1, 2].contains(&stored.0) || stored.1 != binding {
        return Err(invalid("indexed inspection binding mismatch"));
    }
    crate::indexed_partitions::validate_backup(&db)?;
    let preparation = match read_state(&db, "legacy-import")? {
        None => Value::Null,
        Some(imported) => {
            if imported.bytes.len() > 16384 {
                return Err(invalid("indexed inspection import exceeds capacity"));
            }
            let progress: Value = serde_json::from_slice(&imported.bytes).map_err(storage_error)?;
            if progress["schema"] != "paperclip.runner.local-import.v1"
                || progress["binding"] != binding
                || !progress["prepared"].is_object()
            {
                return Err(invalid("indexed inspection import is incomplete"));
            }
            progress["prepared"].clone()
        }
    };
    let snapshot = read_state(&db, key)?
        .ok_or_else(|| invalid("indexed inspection current state is missing"))?;
    if snapshot.generation == 0 {
        return Err(invalid("indexed inspection generation is invalid"));
    }
    let digest = Sha256::digest(&snapshot.bytes);
    if stored.0 == 2 {
        let pending: Option<(Revision, Vec<u8>, Vec<u8>)> = db.query_row(
            "SELECT generation,CASE WHEN length(body)<=33554432 THEN body END,CASE WHEN length(digest)=32 THEN digest END FROM receipt_prepare WHERE state_key=?1",
            [key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional().map_err(storage_error)?;
        if pending.is_some_and(|(generation, body, hash)| {
            generation != snapshot.generation || body != snapshot.bytes || hash != digest.as_slice()
        }) {
            return Err(invalid(
                "indexed inspection has conflicting prepared receipts",
            ));
        }
    }
    let mut state: Value = serde_json::from_slice(&snapshot.bytes).map_err(storage_error)?;
    if !state.is_object() {
        return Err(invalid("indexed inspection current state is invalid"));
    }
    if key == "runner" {
        let next = state["nextSourceSeq"]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991);
        let acked = state["ackedSourceSeq"]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991);
        let (Some(next), Some(acked)) = (next, acked) else {
            return Err(invalid("indexed inspection cursor is invalid"));
        };
        if next <= acked {
            return Err(invalid("indexed inspection cursor is invalid"));
        }
        // A proof must preserve pending delivery as a negative fence, without
        // restoring or reading the historical outbox bodies.
        state["outbox"] = if next == acked + 1 {
            json!([])
        } else {
            json!([{ "indexedPending": true }])
        };
    }
    Ok(
        json!({ "state": state, "generation": snapshot.generation.to_string(), "stateDigest": format!("{digest:x}"), "preparation": preparation }),
    )
}

/// Emit one consistent snapshot in bounded wire frames. EOF, a missing footer,
/// or a changed digest cannot be interpreted as an empty/settled authority.
pub fn stream(path: &Path, mut output: impl Write) -> Result<()> {
    let bytes = serde_json::to_vec(&inspect(path)?).map_err(storage_error)?;
    let header = json!({ "schema": "paperclip.indexed-inspection.v1", "byteLength": bytes.len(), "sha256": format!("{:x}", Sha256::digest(&bytes)) });
    serde_json::to_writer(&mut output, &header).map_err(storage_error)?;
    output.write_all(b"\n").map_err(storage_error)?;
    for (index, chunk) in bytes.chunks(INSPECTION_CHUNK_BYTES).enumerate() {
        serde_json::to_writer(
            &mut output,
            &json!({ "index": index, "bytes": STANDARD.encode(chunk) }),
        )
        .map_err(storage_error)?;
        output.write_all(b"\n").map_err(storage_error)?;
    }
    output
        .write_all(b"{\"complete\":true}\n")
        .and_then(|_| output.flush())
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed_store::{ExactReceipt, IndexedStore};
    struct Fixture {
        root: PathBuf,
        path: PathBuf,
        store: IndexedStore,
    }
    impl Fixture {
        fn new(next: u64) -> Self {
            let root =
                std::env::temp_dir().join(format!("paperclip-inspection-{}", uuid::Uuid::new_v4()));
            let store =
                IndexedStore::open(&root.join("runner-state.sqlite"), "inspection", true).unwrap();
            let path = root.join("runner-state.json");
            let mut file = std::fs::OpenOptions::new();
            file.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                file.mode(0o600);
            }
            file.open(&path).unwrap().write_all(br#"{"schema":"paperclip.runner.durable.state.indexed.v1","binding":"inspection"}"#).unwrap();
            store.commit("runner", 0, serde_json::to_vec(&json!({"nextSourceSeq":next,"ackedSourceSeq":1,"lifecycle":"ready","current":"exact"})).unwrap(), vec![ExactReceipt {
                namespace: "old-output".into(), key: "ancient".into(), bytes: vec![b'x'; 2 * 1024 * 1024],
            }]).unwrap();
            Self { root, path, store }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn current_inspection_preserves_pending_delivery_and_does_not_restore_history() {
        for (next, outbox) in [(2, json!([])), (3, json!([{"indexedPending":true}]))] {
            let f = Fixture::new(next);
            let before = f.store.read_state("runner").unwrap().unwrap();
            let observed = inspect(&f.path).unwrap();
            assert_eq!(observed["state"]["outbox"], outbox);
            assert_eq!(observed["generation"], "1");
            assert!(serde_json::to_vec(&observed).unwrap().len() < 1000);
            assert_eq!(f.store.read_state("runner").unwrap().unwrap(), before);
            assert_eq!(
                f.store
                    .receipt("old-output", "ancient")
                    .unwrap()
                    .unwrap()
                    .len(),
                2 * 1024 * 1024
            );
        }
    }
    #[test]
    fn inspection_rejects_conflicting_redo_without_recovering_it() {
        let f = Fixture::new(2);
        let db = Connection::open(f.root.join("runner-state.sqlite")).unwrap();
        // Copy the actual schema's redo columns, changing only the current
        // generation. No side-effect/receipt repair is authorized by inspection.
        db.execute("INSERT INTO receipt_prepare(singleton,state_key,generation,body,digest,records,fingerprint) SELECT 1,key,generation+1,bytes,digest,0,zeroblob(32) FROM current_state WHERE key='runner'", []).unwrap();
        assert!(inspect(&f.path)
            .unwrap_err()
            .to_string()
            .contains("conflicting prepared"));
        assert_eq!(
            db.query_row(
                "SELECT generation FROM current_state WHERE key='runner'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn missing_activated_state_is_not_an_empty_snapshot() {
        let f = Fixture::new(2);
        let db = Connection::open(f.root.join("runner-state.sqlite")).unwrap();
        db.execute("DELETE FROM current_state WHERE key='runner'", [])
            .unwrap();
        assert!(inspect(&f.path)
            .unwrap_err()
            .to_string()
            .contains("current state is missing"));
    }
    #[test]
    fn streams_one_snapshot_in_bounded_ordered_digest_checked_frames() {
        let f = Fixture::new(2);
        f.store.commit("runner", 1, serde_json::to_vec(&json!({"nextSourceSeq":2,"ackedSourceSeq":1,"activeInput":"界".repeat(500_000)})).unwrap(), vec![]).unwrap();
        let mut wire = Vec::new();
        stream(&f.path, &mut wire).unwrap();
        let rows: Vec<_> = wire
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .collect();
        let header: Value = serde_json::from_slice(rows[0]).unwrap();
        let mut snapshot = Vec::new();
        for (index, row) in rows[1..rows.len() - 1].iter().enumerate() {
            assert!(row.len() <= INSPECTION_CHUNK_BYTES * 4 / 3 + 128);
            let chunk: Value = serde_json::from_slice(row).unwrap();
            assert_eq!(chunk["index"], index);
            snapshot.extend(STANDARD.decode(chunk["bytes"].as_str().unwrap()).unwrap());
        }
        assert_eq!(header["byteLength"], snapshot.len());
        assert_eq!(header["sha256"], format!("{:x}", Sha256::digest(&snapshot)));
        assert_eq!(
            serde_json::from_slice::<Value>(rows.last().unwrap()).unwrap(),
            json!({"complete":true})
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&snapshot).unwrap()["generation"],
            "2"
        );
    }
}
