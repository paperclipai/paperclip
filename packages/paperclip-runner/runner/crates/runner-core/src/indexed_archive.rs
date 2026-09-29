//! Bounded cold-epoch transfer. The durable intent fences new connections and
//! a lifetime lock excludes every live runner/maintenance/backup connection.
use crate::durable::{open_private_regular_file, verify_private_directory, DurableRunnerError};
use crate::indexed_lifetime::{archive_fence, StoreLifetime};
use crate::indexed_revision::Revision;
use crate::indexed_store::storage_error;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, DurableRunnerError>;
const LOCATOR: &str = "runner-state.json";
const FILES: [&str; 6] = [
    "runner-state.sqlite",
    "runner-state.sqlite-wal",
    "runner-state.sqlite-shm",
    "runner-state.sqlite.receipts",
    "runner-state.sqlite.routing",
    "runner-state.json",
];
#[derive(Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transfer {
    schema: String,
    generation: String,
    state_sha256: String,
    files: Vec<String>,
}
fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(storage_error(e)),
    }
}
fn sync(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(storage_error)
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let file = open_private_regular_file(path).map_err(storage_error)?;
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    if bytes.len() > 4096 {
        return Err(invalid("native_indexed_archive_oversized"));
    }
    serde_json::from_slice(&bytes).map_err(storage_error)
}
fn publish(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(storage_error)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(value).map_err(storage_error)?)
            .map_err(storage_error)?;
        file.sync_all().map_err(storage_error)?;
        // A conflicting owner cannot replace either a file or a dangling link.
        fs::hard_link(&temporary, path).map_err(storage_error)?;
        sync(path.parent().unwrap())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn verify_file(path: &Path) -> Result<()> {
    if path.file_name().is_some_and(|name| {
        name == "runner-state.sqlite.receipts" || name == "runner-state.sqlite.routing"
    }) {
        verify_private_directory(path)
    } else {
        open_private_regular_file(path)
            .map(|_| ())
            .map_err(storage_error)
    }
}
fn database(directory: &Path) -> Result<Connection> {
    for file in &FILES[..3] {
        let path = directory.join(file);
        if *file == FILES[0] || present(&path)? {
            verify_file(&path)?;
        }
    }
    let db = Connection::open_with_flags(
        directory.join(FILES[0]),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(storage_error)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000;").map_err(storage_error)?;
    Ok(db)
}
fn verify_snapshot(
    directory: &Path,
    generation: &str,
    digest: &str,
    allow_backup: bool,
) -> Result<()> {
    let locator: serde_json::Value = read_json(&directory.join("runner-state.json"))?;
    if locator["schema"] != "paperclip.runner.durable.state.indexed.v1" {
        return Err(invalid("native_indexed_archive_locator_invalid"));
    }
    let db = database(directory)?;
    let binding: (i64, String) = db
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if ![1, 2].contains(&binding.0) || locator["binding"].as_str() != Some(&binding.1) {
        return Err(invalid("native_indexed_archive_binding_changed"));
    }
    let has_routing_tree: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_routing_heads')", [], |r| r.get(0)).map_err(storage_error)?;
    if has_routing_tree {
        verify_private_directory(&directory.join("runner-state.sqlite.routing"))?;
    }
    crate::indexed_partitions::validate_backup(&db)?;
    if !allow_backup
        && db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_backup'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage_error)?
            .is_some()
        && db
            .query_row("SELECT 1 FROM receipt_backup LIMIT 1", [], |_| Ok(()))
            .optional()
            .map_err(storage_error)?
            .is_some()
    {
        return Err(invalid(
            "storage_pressure: finish the indexed backup before archiving its source",
        ));
    }
    let (stored_generation, bytes, stored_digest): (Revision, Vec<u8>, Vec<u8>) = db.query_row("SELECT generation,CASE WHEN length(bytes)<=33554432 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM current_state WHERE key='runner'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage_error)?;
    let actual = Sha256::digest(&bytes);
    let actual_hex: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    if stored_generation.to_string() != generation
        || stored_digest != actual.as_slice()
        || actual_hex != digest
    {
        return Err(invalid("native_indexed_archive_changed"));
    }
    let state: serde_json::Value = serde_json::from_slice(&bytes).map_err(storage_error)?;
    if state["lifecycle"] != "suspended" {
        return Err(invalid("native_indexed_archive_unsettled"));
    }
    Ok(())
}
fn transfer(archive: &Path) -> Result<Option<Transfer>> {
    let path = archive.join("runner-transfer.json");
    if !present(&path)? {
        return Ok(None);
    }
    let value: Transfer = read_json(&path)?;
    if value.schema != "paperclip.runner.indexed-archive.v1"
        || value
            .generation
            .parse::<Revision>()
            .ok()
            .filter(|n| *n != Revision::Absent)
            .map(|n| n.to_string())
            .as_ref()
            != Some(&value.generation)
        || value.state_sha256.len() != 64
        || !value
            .state_sha256
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        || !value.files.iter().any(|f| f == FILES[0])
        || !value.files.iter().any(|f| f == LOCATOR)
        || value.files.len() > FILES.len()
        || value
            .files
            .iter()
            .enumerate()
            .any(|(i, f)| !FILES.contains(&f.as_str()) || value.files[..i].contains(f))
    {
        return Err(invalid("native_indexed_archive_invalid"));
    }
    Ok(Some(value))
}
fn fence(runner: &Path, archive: &Path) -> Result<PathBuf> {
    let path = archive_fence(&runner.join(FILES[0]));
    let value = serde_json::json!({"schema":"paperclip.runner.archive-fence.v1","archive":archive});
    if present(&path)? {
        if read_json::<serde_json::Value>(&path)? != value {
            return Err(invalid("native_indexed_archive_conflict"));
        }
    } else {
        publish(&path, &value)?;
    }
    Ok(path)
}

/// Caller has already proven process-tree death and controller ownership. This
/// independently excludes storage operators and checks the exact current row.
pub fn prepare(runner: &Path, archive: &Path, generation: &str, digest: &str) -> Result<()> {
    verify_private_directory(runner)?;
    verify_private_directory(archive)?;
    let runner = runner.canonicalize().map_err(storage_error)?;
    let archive = archive.canonicalize().map_err(storage_error)?;
    let _lifetime = StoreLifetime::exclusive(&runner.join(FILES[0]))?;
    let _operation = crate::indexed_partitions::PartitionLock::acquire(&runner.join(FILES[0]))?;
    verify_snapshot(&runner, generation, digest, false)?;
    let mut files = Vec::new();
    for name in FILES {
        let path = runner.join(name);
        if present(&path)? {
            verify_file(&path)?;
            files.push(name.to_owned());
        }
    }
    let intent = Transfer {
        schema: "paperclip.runner.indexed-archive.v1".into(),
        generation: generation.into(),
        state_sha256: digest.into(),
        files,
    };
    if let Some(existing) = transfer(&archive)? {
        if existing != intent {
            return Err(invalid("native_indexed_archive_changed"));
        }
    } else {
        publish(&archive.join("runner-transfer.json"), &intent)?;
    }
    fence(&runner, &archive)?;
    Ok(())
}
fn rename_new(source: &Path, target: &Path) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            source,
            rustix::fs::CWD,
            target,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(storage_error)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    {
        let _ = (source, target);
        Err(invalid("indexed archive is unqualified on this platform"))
    }
}
pub fn finish(runner: &Path, archive: &Path) -> Result<bool> {
    verify_private_directory(runner)?;
    verify_private_directory(archive)?;
    let runner = runner.canonicalize().map_err(storage_error)?;
    let archive = archive.canonicalize().map_err(storage_error)?;
    let Some(intent) = transfer(&archive)? else {
        return Ok(false);
    };
    if !present(&archive.join("control-plane"))? {
        return Err(invalid("native_indexed_archive_controller_missing"));
    }
    verify_private_directory(&archive.join("control-plane"))?;
    let _source_lifetime = StoreLifetime::exclusive(&runner.join(FILES[0]))?;
    let _target_lifetime = StoreLifetime::exclusive(&archive.join(FILES[0]))?;
    let _operation = crate::indexed_partitions::PartitionLock::acquire(&runner.join(FILES[0]))?;
    let published = present(&archive.join(LOCATOR))?;
    if published {
        for name in &intent.files {
            if present(&runner.join(name))? {
                return Err(invalid("native_indexed_archive_conflict"));
            }
        }
    }
    let marker = fence(&runner, &archive)?;
    if !published {
        for name in FILES
            .into_iter()
            .filter(|name| intent.files.iter().any(|f| f == name))
        {
            let source = runner.join(name);
            let target = archive.join(name);
            if present(&source)? {
                verify_file(&source)?;
                rename_new(&source, &target)?;
                sync(&runner)?;
                sync(&archive)?;
            } else {
                verify_file(&target)?;
            }
        }
    }
    verify_snapshot(&archive, &intent.generation, &intent.state_sha256, false)?;
    fs::remove_file(marker).map_err(storage_error)?;
    sync(&runner)?;
    Ok(true)
}

/// Transfer a standalone controller while excluding its storage subprocess and
/// online backup. The directory rename is atomic; a retry observes the archived
/// locator. PostgreSQL locators have no local database and are moved by the host.
pub fn controller(source: &Path, target: &Path, expected_digest: &str) -> Result<()> {
    verify_private_directory(source)?;
    verify_private_directory(
        source
            .parent()
            .ok_or_else(|| invalid("controller parent missing"))?,
    )?;
    verify_private_directory(
        target
            .parent()
            .ok_or_else(|| invalid("archive parent missing"))?,
    )?;
    let source = source.canonicalize().map_err(storage_error)?;
    let target = target
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(storage_error)?
        .join(
            target
                .file_name()
                .ok_or_else(|| invalid("archive filename missing"))?,
        );
    let locator: serde_json::Value = read_json(&source.join("control-plane-state.json"))?;
    let file = locator["location"]["file"]
        .as_str()
        .ok_or_else(|| invalid("controller locator missing"))?;
    if locator["schema"] != "paperclip.runner.authority-locator.v1"
        || locator["location"]["kind"] != "sqlite"
        || !file.ends_with(".sqlite")
        || file.is_empty()
        || !file
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
    {
        return Err(invalid("controller archive locator invalid"));
    }
    let path = source.join(file);
    let _lifetime = StoreLifetime::exclusive(&path)?;
    let _operation = crate::indexed_partitions::PartitionLock::acquire(&path)?;
    for suffix in ["", "-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{suffix}", path.display()));
        if suffix.is_empty() || present(&sidecar)? {
            crate::indexed_store::verify_sqlite_file(&sidecar).map_err(storage_error)?;
        }
    }
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(storage_error)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096;")
        .map_err(storage_error)?;
    let native = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_binding'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(storage_error)?
        .is_some();
    let (binding, bytes, digest): (String, Vec<u8>, Vec<u8>) = if native {
        crate::indexed_partitions::validate_backup(&db)?;
        if db
            .query_row("SELECT 1 FROM receipt_backup LIMIT 1", [], |_| Ok(()))
            .optional()
            .map_err(storage_error)?
            .is_some()
        {
            return Err(invalid(
                "storage_pressure: finish the controller backup before archiving",
            ));
        }
        db.query_row("SELECT binding,CASE WHEN length(bytes)<=16777216 THEN bytes END,digest FROM store_binding,current_state WHERE singleton=1 AND key='authority'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage_error)?
    } else {
        let (binding,body,digest):(String,String,String)=db.query_row("SELECT binding,CASE WHEN length(body)<=16777216 THEN body END,digest FROM authority_binding,authority_state WHERE authority_binding.singleton=1 AND authority_state.singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage_error)?;
        let actual = format!("{:x}", Sha256::digest(body.as_bytes()));
        if digest != actual {
            return Err(invalid("controller archive digest mismatch"));
        }
        (
            binding,
            body.as_bytes().to_vec(),
            Sha256::digest(body.as_bytes()).to_vec(),
        )
    };
    if locator["location"]["binding"].as_str() != Some(&binding)
        || Sha256::digest(&bytes).as_slice() != digest
        || format!("{:x}", Sha256::digest(&bytes)) != expected_digest
    {
        return Err(invalid("controller archive authority changed"));
    }
    drop(db);
    rename_new(&source, &target)?;
    sync(source.parent().unwrap())?;
    sync(target.parent().unwrap())
}

/// The server proves process-tree death; this fence also excludes operator
/// connections and file transfer while sealing the exact empty checkpoint.
pub fn seal(runner: &Path, expected_generation: &str) -> Result<()> {
    verify_private_directory(runner)?;
    let runner = runner.canonicalize().map_err(storage_error)?;
    crate::legacy_indexed_import::require_active_directory(&runner)?;
    let path = runner.join(FILES[0]);
    let _lifetime = StoreLifetime::exclusive(&path)?;
    if present(&archive_fence(&path))? {
        return Err(invalid(
            "storage_pressure: indexed archive must finish before sealing",
        ));
    }
    let _operation = crate::indexed_partitions::PartitionLock::acquire(&path)?;
    let locator: serde_json::Value = read_json(&runner.join(LOCATOR))?;
    if locator["schema"] != "paperclip.runner.durable.state.indexed.v1" {
        return Err(invalid("indexed_state_locator_invalid"));
    }
    for name in &FILES[..3] {
        let file = runner.join(name);
        if *name == FILES[0] || present(&file)? {
            verify_file(&file)?;
        }
    }
    let mut db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(storage_error)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000;").map_err(storage_error)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let binding: (i64, String) = tx
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if ![1, 2].contains(&binding.0) || locator["binding"].as_str() != Some(&binding.1) {
        return Err(invalid("indexed_state_binding_mismatch"));
    }
    crate::indexed_partitions::validate_backup(&tx)
        .map_err(|_| invalid("indexed_state_backup_incomplete"))?;
    let (generation,bytes,digest):(Revision,Vec<u8>,Vec<u8>)=tx.query_row("SELECT generation,CASE WHEN length(bytes)<=33554432 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM current_state WHERE key='runner'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage_error)?;
    if Sha256::digest(&bytes).as_slice() != digest {
        return Err(invalid("indexed_state_digest_mismatch"));
    }
    let mut state: serde_json::Value = serde_json::from_slice(&bytes).map_err(storage_error)?;
    let next = state["nextSourceSeq"].as_u64();
    let acked = state["ackedSourceSeq"].as_u64();
    if generation.to_string() != expected_generation
        || generation == Revision::Absent
        || ![Some("ready"), Some("suspended")].contains(&state["lifecycle"].as_str())
        || next.is_none()
        || next.unwrap() > 9_007_199_254_740_991
        || acked.and_then(|n| n.checked_add(1)) != next
        || !state["pendingTerminalDelivery"].is_null()
        || !state["pendingProviderCleanup"].is_null()
    {
        return Err(invalid("indexed_state_seal_stale_or_unsettled"));
    }
    if binding.0 == 2 {
        let pending:Option<(Revision,Vec<u8>,Vec<u8>)>=tx.query_row("SELECT generation,CASE WHEN length(body)<=33554432 THEN body END,digest FROM receipt_prepare WHERE state_key='runner'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage_error)?;
        if pending.is_some_and(|row| row != (generation, bytes.clone(), digest.clone())) {
            return Err(invalid("indexed_state_prepared_commit_mismatch"));
        }
    }
    state["lifecycle"] = serde_json::json!("suspended");
    let body = serde_json::to_vec(&state).map_err(storage_error)?;
    if body.len() > 33_554_432 {
        return Err(invalid("indexed_state_snapshot_invalid"));
    }
    let digest = Sha256::digest(&body).to_vec();
    let next_revision = generation.next()?;
    tx.execute(
        "UPDATE current_state SET bytes=?1,digest=?2,generation=?3 WHERE key='runner'",
        rusqlite::params![body, digest, next_revision],
    )
    .map_err(storage_error)?;
    if binding.0 == 2 {
        tx.execute(
            "UPDATE receipt_prepare SET body=?1,digest=?2,generation=?3 WHERE state_key='runner'",
            rusqlite::params![body, digest, next_revision],
        )
        .map_err(storage_error)?;
    }
    tx.commit().map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed_store::IndexedStore;
    #[test]
    fn pending_session_migration_fences_sealing_before_storage_is_opened() {
        let root =
            std::env::temp_dir().join(format!("indexed-seal-migration-{}", uuid::Uuid::new_v4()));
        let runner = root.join("runner");
        fs::create_dir_all(&runner).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&root, &runner] {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        publish(
            &root.join("indexed-migration.json"),
            &serde_json::json!({
                "schema": "paperclip.runner.legacy-activation.v1", "phase": "activating"
            }),
        )
        .unwrap();
        assert!(seal(&runner, "1")
            .unwrap_err()
            .to_string()
            .contains("migration is pending"));
        assert_eq!(fs::read_dir(&runner).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn active_connections_and_interrupted_backups_block_archive_without_moving_history() {
        for opaque in [false, true] {
            let root =
                std::env::temp_dir().join(format!("indexed-archive-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let archive = root.join("archive");
            fs::create_dir(&archive).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&archive, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let mut store = IndexedStore::open(&root.join(FILES[0]), "runner/test", true).unwrap();
            let bytes = br#"{"lifecycle":"suspended"}"#;
            let mut generation = store
                .commit("runner", 0, bytes.to_vec(), vec![])
                .unwrap()
                .to_string();
            if opaque {
                drop(store);
                let db = Connection::open(root.join(FILES[0])).unwrap();
                db.execute(
                    "UPDATE current_state SET generation=?1 WHERE key='runner'",
                    [i64::MAX],
                )
                .unwrap();
                drop(db);
                store = IndexedStore::open(&root.join(FILES[0]), "runner/test", false).unwrap();
                generation = store
                    .commit("runner", i64::MAX as u64, bytes.to_vec(), vec![])
                    .unwrap()
                    .to_string();
                assert!(generation.starts_with("r:"));
            }
            publish(&root.join(LOCATOR),&serde_json::json!({"schema":"paperclip.runner.durable.state.indexed.v1","binding":"runner/test"})).unwrap();
            let digest: String = Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert!(prepare(&root, &archive, &generation, &digest)
                .unwrap_err()
                .to_string()
                .contains("open connection"));
            store.begin_backup(&root.join("backup")).unwrap();
            drop(store);
            assert!(prepare(&root, &archive, &generation, &digest)
                .unwrap_err()
                .to_string()
                .contains("finish the indexed backup"));
            let store = IndexedStore::open(&root.join(FILES[0]), "runner/test", false).unwrap();
            while !store.backup_step().unwrap() {}
            drop(store);
            prepare(&root, &archive, &generation, &digest).unwrap();
            assert!(
                IndexedStore::open(&root.join(FILES[0]), "runner/test", false)
                    .unwrap_err()
                    .to_string()
                    .contains("archive must finish")
            );
            assert!(!archive.join(FILES[0]).exists());
            fs::create_dir(archive.join("control-plane")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    archive.join("control-plane"),
                    fs::Permissions::from_mode(0o700),
                )
                .unwrap();
            }
            // A crash between root and companion/locator movement rolls forward.
            rename_new(&root.join(FILES[0]), &archive.join(FILES[0])).unwrap();
            assert!(finish(&root, &archive).unwrap());
            assert!(finish(&root, &archive).unwrap());
            let archived =
                IndexedStore::open(&archive.join(FILES[0]), "runner/test", false).unwrap();
            assert_eq!(archived.read_state("runner").unwrap().unwrap().bytes, bytes);
            drop(archived);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
