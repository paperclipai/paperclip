//! A resumable, exact two-store snapshot at an admitted quiet boundary. The
//! controller must separately fence its authority and provider checkpoint. This
//! operation does not infer process-tree death or authorize a restored session.
use crate::{
    durable::{open_private_regular_file, verify_private_directory, DurableRunnerError},
    indexed_store::{storage_error, IndexedStore},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, DurableRunnerError>;
const MANIFEST: &str = "indexed-session-snapshot.json";
const NAMES: [&str; 2] = ["runner-state", "codex-provider-state"];
const KEYS: [&str; 2] = ["runner", "codex-provider"];
const SCHEMAS: [&str; 2] = [
    "paperclip.runner.durable.state.indexed.v1",
    "paperclip.runner.codex-provider-state.indexed.v1",
];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedState {
    pub generation: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    schema: String,
    source: PathBuf,
    states: [ExpectedState; 2],
    locators: [String; 2],
}
fn invalid(s: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(s)
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(storage_error(e)),
    }
}
fn read(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_private_regular_file(path)
        .map_err(storage_error)?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(storage_error)?;
    if bytes.len() > 16384 {
        return Err(invalid("snapshot metadata exceeds capacity"));
    }
    Ok(bytes)
}
fn sync(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(storage_error)
}
fn directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(storage_error)?;
    sync(path.parent().unwrap())
}
fn publish_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if present(path)? {
        if read(path)? != bytes {
            return Err(invalid("snapshot metadata changed"));
        }
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(storage_error)?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(storage_error)?;
        fs::hard_link(&temporary, path).map_err(storage_error)?;
        sync(path.parent().unwrap())
    })();
    let _ = fs::remove_file(temporary);
    result
}
fn move_once(source: &Path, destination: &Path) -> Result<()> {
    if present(destination)? {
        if present(source)? {
            return Err(invalid("snapshot move destination conflicts"));
        }
        return Ok(());
    }
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(storage_error)?;
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    return Err(invalid(
        "snapshot publication is unqualified on this platform",
    ));
    sync(destination.parent().unwrap())?;
    sync(source.parent().unwrap())
}
fn binding(locator: &str, index: usize) -> Result<String> {
    let value: Value = serde_json::from_str(locator).map_err(storage_error)?;
    if locator.len() > 4096 || value["schema"] != SCHEMAS[index] {
        return Err(invalid("snapshot locator is invalid"));
    }
    value["binding"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| invalid("snapshot binding is invalid"))
}
fn verify(store: &IndexedStore, index: usize, expected: &ExpectedState) -> Result<Value> {
    let snapshot = store
        .read_state(KEYS[index])?
        .ok_or_else(|| invalid("snapshot current state is missing"))?;
    if snapshot.generation.to_string() != expected.generation
        || format!("{:x}", Sha256::digest(&snapshot.bytes)) != expected.sha256
    {
        return Err(invalid("snapshot current state changed"));
    }
    serde_json::from_slice(&snapshot.bytes).map_err(storage_error)
}
fn verify_backup(directory: &Path, index: usize, snapshot: &Snapshot) -> Result<()> {
    verify_private_directory(directory)?;
    let path = directory.join(format!("{}.sqlite", NAMES[index]));
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        if suffix.is_empty() || present(&file)? {
            crate::indexed_store::verify_sqlite_file(&file).map_err(storage_error)?;
        }
    }
    let db = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(storage_error)?;
    db.execute_batch(
        "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; BEGIN",
    )
    .map_err(storage_error)?;
    let stored: (i64, String) = db
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if stored != (2, binding(&snapshot.locators[index], index)?) {
        return Err(invalid("snapshot database binding differs"));
    }
    let complete: i64 = db
        .query_row(
            "SELECT complete FROM backup_manifest WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if complete != 1 {
        return Err(invalid("snapshot backup is incomplete"));
    }
    crate::indexed_partitions::verify_backup_receipts(&db)?;
    let state = crate::indexed_store::read_state(&db, KEYS[index])?
        .ok_or_else(|| invalid("snapshot current state missing"))?;
    if state.generation.to_string() != snapshot.states[index].generation
        || format!("{:x}", Sha256::digest(&state.bytes)) != snapshot.states[index].sha256
    {
        return Err(invalid("snapshot current state changed"));
    }
    Ok(())
}
fn verify_completed(directory: &Path, snapshot: &Snapshot) -> Result<()> {
    verify_private_directory(directory)?;
    let _lifetimes = [
        crate::indexed_lifetime::StoreLifetime::existing_exclusive(
            &directory.join("runner-state.sqlite"),
        )?,
        crate::indexed_lifetime::StoreLifetime::existing_exclusive(
            &directory.join("codex-provider-state.sqlite"),
        )?,
    ];
    if read(&directory.join(MANIFEST))? != serde_json::to_vec(snapshot).map_err(storage_error)? {
        return Err(invalid("snapshot publication conflicts"));
    }
    for i in 0..2 {
        if read(&directory.join(format!("{}.json", NAMES[i])))? != snapshot.locators[i].as_bytes() {
            return Err(invalid("snapshot locator changed"));
        }
        verify_backup(directory, i, snapshot)?;
    }
    Ok(())
}
/// The expected generations and hashes are supplied by current-state admission,
/// never reconstructed from history. Both lifetime fences stay owned throughout
/// the copy. No new provider/runner writer may enter between the two snapshots.
pub fn snapshot_session(
    source: &Path,
    destination: &Path,
    states: [ExpectedState; 2],
) -> Result<Value> {
    snapshot_with_hook(source, destination, states, |_| Ok(()))
}
fn snapshot_with_hook(
    source: &Path,
    destination: &Path,
    states: [ExpectedState; 2],
    hook: impl Fn(&str) -> Result<()>,
) -> Result<Value> {
    verify_private_directory(source)?;
    let requested_destination = destination.to_owned();
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("snapshot has no parent"))?;
    verify_private_directory(parent)?;
    let source = source.canonicalize().map_err(storage_error)?;
    let destination = parent.canonicalize().map_err(storage_error)?.join(
        destination
            .file_name()
            .ok_or_else(|| invalid("snapshot has no filename"))?,
    );
    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(invalid("snapshot overlaps its source"));
    }
    for state in &states {
        if state
            .generation
            .parse::<crate::indexed_revision::Revision>()
            .ok()
            .filter(|n| *n != crate::indexed_revision::Revision::Absent)
            .map(|n| n.to_string())
            .as_ref()
            != Some(&state.generation)
            || state.sha256.len() != 64
            || !state
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("snapshot expectation is invalid"));
        }
    }
    let snapshot = Snapshot {
        schema: "paperclip.runner.indexed-session-snapshot.v1".into(),
        source: source.clone(),
        states,
        locators: [
            String::from_utf8(read(&source.join("runner-state.json"))?).map_err(storage_error)?,
            String::from_utf8(read(&source.join("codex-provider-state.json"))?)
                .map_err(storage_error)?,
        ],
    };
    if present(&destination)? {
        verify_completed(&destination, &snapshot)?;
        return Ok(
            serde_json::json!({"snapshot":"complete","destination":requested_destination,"states":snapshot.states}),
        );
    }
    // Always acquire in the same order; failure releases the first fence.
    let stores = [
        IndexedStore::open_quiescent(
            &source.join("runner-state.sqlite"),
            &binding(&snapshot.locators[0], 0)?,
        )?,
        IndexedStore::open_quiescent(
            &source.join("codex-provider-state.sqlite"),
            &binding(&snapshot.locators[1], 1)?,
        )?,
    ];
    let runner = verify(&stores[0], 0, &snapshot.states[0])?;
    let provider = verify(&stores[1], 1, &snapshot.states[1])?;
    if runner["lifecycle"] != "suspended"
        || runner["ackedSourceSeq"]
            .as_u64()
            .and_then(|n| n.checked_add(1))
            != runner["nextSourceSeq"].as_u64()
        || runner["nextSourceSeq"].as_u64().is_none()
        || provider["activeProviderTurnId"].as_str().is_some()
        || provider["startupAttempt"].is_object()
        || provider["ambiguousTurnStartPending"] == true
        || ["pendingEvents", "queuedEvents"].iter().any(|key| {
            provider[key]
                .as_array()
                .is_none_or(|items| !items.is_empty())
        })
    {
        return Err(invalid("snapshot requires a settled native session"));
    }
    for key in ["runnerInstanceId", "normalizedSessionId"] {
        if runner[key].as_str().is_none_or(|value| {
            value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
        }) {
            return Err(invalid("snapshot session identity is invalid"));
        }
    }
    for (index, expected) in [
        (
            0,
            format!(
                "runner/{}/{}",
                runner["runnerInstanceId"].as_str().unwrap_or(""),
                runner["normalizedSessionId"].as_str().unwrap_or("")
            ),
        ),
        (
            1,
            format!(
                "provider/{}/{}",
                runner["runnerInstanceId"].as_str().unwrap_or(""),
                runner["normalizedSessionId"].as_str().unwrap_or("")
            ),
        ),
    ] {
        if binding(&snapshot.locators[index], index)? != expected {
            return Err(invalid("snapshot session binding differs"));
        }
    }
    let staging = destination.with_file_name(format!(
        ".{}.preparing",
        destination.file_name().unwrap().to_string_lossy()
    ));
    if !present(&staging)? {
        directory(&staging)?;
    }
    verify_private_directory(&staging)?;
    // A second snapshot process cannot race assembly or publish this job.
    let _job_lock = crate::indexed_partitions::PartitionLock::acquire(&staging.join("snapshot"))?;
    publish_file(
        &staging.join("request.json"),
        &serde_json::to_vec(&snapshot).map_err(storage_error)?,
    )?;
    hook("intent")?;
    let merged = staging.join("runner");
    let provider_root = staging.join("provider");
    let assembling = staging.join("assembling.json");
    if !present(&assembling)? {
        for (i, target) in [&merged, &provider_root].iter().enumerate() {
            if !present(target)? {
                stores[i].begin_named_backup(target, &format!("{}.sqlite", NAMES[i]))?;
                while !stores[i].backup_step()? {
                    hook("copy")?;
                    std::thread::yield_now();
                }
            } else {
                // Release any source pin left after the atomic publication.
                stores[i].backup_step()?;
            }
            verify_backup(target, i, &snapshot)?;
            hook(if i == 0 { "runner" } else { "provider" })?;
        }
        publish_file(&assembling, b"{\"assembling\":true}")?;
    } else if read(&assembling)? != b"{\"assembling\":true}" {
        return Err(invalid("snapshot assembly marker differs"));
    }
    for suffix in [
        ".sqlite",
        ".sqlite.receipts",
        ".sqlite.routing",
        ".sqlite-wal",
        ".sqlite-shm",
    ] {
        let name = format!("codex-provider-state{suffix}");
        if suffix == ".sqlite"
            || suffix == ".sqlite.receipts"
            || suffix == ".sqlite.routing"
            || present(&provider_root.join(&name))?
            || present(&merged.join(&name))?
        {
            move_once(&provider_root.join(&name), &merged.join(&name))?;
        }
        hook("merge")?;
    }
    for i in 0..2 {
        publish_file(
            &merged.join(format!("{}.json", NAMES[i])),
            snapshot.locators[i].as_bytes(),
        )?;
    }
    for name in NAMES {
        crate::indexed_partitions::seal_backup_files(&merged.join(format!("{name}.sqlite")))?;
        hook("sealed")?;
    }
    for name in NAMES {
        // Read-only inspection uses existing lifetime/operation fences before
        // the first execution open of a restored snapshot.
        for suffix in [".sqlite.lifetime", ".sqlite.lock"] {
            publish_file(&merged.join(format!("{name}{suffix}")), b"")?;
        }
    }
    publish_file(
        &merged.join(MANIFEST),
        &serde_json::to_vec(&snapshot).map_err(storage_error)?,
    )?;
    verify_completed(&merged, &snapshot)?;
    hook("verified")?;
    move_once(&merged, &destination)?;
    hook("published")?;
    Ok(
        serde_json::json!({"snapshot":"complete","destination":requested_destination,"states":snapshot.states}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed_store::ExactReceipt;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        destination: PathBuf,
        states: [ExpectedState; 2],
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "paperclip-session-snapshot-{}",
                uuid::Uuid::new_v4()
            ));
            directory(&root).unwrap();
            let source = root.join("source");
            directory(&source).unwrap();
            let mut states = Vec::new();
            for i in 0..2 {
                let binding = if i == 0 { "runner/r/s" } else { "provider/r/s" };
                publish_file(
                    &source.join(format!("{}.json", NAMES[i])),
                    &serde_json::to_vec(&json!({"schema":SCHEMAS[i],"binding":binding})).unwrap(),
                )
                .unwrap();
                let store =
                    IndexedStore::open(&source.join(format!("{}.sqlite", NAMES[i])), binding, true)
                        .unwrap();
                let bytes=serde_json::to_vec(&if i==0 {json!({"lifecycle":"suspended","runnerInstanceId":"r","normalizedSessionId":"s","nextSourceSeq":3,"ackedSourceSeq":2})} else {json!({"lifecycle":"ready","pendingEvents":[],"queuedEvents":[]})}).unwrap();
                let generation = store
                    .commit(
                        KEYS[i],
                        0,
                        bytes.clone(),
                        (0..270)
                            .map(|n| ExactReceipt {
                                namespace: "ancient".into(),
                                key: format!("{n:08}"),
                                bytes: vec![i as u8 + 20; 4096],
                            })
                            .collect(),
                    )
                    .unwrap();
                states.push(ExpectedState {
                    generation: generation.to_string(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                });
            }
            Self {
                destination: root.join("published"),
                root,
                source,
                states: states.try_into().unwrap(),
            }
        }
        fn restore(&self) {
            for i in 0..2 {
                let store = IndexedStore::open(
                    &self.destination.join(format!("{}.sqlite", NAMES[i])),
                    if i == 0 { "runner/r/s" } else { "provider/r/s" },
                    false,
                )
                .unwrap();
                verify(&store, i, &self.states[i]).unwrap();
                for n in [0, 127, 269] {
                    assert_eq!(
                        store.receipt("ancient", &format!("{n:08}")).unwrap(),
                        Some(vec![i as u8 + 20; 4096])
                    );
                }
                let partition = store.partitions(None, 1).unwrap();
                assert!(partition[0]
                    .file
                    .starts_with(&format!("{}.sqlite.receipts/", NAMES[i])));
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn exact_two_store_snapshot_restores_after_relocated_source_volume_is_lost() {
        let f = Fixture::new();
        let volume = f.root.join("volume");
        directory(&volume).unwrap();
        let path = f.source.join("codex-provider-state.sqlite");
        let store = IndexedStore::open(&path, "provider/r/s", false).unwrap();
        store.relocate_partition("", &volume).unwrap();
        for _ in 0..100 {
            store.maintain().unwrap();
        }
        assert!(store.partitions(None, 1).unwrap()[0]
            .file
            .starts_with(volume.canonicalize().unwrap().to_str().unwrap()));
        drop(store);
        snapshot_session(&f.source, &f.destination, f.states.clone()).unwrap();
        snapshot_session(&f.source, &f.destination, f.states.clone()).unwrap();
        fs::remove_dir_all(&f.source).unwrap();
        fs::remove_dir_all(volume).unwrap();
        f.restore();
    }
    #[test]
    fn opaque_revisions_restore_both_stores_and_ancient_receipts_after_source_loss() {
        let mut f = Fixture::new();
        for i in 0..2 {
            let path = f.source.join(format!("{}.sqlite", NAMES[i]));
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute(
                "UPDATE current_state SET generation=?1 WHERE key=?2",
                rusqlite::params![i64::MAX, KEYS[i]],
            )
            .unwrap();
            drop(db);
            let store = IndexedStore::open(
                &path,
                if i == 0 { "runner/r/s" } else { "provider/r/s" },
                false,
            )
            .unwrap();
            let current = store.read_state(KEYS[i]).unwrap().unwrap();
            let revision = store
                .commit(KEYS[i], current.generation, current.bytes, vec![])
                .unwrap();
            assert!(matches!(
                revision,
                crate::indexed_revision::Revision::Opaque(_)
            ));
            f.states[i].generation = revision.to_string();
        }
        snapshot_session(&f.source, &f.destination, f.states.clone()).unwrap();
        fs::remove_dir_all(&f.source).unwrap();
        f.restore();
    }

    #[test]
    fn every_copy_and_publication_boundary_resumes_without_partial_activation() {
        let boundary_count = {
            let baseline = Fixture::new();
            let calls = AtomicUsize::new(0);
            snapshot_with_hook(
                &baseline.source,
                &baseline.destination,
                baseline.states.clone(),
                |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
            let count = calls.load(Ordering::SeqCst);
            assert!(
                count >= 10,
                "snapshot boundary coverage unexpectedly shrank to {count}"
            );
            baseline.restore();
            count
        };
        let mut interruptions = 0;
        let mut completed = false;
        for stop_at in 0..=boundary_count {
            let f = Fixture::new();
            let calls = AtomicUsize::new(0);
            let result = snapshot_with_hook(&f.source, &f.destination, f.states.clone(), |_| {
                if calls.fetch_add(1, Ordering::SeqCst) == stop_at {
                    Err(invalid("injected snapshot interruption"))
                } else {
                    Ok(())
                }
            });
            if result.is_ok() {
                assert_eq!(
                    stop_at, boundary_count,
                    "snapshot completed before the last observed boundary"
                );
                completed = true;
                break;
            }
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("injected snapshot interruption"));
            interruptions += 1;
            if f.destination.exists() {
                f.restore();
            }
            snapshot_session(&f.source, &f.destination, f.states.clone()).unwrap();
            f.restore();
        }
        assert!(
            completed,
            "fault matrix did not complete after every snapshot boundary"
        );
        assert_eq!(
            interruptions, boundary_count,
            "fault matrix did not interrupt every boundary exactly once"
        );
    }
    #[test]
    fn rejects_live_connections_changed_generations_and_conflicting_destinations() {
        let f = Fixture::new();
        for i in 0..2 {
            let store = IndexedStore::open(
                &f.source.join(format!("{}.sqlite", NAMES[i])),
                if i == 0 { "runner/r/s" } else { "provider/r/s" },
                false,
            )
            .unwrap();
            assert!(
                snapshot_session(&f.source, &f.destination, f.states.clone())
                    .unwrap_err()
                    .to_string()
                    .contains("open connection")
            );
            assert!(!f.destination.exists());
            drop(store);
        }
        let mut changed = f.states.clone();
        changed[0].generation = "2".into();
        assert!(snapshot_session(&f.source, &f.destination, changed)
            .unwrap_err()
            .to_string()
            .contains("state changed"));
        directory(&f.destination).unwrap();
        assert!(snapshot_session(&f.source, &f.destination, f.states.clone()).is_err());
        assert!(fs::read_dir(&f.destination).unwrap().next().is_none());
    }
    #[test]
    fn completed_snapshot_retry_rejects_missing_or_corrupted_historical_receipts() {
        for missing in [false, true] {
            let f = Fixture::new();
            snapshot_session(&f.source, &f.destination, f.states.clone()).unwrap();
            let db = rusqlite::Connection::open(f.destination.join("runner-state.sqlite")).unwrap();
            let relative = crate::indexed_partitions::partitions(&db, None, 1)
                .unwrap()
                .into_iter()
                .next()
                .expect("snapshot has a receipt route")
                .file;
            drop(db);
            let partition = f.destination.join(relative);
            if missing {
                fs::remove_file(partition).unwrap();
            } else {
                let db = rusqlite::Connection::open(partition).unwrap();
                db.execute("UPDATE receipt_rows SET body=x'00' WHERE ordinal=1", [])
                    .unwrap();
            }
            assert!(snapshot_session(&f.source, &f.destination, f.states.clone()).is_err());
        }
    }
    #[test]
    fn rejects_unsettled_delivery_before_creating_a_backup() {
        let mut f = Fixture::new();
        let store =
            IndexedStore::open(&f.source.join("runner-state.sqlite"), "runner/r/s", false).unwrap();
        let mut state: Value =
            serde_json::from_slice(&store.read_state("runner").unwrap().unwrap().bytes).unwrap();
        state["nextSourceSeq"] = json!(4);
        let bytes = serde_json::to_vec(&state).unwrap();
        store.commit("runner", 1, bytes.clone(), vec![]).unwrap();
        drop(store);
        f.states[0] = ExpectedState {
            generation: "2".into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        assert!(
            snapshot_session(&f.source, &f.destination, f.states.clone())
                .unwrap_err()
                .to_string()
                .contains("settled native session")
        );
        assert!(!f.destination.exists());
    }
}
