//! Online, resumable snapshots. A short root snapshot pins immutable source
//! partitions; bounded copies select only the insertion ordinals present at
//! that snapshot. Appends, splits and relocation continue between copy steps.
//! The destination is published only after every range verifies exactly.
use super::*;

struct Backup {
    id: String,
    destination: PathBuf,
    staging: PathBuf,
    phase: String,
    filename: String,
}
fn valid_filename(filename: &str) -> bool {
    filename.len() <= 120
        && filename.ends_with(".sqlite")
        && !filename.starts_with('.')
        && filename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn job(db: &Connection) -> Result<Option<Backup>> {
    db.query_row(
        "SELECT id,destination,staging,phase,COALESCE((SELECT filename FROM receipt_backup_filename WHERE singleton=1),'authority.sqlite') FROM receipt_backup WHERE singleton=1",
        [],
        |r| {
            Ok(Backup {
                id: r.get(0)?,
                destination: PathBuf::from(r.get::<_, String>(1)?),
                staging: PathBuf::from(r.get::<_, String>(2)?),
                phase: r.get(3)?,
                filename: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(error).and_then(|job| {
        if job.as_ref().is_some_and(|job| !valid_filename(&job.filename)) {
            return Err(invalid("invalid backup database filename"));
        }
        Ok(job)
    })
}
fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(error)?;
    sync_directory(path.parent().unwrap())
}
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(error)
}
fn publish_directory(source: &Path, destination: &Path) -> Result<()> {
    // The earlier existence check is only diagnostic. Publication itself must
    // refuse a directory/symlink created by another owner during the copy.
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            source,
            rustix::fs::CWD,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(error)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    {
        let _ = (source, destination);
        Err(invalid(
            "atomic backup publication is unqualified on this platform",
        ))
    }
}
fn create_file(path: &Path) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).and_then(|f| f.sync_all()).map_err(error)
}
fn root(path: &Path) -> Result<Connection> {
    crate::durable::verify_private_directory(path.parent().unwrap())?;
    for suffix in ["", "-wal", "-shm"] {
        match crate::indexed_store::verify_sqlite_file(Path::new(&format!(
            "{}{suffix}",
            path.display()
        ))) {
            Ok(_) => {}
            Err(e) if !suffix.is_empty() && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
    }
    let db = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(error)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096;").map_err(error)?;
    Ok(db)
}
/// Called before any activated store can serve a snapshot.
pub(crate) fn validate_backup(db: &Connection) -> Result<()> {
    let marker: Option<i64> = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_manifest'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if marker.is_some()
        && db
            .query_row(
                "SELECT complete FROM backup_manifest WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(error)?
            != 1
    {
        return Err(invalid(
            "incomplete backup cannot serve execution authority",
        ));
    }
    Ok(())
}

pub(crate) fn begin_backup(db: &mut Connection, destination: &Path, filename: &str) -> Result<()> {
    if !valid_filename(filename) {
        return Err(invalid("invalid backup database filename"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("backup has no parent"))?;
    crate::durable::verify_private_directory(parent)?;
    let destination = parent.canonicalize().map_err(error)?.join(
        destination
            .file_name()
            .ok_or_else(|| invalid("backup has no filename"))?,
    );
    if let Some(active) = job(db)? {
        if active.destination != destination || active.filename != filename {
            return Err(invalid("storage_pressure: another backup is active"));
        }
        return Ok(());
    }
    if destination.try_exists().map_err(error)? {
        return Err(invalid("backup destination already exists"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let staging = parent
        .canonicalize()
        .map_err(error)?
        .join(format!(".receipt-backup-{id}"));
    private_directory(&staging)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    tx.execute(
        "INSERT INTO receipt_backup VALUES(1,?1,?2,?3,'preparing')",
        params![id, destination.to_str(), staging.to_str()],
    )
    .map_err(error)?;
    tx.execute(
        "INSERT OR REPLACE INTO receipt_backup_filename VALUES(1,?1)",
        [filename],
    )
    .map_err(error)?;
    tx.commit().map_err(error)?;
    Ok(())
}

fn prepare(db: &mut Connection, job: &Backup) -> Result<()> {
    crate::durable::verify_private_directory(&job.staging)?;
    let path = job.staging.join(&job.filename);
    // Preparing has not published a snapshot. Restart only this owned temporary
    // root; no receipt files have been copied yet and no destination is visible.
    for suffix in ["-wal", "-shm", ""] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        match crate::indexed_store::verify_sqlite_file(&file) {
            Ok(_) => fs::remove_file(file).map_err(error)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e)),
        }
    }
    create_file(&path)?;
    // Only bounded current/redo state and two routing pointers live here. The
    // immutable tree root is the snapshot inventory; no O(H) pin/backlog copy
    // happens while the operation fence is held.
    db.execute("VACUUM INTO ?1", [path.to_str()])
        .map_err(error)?;
    let target = root(&path)?;
    // A backup of a restored store may already contain a completed marker.
    target.execute_batch("BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS backup_manifest;
        DROP TABLE IF EXISTS backup_copy;
        CREATE TABLE backup_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN(0,1)));
        CREATE TABLE backup_copy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), after_lower TEXT, lower_key TEXT, source TEXT, target TEXT, records INTEGER, bytes INTEGER, fingerprint BLOB, cursor INTEGER NOT NULL DEFAULT 0, verifying INTEGER NOT NULL DEFAULT 0, verified_after TEXT);
        INSERT INTO backup_copy(singleton) VALUES(1);
        DELETE FROM receipt_migration;
        DELETE FROM receipt_backup; DELETE FROM receipt_backup_filename;
        COMMIT;").map_err(error)?;
    routes::rebase_snapshot(&target, db)?;
    target
        .execute("INSERT INTO backup_manifest VALUES(1,?1,0)", [&job.id])
        .map_err(error)?;
    target
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(error)?;
    drop(target);
    crate::durable::open_private_regular_file(&path)
        .and_then(|f| f.sync_all())
        .map_err(error)?;
    sync_directory(&job.staging)?;
    db.execute(
        "UPDATE receipt_backup SET phase='copying' WHERE singleton=1",
        [],
    )
    .map_err(error)?;
    Ok(())
}

fn release(db: &mut Connection, job: &Backup) -> Result<bool> {
    let target = root(&job.destination.join(&job.filename))?;
    let marker: (String, i64) = target
        .query_row(
            "SELECT id,complete FROM backup_manifest WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(error)?;
    if marker != (job.id.clone(), 1) {
        return Err(invalid("published backup identity differs"));
    }
    sync_directory(job.destination.parent().unwrap())?;
    db.execute_batch(
        "BEGIN IMMEDIATE; DELETE FROM receipt_backup; DELETE FROM receipt_backup_filename; COMMIT;",
    )
    .map_err(error)?;
    Ok(true)
}

/// Returns true only after an independently openable snapshot is published.
/// The caller yields its operation fence after each <=128-record/4-MiB page.
pub(crate) fn backup_step(db: &mut Connection) -> Result<bool> {
    let Some(job) = job(db)? else {
        return Ok(true);
    };
    if job.destination.try_exists().map_err(error)? {
        return release(db, &job);
    }
    if job.phase == "preparing" {
        prepare(db, &job)?;
        return Ok(false);
    }
    if job.phase != "copying" {
        return Err(invalid("invalid backup phase"));
    }
    let path = job.staging.join(&job.filename);
    let mut target_root = root(&path)?;
    let marker: (String, i64) = target_root
        .query_row(
            "SELECT id,complete FROM backup_manifest WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(error)?;
    if marker.0 != job.id {
        return Err(invalid("backup identity differs"));
    }
    if marker.1 == 1 {
        target_root
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(error)?;
        drop(target_root);
        crate::durable::open_private_regular_file(&path)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        sync_directory(&job.staging)?;
        publish_directory(&job.staging, &job.destination)?;
        return release(db, &job);
    }
    let (verifying, verified_after): (bool, Option<String>) = target_root
        .query_row(
            "SELECT verifying,verified_after FROM backup_copy WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(error)?;
    if !verifying {
        type CopyRow = (String, String, Option<String>, i64, i64, Vec<u8>, i64);
        let active: bool = target_root
            .query_row(
                "SELECT lower_key IS NOT NULL FROM backup_copy WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        if !active {
            let after: Option<String> = target_root
                .query_row(
                    "SELECT after_lower FROM backup_copy WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if let Some(row) = routes::next(&target_root, "routes", after.as_deref())? {
                target_root.execute("UPDATE backup_copy SET lower_key=?1,source=?2,target=NULL,records=?3,bytes=?4,fingerprint=?5,cursor=0 WHERE singleton=1",
                    params![row.lower, row.file, row.records, row.bytes, row.fingerprint]).map_err(error)?;
            }
        }
        let next: Option<CopyRow> = target_root.query_row("SELECT lower_key,source,target,records,bytes,CASE WHEN length(fingerprint)=32 THEN fingerprint END,cursor FROM backup_copy WHERE lower_key IS NOT NULL AND singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional().map_err(error)?;
        if let Some((lower, source, target, count, size, sha, cursor)) = next {
            if count < 0 || cursor < 0 || cursor > count {
                return Err(invalid("invalid backup cursor"));
            }
            let target = match target {
                Some(file) => file,
                None => {
                    let file = local_name(&path, &new_shard(&directory(&path)?)?)?;
                    target_root
                        .execute(
                            "UPDATE backup_copy SET target=?2 WHERE lower_key=?1 AND singleton=1",
                            params![lower, file],
                        )
                        .map_err(error)?;
                    file
                }
            };
            // Resolve source using the live root, including relocated private volumes.
            let source_db = open_shard(&resolve_file(db, &source)?, false)?;
            let mut query=source_db.prepare("SELECT ordinal,namespace,receipt_key,CASE WHEN length(body)<=33554432 THEN body END,CASE WHEN length(digest)=32 THEN digest END FROM receipt_rows WHERE ordinal>?1 AND ordinal<=?2 ORDER BY ordinal LIMIT 128").map_err(error)?;
            let mut rows = query.query(params![cursor, count]).map_err(error)?;
            let mut batch = Vec::new();
            let mut bytes = 0;
            let mut after = cursor;
            while let Some(row) = rows.next().map_err(error)? {
                let ordinal: i64 = row.get(0).map_err(error)?;
                let body: Vec<u8> = row.get(3).map_err(error)?;
                let digest: Vec<u8> = row.get(4).map_err(error)?;
                verify(&body, &digest)?;
                if !batch.is_empty() && bytes + body.len() > PAGE_BYTES {
                    break;
                }
                if ordinal != after + 1 {
                    return Err(invalid("backup source ordinal gap"));
                }
                after = ordinal;
                bytes += body.len();
                batch.push(ExactReceipt {
                    namespace: row.get(1).map_err(error)?,
                    key: row.get(2).map_err(error)?,
                    bytes: body,
                });
            }
            drop(rows);
            drop(query);
            drop(source_db);
            if after == cursor && cursor < count {
                return Err(invalid("backup source is incomplete"));
            }
            insert_batch(
                &mut open_shard(&resolve_file(&target_root, &target)?, false)?,
                &batch,
            )?;
            if after < count {
                target_root
                    .execute(
                        "UPDATE backup_copy SET cursor=?2 WHERE lower_key=?1 AND singleton=1",
                        params![lower, after],
                    )
                    .map_err(error)?;
                return Ok(false);
            }
            if totals(&target_root, &target)? != (count, size, sha.clone()) {
                return Err(invalid("backup partition verification failed"));
            }
            let tx = target_root
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            routes::put(
                &tx,
                "routes",
                routes::Route {
                    lower: lower.clone(),
                    file: target,
                    records: count,
                    bytes: size,
                    fingerprint: sha,
                },
            )?;
            tx.execute(
                "UPDATE backup_copy SET after_lower=?1,lower_key=NULL,source=NULL,target=NULL,records=NULL,bytes=NULL,fingerprint=NULL,cursor=0 WHERE singleton=1",
                [&lower],
            )
            .map_err(error)?;
            tx.commit().map_err(error)?;
            return Ok(false);
        }
        target_root
            .execute("UPDATE backup_copy SET verifying=1 WHERE singleton=1", [])
            .map_err(error)?;
        return Ok(false);
    }
    if let Some(row) = routes::next_local(&target_root, verified_after.as_deref())? {
        target_root
            .execute(
                "UPDATE backup_copy SET verified_after=?1 WHERE singleton=1",
                [row.lower],
            )
            .map_err(error)?;
        return Ok(false);
    }
    target_root
        .execute_batch(
            "BEGIN IMMEDIATE;
        UPDATE backup_manifest SET complete=1 WHERE singleton=1;
        DROP TABLE backup_copy;
        COMMIT; PRAGMA wal_checkpoint(TRUNCATE);",
        )
        .map_err(error)?;
    drop(target_root);
    crate::durable::open_private_regular_file(&path)
        .and_then(|f| f.sync_all())
        .map_err(error)?;
    sync_directory(&job.staging)?;
    publish_directory(&job.staging, &job.destination)?;
    release(db, &job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed_store::IndexedStore;
    #[test]
    fn publication_does_not_replace_a_racing_empty_directory_or_symlink() {
        let home = std::env::temp_dir().join(format!(
            "paperclip-backup-publication-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&home).unwrap();
        let source = home.join("prepared");
        let destination = home.join("backup");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("evidence"), b"verified snapshot").unwrap();
        fs::create_dir(&destination).unwrap();
        assert!(publish_directory(&source, &destination).is_err());
        assert!(source.join("evidence").exists());
        assert!(fs::read_dir(&destination).unwrap().next().is_none());
        fs::remove_dir(&destination).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(home.join("missing"), &destination).unwrap();
            assert!(publish_directory(&source, &destination).is_err());
            assert!(fs::symlink_metadata(&destination).unwrap().is_symlink());
            fs::remove_file(&destination).unwrap();
        }
        publish_directory(&source, &destination).unwrap();
        assert_eq!(
            fs::read(destination.join("evidence")).unwrap(),
            b"verified snapshot"
        );
        fs::remove_dir_all(home).unwrap();
    }
    fn receipt(i: u64) -> ExactReceipt {
        ExactReceipt {
            namespace: "effects".into(),
            key: format!("effect-{i:020}"),
            bytes: vec![(i % 251) as u8; 1024],
        }
    }
    #[test]
    fn snapshot_restores_exact_prefix_while_live_writes_and_splits_continue_across_restarts() {
        let home = std::env::temp_dir().join(format!("paperclip-backup-{}", uuid::Uuid::new_v4()));
        let path = home.join("source.sqlite");
        let mut store = IndexedStore::open(&path, "backup-test", true).unwrap();
        store
            .commit(
                "authority",
                0,
                b"snapshot-state".to_vec(),
                (0..500).map(receipt).collect(),
            )
            .unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE receipt_storage_config SET partition_bytes=32768",
            [],
        )
        .unwrap();
        for _ in 0..80 {
            store.maintain().unwrap();
        }
        let destination = home.join("backup");
        store.begin_backup(&destination).unwrap();
        assert!(!store.backup_step().unwrap());
        assert!(!destination.exists());
        let staging: String = db
            .query_row("SELECT staging FROM receipt_backup", [], |r| r.get(0))
            .unwrap();
        assert!(IndexedStore::open(
            &Path::new(&staging).join("authority.sqlite"),
            "backup-test",
            false
        )
        .is_err());
        let mut complete = false;
        let mut generation = 1;
        let mut verification_steps = 0;
        for i in 0..200 {
            store
                .commit(
                    "authority",
                    generation,
                    b"live-state".to_vec(),
                    vec![receipt(500 + i)],
                )
                .unwrap();
            generation += 1;
            for _ in 0..4 {
                store.maintain().unwrap();
            }
            if i % 2 == 0 {
                drop(store);
                store = IndexedStore::open(&path, "backup-test", false).unwrap();
                store.begin_backup(&destination).unwrap();
            }
            let snapshot = root(&Path::new(&staging).join("authority.sqlite")).unwrap();
            if snapshot
                .query_row("SELECT verifying FROM backup_copy", [], |r| {
                    r.get::<_, bool>(0)
                })
                .unwrap()
            {
                verification_steps += 1;
            }
            drop(snapshot);
            if store.backup_step().unwrap() {
                complete = true;
                break;
            }
        }
        assert!(complete);
        assert!(
            verification_steps > 2,
            "verification must yield across routing pages and restarts"
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM receipt_backup", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let restored =
            IndexedStore::open(&destination.join("authority.sqlite"), "backup-test", false)
                .unwrap();
        let state = restored.read_state("authority").unwrap().unwrap();
        assert_eq!(state.generation, 1);
        assert_eq!(state.bytes, b"snapshot-state");
        for i in [0, 127, 499] {
            assert_eq!(
                restored.receipt("effects", &receipt(i).key).unwrap(),
                Some(receipt(i).bytes)
            );
        }
        assert_eq!(
            restored.receipt("effects", &receipt(500).key).unwrap(),
            None
        );
        assert_eq!(
            store.read_state("authority").unwrap().unwrap().generation,
            generation
        );
        assert!(store
            .receipt("effects", &receipt(500).key)
            .unwrap()
            .is_some());
        drop(restored);
        drop(store);
        drop(db);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn interrupted_preparation_can_restart_and_incomplete_source_cannot_publish() {
        let home =
            std::env::temp_dir().join(format!("paperclip-backup-fault-{}", uuid::Uuid::new_v4()));
        let path = home.join("source.sqlite");
        let store = IndexedStore::open(&path, "backup-test", true).unwrap();
        store
            .commit("authority", 0, b"state".to_vec(), vec![receipt(0)])
            .unwrap();
        let destination = home.join("backup");
        store.begin_backup(&destination).unwrap();
        drop(store);
        let db = Connection::open(&path).unwrap();
        let active = job(&db).unwrap().unwrap();
        create_file(&active.staging.join("authority.sqlite")).unwrap();
        let store = IndexedStore::open(&path, "backup-test", false).unwrap();
        store.begin_backup(&destination).unwrap();
        assert!(!store.backup_step().unwrap());
        let (_, file) = route(&db, "effects\0effect").unwrap();
        let shard = open_shard(&resolve_file(&db, &file).unwrap(), false).unwrap();
        shard.execute("DELETE FROM receipt_rows", []).unwrap();
        drop(shard);
        assert!(store.backup_step().is_err());
        assert!(!destination.exists());
        assert_eq!(
            db.query_row("SELECT count(*) FROM receipt_backup", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(store);
        drop(db);
        fs::remove_dir_all(home).unwrap();
    }
}
