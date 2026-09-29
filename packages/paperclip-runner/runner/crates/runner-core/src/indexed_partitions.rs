//! Range-routed immutable receipts. Only bounded routing heads/current authority
//! live in the root database. A durable prepare record makes a multi-file commit
//! recoverable without assuming atomic transactions across SQLite WAL files.
use crate::durable::DurableRunnerError;
use crate::indexed_revision::Revision;
use crate::indexed_store::ExactReceipt;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[path = "indexed_backup.rs"]
mod backup;
pub(crate) use backup::{backup_step, begin_backup, validate_backup};
#[path = "indexed_routes.rs"]
mod routes;
pub(crate) use routes::RoutingCollector;

type Result<T> = std::result::Result<T, DurableRunnerError>;
const DEFAULT_PARTITION_BYTES: u64 = 256 * 1024 * 1024;
const PAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
fn error(e: impl std::fmt::Display + std::any::Any) -> DurableRunnerError {
    crate::indexed_store::storage_error(e)
}
fn invalid(e: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(e)
}
fn logical(namespace: &str, key: &str) -> String {
    format!("{namespace}\0{key}")
}
fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}
fn verify(bytes: &[u8], expected: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BODY || digest(bytes) != expected {
        return Err(invalid("indexed receipt digest/size mismatch"));
    }
    Ok(())
}
fn xor(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.iter().zip(b).map(|(a, b)| a ^ b).collect()
}
fn identity_digest(key: &str, body: &[u8]) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update((key.len() as u64).to_be_bytes());
    hash.update(key.as_bytes());
    hash.update(digest(body));
    hash.finalize().to_vec()
}

/// The advisory lock covers one operation, including all shard commits and
/// cutovers. Separate store handles/processes cannot race recovery or unlink a
/// shard used by a reader. No lock is held while waiting for provider activity.
pub(crate) struct PartitionLock(fs::File);
impl PartitionLock {
    pub(crate) fn existing(path: &Path) -> Result<Self> {
        let lock_path = PathBuf::from(format!("{}.lock", path.display()));
        let file = crate::durable::open_private_regular_file(&lock_path).map_err(error)?;
        file.lock().map_err(error)?;
        Ok(Self(file))
    }
    pub(crate) fn acquire(path: &Path) -> Result<Self> {
        let lock_path = PathBuf::from(format!("{}.lock", path.display()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&lock_path) {
            Ok(file) => file.sync_all().map_err(error)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(error(e)),
        }
        let file = crate::durable::open_private_regular_file(&lock_path).map_err(error)?;
        file.lock().map_err(error)?;
        Ok(Self(file))
    }
}
impl Drop for PartitionLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn directory(path: &Path) -> Result<PathBuf> {
    let directory = PathBuf::from(format!("{}.receipts", path.display()));
    if !directory.exists() {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(error)?;
        fs::File::open(path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(error)?;
    }
    crate::durable::verify_private_directory(&directory)?;
    Ok(directory)
}

fn open_shard(path: &Path, create: bool) -> Result<Connection> {
    open_shard_mode(path, create, false)
}
fn open_shard_mode(path: &Path, create: bool, read_only: bool) -> Result<Connection> {
    crate::durable::verify_private_directory(
        path.parent()
            .ok_or_else(|| invalid("shard has no parent"))?,
    )?;
    if create {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(path)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
    }
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
        (if read_only {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
        }) | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(error)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(error)?;
    if read_only {
        db.execute_batch(
            "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024;",
        )
        .map_err(error)?;
    } else {
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024; PRAGMA cache_spill=OFF; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;").map_err(error)?;
    }
    if create {
        db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE receipt_rows (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, receipt_key TEXT NOT NULL, body BLOB NOT NULL, digest BLOB NOT NULL, ordinal INTEGER NOT NULL UNIQUE) WITHOUT ROWID; CREATE TABLE receipt_totals(singleton INTEGER PRIMARY KEY CHECK(singleton=1), records INTEGER NOT NULL, bytes INTEGER NOT NULL, fingerprint BLOB NOT NULL); INSERT INTO receipt_totals VALUES(1,0,0,zeroblob(32)); COMMIT;").map_err(error)?;
        fs::File::open(path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(error)?;
    }
    Ok(db)
}
fn resolve_file(db: &Connection, file: &str) -> Result<PathBuf> {
    let file = Path::new(file);
    if file.is_absolute() {
        return Ok(file.to_owned());
    }
    if file
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(invalid("invalid receipt partition path"));
    }
    let root = Path::new(
        db.path()
            .ok_or_else(|| invalid("receipt root has no path"))?,
    );
    Ok(root.parent().unwrap().join(file))
}
fn new_shard(dir: &Path) -> Result<String> {
    let path = dir
        .canonicalize()
        .map_err(error)?
        .join(format!("{}.sqlite", uuid::Uuid::new_v4()));
    open_shard(&path, true)?;
    Ok(path
        .to_str()
        .ok_or_else(|| invalid("invalid shard path"))?
        .to_owned())
}

/// Full backup verification is deliberate background I/O. Read one bounded
/// receipt at a time, including its exact key/digest, and compare every range
/// with the frozen root. This is never called by ordinary current-state reads.
pub(crate) fn verify_backup_receipts(db: &Connection) -> Result<()> {
    routes::verify_local(db)?;
    let root = Path::new(
        db.path()
            .ok_or_else(|| invalid("backup has no database path"))?,
    );
    let expected_directory = format!("{}.receipts", root.file_name().unwrap().to_string_lossy());
    let mut after = None;
    while let Some(range) = routes::next(db, "routes", after.as_deref())? {
        after = Some(range.lower);
        let file = range.file;
        let parts: Vec<_> = Path::new(&file).components().collect();
        if parts.len() != 2
            || parts[0].as_os_str() != std::ffi::OsStr::new(&expected_directory)
            || !matches!(parts[1], std::path::Component::Normal(_))
        {
            return Err(invalid("backup references an external receipt partition"));
        }
        let expected = (range.records, range.bytes, range.fingerprint);
        let shard = open_shard_mode(&resolve_file(db, &file)?, false, true)?;
        let mut query = shard.prepare("SELECT ordinal,CASE WHEN length(id)<=2049 THEN id END,CASE WHEN length(namespace)<=1024 THEN namespace END,CASE WHEN length(receipt_key)<=1024 THEN receipt_key END,CASE WHEN length(body)<=33554432 THEN body END,CASE WHEN length(digest)=32 THEN digest END FROM receipt_rows ORDER BY ordinal").map_err(error)?;
        let mut rows = query.query([]).map_err(error)?;
        let mut count = 0i64;
        let mut bytes = 0i64;
        let mut fingerprint = vec![0u8; 32];
        while let Some(row) = rows.next().map_err(error)? {
            let ordinal: i64 = row.get(0).map_err(error)?;
            let key: String = row.get(1).map_err(error)?;
            let namespace: String = row.get(2).map_err(error)?;
            let receipt_key: String = row.get(3).map_err(error)?;
            let body: Vec<u8> = row.get(4).map_err(error)?;
            let sha: Vec<u8> = row.get(5).map_err(error)?;
            count = count
                .checked_add(1)
                .ok_or_else(|| invalid("backup receipt count overflow"))?;
            bytes = bytes
                .checked_add((body.len() + key.len() + 64) as i64)
                .ok_or_else(|| invalid("backup receipt bytes overflow"))?;
            if ordinal != count || key != logical(&namespace, &receipt_key) {
                return Err(invalid("backup receipt identity differs"));
            }
            verify(&body, &sha)?;
            fingerprint = xor(&fingerprint, &identity_digest(&key, &body));
        }
        if (count, bytes, fingerprint) != expected {
            return Err(invalid("backup receipt range differs"));
        }
    }
    Ok(())
}

/// Published snapshots use rollback journals so read-only inspection does not
/// create or mutate WAL/SHM files covered by the outer archive digest. Execution
/// restores WAL mode through the ordinary IndexedStore open path.
pub(crate) fn seal_backup_files(path: &Path) -> Result<()> {
    fn seal(path: &Path) -> Result<Connection> {
        crate::durable::verify_private_directory(
            path.parent()
                .ok_or_else(|| invalid("snapshot file has no parent"))?,
        )?;
        for suffix in ["", "-wal", "-shm"] {
            match crate::indexed_store::verify_sqlite_file(&PathBuf::from(format!(
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
        db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA busy_timeout=5000").map_err(error)?;
        let busy: i64 = db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
            .map_err(error)?;
        if busy != 0 {
            return Err(invalid("snapshot checkpoint is busy"));
        }
        let mode: String = db
            .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
            .map_err(error)?;
        if mode != "delete" {
            return Err(invalid("snapshot journal was not sealed"));
        }
        // Release SQLite's descriptors before opening a separate fsync handle:
        // closing that handle must never cancel locks on a live connection.
        drop(db);
        crate::durable::open_private_regular_file(path)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(error)
    }
    let db = seal(path)?;
    routes::verify_local(&db)?;
    let mut after = None;
    while let Some(row) = routes::next(&db, "routes", after.as_deref())? {
        after = Some(row.lower);
        let file = row.file;
        // verify_backup_receipts has already rejected external routes.
        let parts: Vec<_> = Path::new(&file).components().collect();
        let expected = format!("{}.receipts", path.file_name().unwrap().to_string_lossy());
        if parts.len() != 2
            || parts[0].as_os_str() != std::ffi::OsStr::new(&expected)
            || !matches!(parts[1], std::path::Component::Normal(_))
        {
            return Err(invalid("snapshot cannot seal external receipts"));
        }
        drop(seal(&resolve_file(&db, &file)?)?);
    }
    for directory in [
        path.parent().unwrap().to_owned(),
        PathBuf::from(format!("{}.receipts", path.display())),
    ] {
        fs::File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(error)?;
    }
    Ok(())
}

pub(crate) fn initialize(db: &mut Connection, path: &Path) -> Result<()> {
    let dir = directory(path)?;
    // The flat indexed preview format was never enabled by default. Retained
    // roots require explicit maintenance migration, never an implicit O(H)
    // routing rebuild while resuming an agent.
    let legacy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_routes')", [], |r| r.get(0)).map_err(error)?;
    if legacy {
        return Err(invalid(
            "flat receipt routing requires explicit maintenance migration",
        ));
    }
    let routing_exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_routing_heads')", [], |r| r.get(0)).map_err(error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let db = &tx;
    routes::initialize(db)?;
    db.execute_batch("
      CREATE TABLE IF NOT EXISTS receipt_prepare(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_key TEXT NOT NULL, generation INTEGER NOT NULL, body BLOB NOT NULL, digest BLOB NOT NULL, records INTEGER NOT NULL, fingerprint BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_prepare_rows(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, receipt_key TEXT NOT NULL, body BLOB NOT NULL, digest BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS receipt_prepare_routes(lower_key TEXT PRIMARY KEY, file TEXT NOT NULL, records INTEGER NOT NULL, bytes INTEGER NOT NULL, fingerprint BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS receipt_migration(singleton INTEGER PRIMARY KEY CHECK(singleton=1), lower_key TEXT NOT NULL, source TEXT NOT NULL, pivot TEXT, left_file TEXT NOT NULL, right_file TEXT, cursor TEXT, upper_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_backup(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, destination TEXT NOT NULL, staging TEXT NOT NULL, phase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_backup_filename(singleton INTEGER PRIMARY KEY CHECK(singleton=1), filename TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_cleanup_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1), after_file TEXT NOT NULL);
      INSERT OR IGNORE INTO receipt_cleanup_cursor VALUES(1,'');
      CREATE TABLE IF NOT EXISTS receipt_storage_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), partition_bytes INTEGER NOT NULL);").map_err(error)?;
    db.execute(
        "INSERT OR IGNORE INTO receipt_storage_config VALUES(1,?1)",
        [DEFAULT_PARTITION_BYTES as i64],
    )
    .map_err(error)?;
    if routes::next(db, "routes", None)?.is_none() {
        if routing_exists {
            return Err(invalid("receipt routing authority is missing"));
        }
        let file = local_name(path, &new_shard(&dir)?)?;
        routes::put(db, "routes", routes::Route::empty(String::new(), file))?;
    }
    tx.commit().map_err(error)
}
fn local_name(root: &Path, file: &str) -> Result<String> {
    Ok(Path::new(file)
        .strip_prefix(root.parent().unwrap())
        .map_err(error)?
        .to_str()
        .ok_or_else(|| invalid("invalid shard path"))?
        .to_owned())
}

/// Validate one bounded path when reopening. A missing committed head cannot
/// become a fresh empty store, even when the caller only asks for current state.
pub(crate) fn validate_routing(db: &Connection) -> Result<()> {
    if !routes::next(db, "routes", None)?.is_some_and(|r| r.lower.is_empty()) {
        return Err(invalid("receipt routing authority is missing"));
    }
    Ok(())
}
fn route(db: &Connection, id: &str) -> Result<(String, String)> {
    let row =
        routes::floor(db, "routes", id)?.ok_or_else(|| invalid("receipt route is missing"))?;
    Ok((row.lower, row.file))
}

/// A route names an expected receipt set, not merely a pathname. Validate that
/// set before using a negative lookup as permission to accept a new identity.
fn checked_shard(db: &Connection, lower: &str, file: &str) -> Result<Connection> {
    checked_shard_mode(db, lower, file, false)
}
fn checked_shard_mode(
    db: &Connection,
    lower: &str,
    file: &str,
    read_only: bool,
) -> Result<Connection> {
    let expected = routes::exact(db, "routes", lower)?
        .filter(|r| r.file == file)
        .ok_or_else(|| invalid("receipt route binding mismatch"))?;
    let shard = open_shard_mode(&resolve_file(db, file)?, false, read_only)?;
    if shard_totals(&shard)? != (expected.records, expected.bytes, expected.fingerprint) {
        return Err(invalid(
            "receipt partition differs from its authoritative route",
        ));
    }
    Ok(shard)
}
fn shard_receipt(db: &Connection, id: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(Vec<u8>,Vec<u8>)> = db.query_row("SELECT CASE WHEN length(body)<=?2 THEN body END, CASE WHEN length(digest)=32 THEN digest END FROM receipt_rows WHERE id=?1", params![id,MAX_BODY as i64], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
    row.map(|(body, sha)| {
        verify(&body, &sha)?;
        Ok(body)
    })
    .transpose()
}
pub(crate) fn receipt(db: &Connection, namespace: &str, key: &str) -> Result<Option<Vec<u8>>> {
    let id = logical(namespace, key);
    let (lower, file) = route(db, &id)?;
    shard_receipt(&checked_shard(db, &lower, &file)?, &id)
}
pub(crate) fn read_only_receipt(
    db: &Connection,
    namespace: &str,
    key: &str,
) -> Result<Option<Vec<u8>>> {
    let id = logical(namespace, key);
    let (lower, file) = route(db, &id)?;
    shard_receipt(&checked_shard_mode(db, &lower, &file, true)?, &id)
}
fn insert_batch(db: &mut Connection, records: &[ExactReceipt]) -> Result<()> {
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    for record in records {
        let id = logical(&record.namespace, &record.key);
        if let Some(previous) = shard_receipt(&tx, &id)? {
            if previous != record.bytes {
                return Err(invalid("exact receipt replay conflict"));
            }
        } else {
            let fingerprint: Vec<u8> = tx
                .query_row(
                    "SELECT fingerprint FROM receipt_totals WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .map_err(error)?;
            if fingerprint.len() != 32 {
                return Err(invalid("receipt totals digest malformed"));
            }
            tx.execute(
                "INSERT INTO receipt_rows SELECT ?1,?2,?3,?4,?5,records+1 FROM receipt_totals WHERE singleton=1",
                params![
                    id,
                    record.namespace,
                    record.key,
                    record.bytes,
                    digest(&record.bytes)
                ],
            )
            .map_err(error)?;
            tx.execute("UPDATE receipt_totals SET records=records+1,bytes=bytes+?1,fingerprint=?2 WHERE singleton=1", params![(record.bytes.len()+id.len()+64) as i64,xor(&fingerprint,&identity_digest(&id,&record.bytes))]).map_err(error)?;
        }
    }
    tx.commit().map_err(error)
}
fn totals(db: &Connection, file: &str) -> Result<(i64, i64, Vec<u8>)> {
    shard_totals(&open_shard(&resolve_file(db, file)?, false)?)
}
fn shard_totals(db: &Connection) -> Result<(i64, i64, Vec<u8>)> {
    db
        .query_row(
            "SELECT records,bytes,CASE WHEN length(fingerprint)=32 THEN fingerprint END FROM receipt_totals WHERE singleton=1 AND records>=0 AND bytes>=0",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(error)
}
#[derive(Clone)]
struct Migration {
    lower: String,
    source: String,
    pivot: Option<String>,
    left: String,
    right: Option<String>,
    cursor: Option<String>,
    upper: String,
}
fn migration(db: &Connection) -> Result<Option<Migration>> {
    db.query_row("SELECT lower_key,source,pivot,left_file,right_file,cursor,upper_key FROM receipt_migration WHERE singleton=1", [], |r| Ok(Migration { lower:r.get(0)?,source:r.get(1)?,pivot:r.get(2)?,left:r.get(3)?,right:r.get(4)?,cursor:r.get(5)?,upper:r.get(6)? })).optional().map_err(error)
}
fn target<'a>(migration: &'a Migration, id: &str) -> &'a str {
    if migration
        .pivot
        .as_ref()
        .is_some_and(|pivot| id >= pivot.as_str())
    {
        migration.right.as_deref().unwrap()
    } else {
        &migration.left
    }
}

/// Complete a prepared commit before serving any operation. It is safe to
/// repeat after failure at every boundary: receipt inserts compare exact bytes.
pub(crate) fn recover(db: &mut Connection) -> Result<()> {
    let prepared: Option<(String,Revision,Vec<u8>,Vec<u8>,i64,Vec<u8>)> = db.query_row("SELECT state_key,generation,CASE WHEN length(body)<=33554432 THEN body END,digest,records,fingerprint FROM receipt_prepare WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(error)?;
    let Some((state_key, generation, body, sha, expected_records, expected_fingerprint)) = prepared
    else {
        if db
            .query_row("SELECT 1 FROM receipt_prepare_rows UNION ALL SELECT 1 FROM receipt_prepare_routes LIMIT 1", [], |r| {
                r.get::<_, i64>(0)
            })
            .optional()
            .map_err(error)?
            .is_some()
        {
            return Err(invalid("receipt redo rows have no owning commit"));
        }
        return Ok(());
    };
    verify(&body, &sha)?;
    let current: (Revision, Vec<u8>, Vec<u8>) = db
        .query_row(
            "SELECT generation,CASE WHEN length(bytes)<=33554432 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM current_state WHERE key=?1",
            [&state_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(error)?;
    if current != (generation, body.clone(), sha.clone())
        || expected_records < 0
        || expected_records > 4096
        || expected_fingerprint.len() != 32
    {
        return Err(invalid(
            "prepared receipt commit differs from current authority",
        ));
    }
    let mut observed_records = 0i64;
    let mut observed_fingerprint = vec![0; 32];
    let migrating = migration(db)?;
    let mut cursor = String::new();
    let mut touched = std::collections::BTreeSet::new();
    loop {
        let mut groups = std::collections::BTreeMap::<String, Vec<ExactReceipt>>::new();
        let mut bytes = 0;
        let mut count = 0;
        while count < 128 && bytes < PAGE_BYTES {
            let row: Option<(String,String,String,Vec<u8>,Vec<u8>)> = db.query_row("SELECT id,namespace,receipt_key,CASE WHEN length(body)<=33554432 THEN body END,digest FROM receipt_prepare_rows WHERE id>?1 ORDER BY id LIMIT 1", [&cursor], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(error)?;
            let Some((id, namespace, key, body, sha)) = row else {
                break;
            };
            verify(&body, &sha)?;
            observed_records += 1;
            observed_fingerprint = xor(&observed_fingerprint, &identity_digest(&id, &body));
            if id != logical(&namespace, &key) {
                return Err(invalid("prepared receipt binding mismatch"));
            }
            let (lower, file) = route(db, &id)?;
            bytes += body.len();
            count += 1;
            let record = ExactReceipt {
                namespace,
                key,
                bytes: body,
            };
            if let Some(migration) = &migrating {
                if migration.source == file {
                    groups
                        .entry(target(migration, &id).into())
                        .or_default()
                        .push(record.clone());
                }
            }
            groups.entry(file).or_default().push(record);
            touched.insert(lower);
            cursor = id;
        }
        if count == 0 {
            break;
        }
        for (file, records) in groups {
            insert_batch(&mut open_shard(&resolve_file(db, &file)?, false)?, &records)?;
        }
    }
    if observed_records != expected_records || observed_fingerprint != expected_fingerprint {
        return Err(invalid("prepared receipt set is incomplete or changed"));
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let expected_routes: i64 = tx
        .query_row("SELECT count(*) FROM receipt_prepare_routes", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    if expected_routes != touched.len() as i64 {
        return Err(invalid(
            "prepared receipt routing set is incomplete or changed",
        ));
    }
    for lower in touched {
        let (_, file) = route(&tx, &lower)?;
        let expected: (String,i64,i64,Vec<u8>) = tx.query_row("SELECT file,records,bytes,CASE WHEN length(fingerprint)=32 THEN fingerprint END FROM receipt_prepare_routes WHERE lower_key=?1", [&lower], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(error)?;
        let (records, bytes, fingerprint) = totals(&tx, &file)?;
        if expected != (file.clone(), records, bytes, fingerprint.clone()) {
            return Err(invalid(
                "prepared receipt partition is incomplete or changed",
            ));
        }
        routes::put(
            &tx,
            "routes",
            routes::Route {
                lower,
                file,
                records,
                bytes,
                fingerprint,
            },
        )?;
    }
    tx.execute("INSERT INTO current_state(key,generation,bytes,digest) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,bytes=excluded.bytes,digest=excluded.digest",params![state_key,generation,body,sha]).map_err(error)?;
    tx.execute_batch("DELETE FROM receipt_prepare_rows; DELETE FROM receipt_prepare_routes; DELETE FROM receipt_prepare;")
        .map_err(error)?;
    tx.commit().map_err(error)
}

pub(crate) fn commit(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
) -> Result<Revision> {
    let expected = expected.into();
    recover(db)?;
    let generation = prepare(db, key, expected, bytes, records)?;
    recover(db)?;
    Ok(generation)
}

pub(crate) fn commit_with_work(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
    work: &[crate::indexed_work::WorkChange],
) -> Result<Revision> {
    let expected = expected.into();
    commit_operation(db, key, expected, bytes, records, work, None)
}

pub(crate) fn commit_operation(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
    work: &[crate::indexed_work::WorkChange],
    operation: Option<&str>,
) -> Result<Revision> {
    let expected = expected.into();
    recover(db)?;
    if let Some(operation) = operation {
        if let Some(generation) =
            crate::indexed_commit::replay(db, key, operation, expected, bytes, records, work)?
        {
            return Ok(generation);
        }
    }
    let generation = prepare_with_operation(db, key, expected, bytes, records, work, operation)?;
    recover(db)?;
    Ok(generation)
}

fn prepare(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
) -> Result<Revision> {
    let expected = expected.into();
    prepare_with_work(db, key, expected, bytes, records, &[])
}

fn prepare_with_work(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
    work: &[crate::indexed_work::WorkChange],
) -> Result<Revision> {
    let expected = expected.into();
    prepare_with_operation(db, key, expected, bytes, records, work, None)
}

fn prepare_with_operation(
    db: &mut Connection,
    key: &str,
    expected: impl Into<Revision>,
    bytes: &[u8],
    records: &[ExactReceipt],
    work: &[crate::indexed_work::WorkChange],
    operation: Option<&str>,
) -> Result<Revision> {
    let expected = expected.into();
    let generation = expected.next()?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(error)?;
    let current: Option<Revision> = tx
        .query_row(
            "SELECT generation FROM current_state WHERE key=?1",
            [key],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    if current.unwrap_or_default() != expected {
        return Err(invalid("stale indexed store generation"));
    }
    if !work.is_empty() {
        crate::indexed_work::apply(&tx, work)?;
    }
    let mut previous_shard: Option<(String, Connection)> = None;
    for record in records {
        let id = logical(&record.namespace, &record.key);
        let (lower, file) = route(&tx, &id)?;
        if previous_shard
            .as_ref()
            .is_none_or(|(path, _)| path != &file)
        {
            previous_shard = Some((file.clone(), checked_shard(&tx, &lower, &file)?));
        }
        let existing = shard_receipt(&previous_shard.as_ref().unwrap().1, &id)?;
        if let Some(previous) = &existing {
            if previous != &record.bytes {
                return Err(invalid("exact receipt replay conflict"));
            }
        }
        // Duplicate identities inside one transaction must compare too.
        let id = logical(&record.namespace, &record.key);
        let previous: Option<Vec<u8>> = tx
            .query_row(
                "SELECT body FROM receipt_prepare_rows WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        if previous.as_ref().is_some_and(|body| body != &record.bytes) {
            return Err(invalid("exact receipt replay conflict"));
        }
        let expected_route = routes::exact(&tx, "routes", &lower)?
            .ok_or_else(|| invalid("prepared route is missing"))?;
        tx.execute(
            "INSERT OR IGNORE INTO receipt_prepare_routes VALUES(?1,?2,?3,?4,?5)",
            params![
                lower,
                expected_route.file,
                expected_route.records,
                expected_route.bytes,
                expected_route.fingerprint
            ],
        )
        .map_err(error)?;
        if existing.is_none() && previous.is_none() {
            let fingerprint: Vec<u8> = tx
                .query_row(
                    "SELECT fingerprint FROM receipt_prepare_routes WHERE lower_key=?1",
                    [&lower],
                    |r| r.get(0),
                )
                .map_err(error)?;
            tx.execute("UPDATE receipt_prepare_routes SET records=records+1,bytes=bytes+?2,fingerprint=?3 WHERE lower_key=?1", params![lower,(record.bytes.len()+id.len()+64) as i64,xor(&fingerprint,&identity_digest(&id,&record.bytes))]).map_err(error)?;
        }
        tx.execute(
            "INSERT OR IGNORE INTO receipt_prepare_rows VALUES(?1,?2,?3,?4,?5)",
            params![
                id,
                record.namespace,
                record.key,
                record.bytes,
                digest(&record.bytes)
            ],
        )
        .map_err(error)?;
    }
    let mut prepared_count = 0i64;
    let mut prepared_fingerprint = vec![0; 32];
    {
        let mut query = tx
            .prepare("SELECT id,body FROM receipt_prepare_rows ORDER BY id")
            .map_err(error)?;
        let mut rows = query.query([]).map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let id: String = row.get(0).map_err(error)?;
            let body: Vec<u8> = row.get(1).map_err(error)?;
            prepared_count += 1;
            prepared_fingerprint = xor(&prepared_fingerprint, &identity_digest(&id, &body));
        }
    }
    tx.execute(
        "INSERT INTO receipt_prepare VALUES(1,?1,?2,?3,?4,?5,?6)",
        params![
            key,
            generation,
            bytes,
            digest(bytes),
            prepared_count,
            prepared_fingerprint
        ],
    )
    .map_err(error)?;
    // The root transaction is the durability point: current state and every
    // referenced new receipt body are durable together. Leaf materialization
    // can be repeated after death without replaying historical work.
    tx.execute("INSERT INTO current_state(key,generation,bytes,digest) VALUES(?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,bytes=excluded.bytes,digest=excluded.digest",params![key,generation,bytes,digest(bytes)]).map_err(error)?;
    if let Some(operation) = operation {
        crate::indexed_commit::record(
            &tx, key, operation, expected, generation, bytes, records, work,
        )?;
    }
    tx.commit().map_err(error)?;
    Ok(generation)
}

pub(crate) fn page(
    db: &Connection,
    namespace: &str,
    after: &str,
    limit: usize,
    budget: usize,
) -> Result<Vec<ExactReceipt>> {
    let mut cursor = logical(namespace, after);
    let (mut lower, mut file) = route(db, &cursor)?;
    let end = format!("{namespace}\u{1}");
    let mut records = Vec::new();
    let mut bytes = 0;
    loop {
        let shard = checked_shard(db, &lower, &file)?;
        let mut statement=shard.prepare("SELECT id,receipt_key,length(body) FROM receipt_rows WHERE id>?1 AND id<?2 ORDER BY id LIMIT ?3").map_err(error)?;
        let mut rows = statement
            .query(params![cursor, end, (limit - records.len()) as i64])
            .map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let length: i64 = row.get(2).map_err(error)?;
            if length < 0 || length as usize > MAX_BODY {
                return Err(invalid("invalid receipt size"));
            }
            if bytes + length as usize > budget {
                if records.is_empty() {
                    return Err(invalid(
                        "storage_pressure: receipt exceeds page byte capacity",
                    ));
                }
                return Ok(records);
            }
            cursor = row.get(0).map_err(error)?;
            let key: String = row.get(1).map_err(error)?;
            let body =
                shard_receipt(&shard, &cursor)?.ok_or_else(|| invalid("receipt disappeared"))?;
            bytes += body.len();
            records.push(ExactReceipt {
                namespace: namespace.into(),
                key,
                bytes: body,
            });
            if records.len() == limit {
                return Ok(records);
            }
        }
        let next = routes::next(db, "routes", Some(&lower))?
            .filter(|r| r.lower < end)
            .map(|r| (r.lower, r.file));
        let Some((next_lower, next_file)) = next else {
            return Ok(records);
        };
        lower = next_lower;
        file = next_file;
    }
}

/// Copy at most one bounded page per call. Concurrent writes are mirrored by
/// recover(); the source remains authoritative until verified atomic cutover.
pub(crate) fn maintain(db: &mut Connection, path: &Path) -> Result<()> {
    if let Some(m) = migration(db)? {
        let source = checked_shard(db, &m.lower, &m.source)?;
        let after = m.cursor.clone().unwrap_or_default();
        let mut statement=source.prepare("SELECT id,namespace,receipt_key,length(body) FROM receipt_rows WHERE id>?1 AND id<=?2 ORDER BY id LIMIT 128").map_err(error)?;
        let mut rows = statement.query(params![after, m.upper]).map_err(error)?;
        let mut cursor = None;
        let mut bytes = 0;
        let mut groups = std::collections::BTreeMap::<String, Vec<ExactReceipt>>::new();
        while let Some(row) = rows.next().map_err(error)? {
            let length: i64 = row.get(3).map_err(error)?;
            if length < 0 || length as usize > MAX_BODY {
                return Err(invalid("invalid migration record size"));
            }
            if cursor.is_some() && bytes + length as usize > PAGE_BYTES {
                break;
            }
            let id: String = row.get(0).map_err(error)?;
            let body = shard_receipt(&source, &id)?
                .ok_or_else(|| invalid("migration source disappeared"))?;
            groups
                .entry(target(&m, &id).into())
                .or_default()
                .push(ExactReceipt {
                    namespace: row.get(1).map_err(error)?,
                    key: row.get(2).map_err(error)?,
                    bytes: body,
                });
            bytes += length as usize;
            cursor = Some(id);
        }
        drop(rows);
        drop(statement);
        drop(source);
        for (file, records) in groups {
            insert_batch(&mut open_shard(&resolve_file(db, &file)?, false)?, &records)?;
        }
        if let Some(cursor) = cursor {
            db.execute(
                "UPDATE receipt_migration SET cursor=?1 WHERE singleton=1",
                [cursor],
            )
            .map_err(error)?;
            return Ok(());
        }
        let (count, size, sha) = totals(db, &m.source)?;
        let (a_count, a_size, a_sha) = totals(db, &m.left)?;
        let (b_count, b_size, b_sha) = match &m.right {
            Some(file) => totals(db, file)?,
            None => (0, 0, vec![0; 32]),
        };
        if count != a_count + b_count || size != a_size + b_size || sha != xor(&a_sha, &b_sha) {
            return Err(invalid("receipt partition verification failed"));
        }
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        routes::put(
            &tx,
            "routes",
            routes::Route {
                lower: m.lower.clone(),
                file: m.left,
                records: a_count,
                bytes: a_size,
                fingerprint: a_sha,
            },
        )?;
        if let (Some(pivot), Some(right)) = (&m.pivot, &m.right) {
            routes::put(
                &tx,
                "routes",
                routes::Route {
                    lower: pivot.clone(),
                    file: right.clone(),
                    records: b_count,
                    bytes: b_size,
                    fingerprint: b_sha,
                },
            )?;
        }
        routes::put(
            &tx,
            "retired",
            routes::Route::empty(m.source.clone(), m.source),
        )?;
        tx.execute("DELETE FROM receipt_migration", [])
            .map_err(error)?;
        tx.commit().map_err(error)?;
        return Ok(());
    }
    let backup_active: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM receipt_backup)", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    // An immutable backup root pins its entire reachable receipt prefix. There
    // is no foreground enumeration or ever-growing pin list in the root DB.
    let retired = if backup_active {
        None
    } else {
        routes::next(db, "retired", None)?.map(|r| r.file)
    };
    if let Some(file) = retired {
        let absolute = resolve_file(db, &file)?;
        for suffix in ["-wal", "-shm", ""] {
            match fs::remove_file(format!("{}{suffix}", absolute.display())) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(error(e)),
            }
        }
        fs::File::open(absolute.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(error)?;
        routes::remove(db, "retired", &file)?;
    }
    let threshold = db
        .query_row(
            "SELECT partition_bytes FROM receipt_storage_config WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(error)?;
    let oversized = routes::oversized(db, threshold)?.map(|r| (r.lower, r.file, r.records));
    if let Some((lower, file, count)) = oversized {
        let pivot: String = checked_shard(db, &lower, &file)?
            .query_row(
                "SELECT id FROM receipt_rows ORDER BY id LIMIT 1 OFFSET ?1",
                [count / 2],
                |r| r.get(0),
            )
            .map_err(error)?;
        let dir = directory(path)?;
        let left = local_name(path, &new_shard(&dir)?)?;
        let right = local_name(path, &new_shard(&dir)?)?;
        let upper: String = checked_shard(db, &lower, &file)?
            .query_row(
                "SELECT id FROM receipt_rows ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(error)?;
        db.execute(
            "INSERT INTO receipt_migration VALUES(1,?1,?2,?3,?4,?5,NULL,?6)",
            params![lower, file, pivot, left, right, upper],
        )
        .map_err(error)?;
    }
    Ok(())
}

pub(crate) fn relocate(db: &Connection, lower: &str, destination: &Path) -> Result<()> {
    if migration(db)?.is_some() {
        return Err(invalid(
            "storage_pressure: a receipt migration is already active",
        ));
    }
    crate::durable::verify_private_directory(destination)?;
    let source = routes::exact(db, "routes", lower)?
        .ok_or_else(|| invalid("relocation route is missing"))?
        .file;
    let target = new_shard(destination)?;
    let upper: String = checked_shard(db, lower, &source)?
        .query_row("SELECT coalesce(max(id),'') FROM receipt_rows", [], |r| {
            r.get(0)
        })
        .map_err(error)?;
    db.execute(
        "INSERT INTO receipt_migration VALUES(1,?1,?2,NULL,?3,NULL,NULL,?4)",
        params![lower, source, target, upper],
    )
    .map_err(error)?;
    Ok(())
}

pub(crate) fn partitions(
    db: &Connection,
    after: Option<&str>,
    limit: usize,
) -> Result<Vec<crate::indexed_store::ReceiptPartition>> {
    let mut cursor = after.map(str::to_owned);
    let mut result = Vec::new();
    while result.len() < limit {
        let Some(row) = routes::next(db, "routes", cursor.as_deref())? else {
            break;
        };
        cursor = Some(row.lower.clone());
        result.push(crate::indexed_store::ReceiptPartition {
            lower_key: row.lower,
            file: row.file,
            records: row.records as u64,
            bytes: row.bytes as u64,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexed_store::IndexedStore;
    fn fixture() -> (PathBuf, IndexedStore) {
        let root =
            std::env::temp_dir().join(format!("paperclip-partitions-{}", uuid::Uuid::new_v4()));
        let path = root.join("authority.sqlite");
        let store = IndexedStore::open(&path, "partition-test", true).unwrap();
        (path, store)
    }

    #[test]
    fn missing_committed_routing_head_cannot_bootstrap_an_empty_history() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"current".to_vec(), vec![record(0)])
            .unwrap();
        drop(store);
        let db = Connection::open(&path).unwrap();
        db.execute("DELETE FROM receipt_routing_heads WHERE name='routes'", [])
            .unwrap();
        drop(db);
        let error = IndexedStore::open(&path, "partition-test", false).unwrap_err();
        assert!(error.to_string().contains("routing authority is missing"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    fn record(i: u64) -> ExactReceipt {
        ExactReceipt {
            namespace: "session/tools".into(),
            key: format!("call-{i:020}"),
            bytes: format!("result-{i}").into_bytes(),
        }
    }

    #[test]
    fn revision_boundary_recovers_redo_replays_exactly_and_rejects_stale_writers() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"before".to_vec(), vec![record(0)])
            .unwrap();
        drop(store);
        let mut db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE current_state SET generation=?1 WHERE key='authority'",
            [i64::MAX],
        )
        .unwrap();
        let last = Revision::from(i64::MAX as u64);
        let current = prepare_with_operation(
            &mut db,
            "authority",
            last,
            b"accepted",
            &[record(1)],
            &[],
            Some("boundary-operation"),
        )
        .unwrap();
        assert!(matches!(current, Revision::Opaque(_)));
        // Root commit survived; the receipt leaf and original reply did not.
        drop(db);
        let store = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert_eq!(
            store.read_state("authority").unwrap().unwrap().generation,
            current
        );
        assert_eq!(
            store.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        assert_eq!(
            store.receipt("session/tools", &record(1).key).unwrap(),
            Some(record(1).bytes)
        );
        drop(store);
        let mut db = Connection::open(&path).unwrap();
        assert_eq!(
            commit_operation(
                &mut db,
                "authority",
                last,
                b"accepted",
                &[record(1)],
                &[],
                Some("boundary-operation")
            )
            .unwrap(),
            current
        );
        assert!(commit_operation(
            &mut db,
            "authority",
            last,
            b"changed",
            &[record(1)],
            &[],
            Some("boundary-operation")
        )
        .is_err());
        assert!(commit_operation(
            &mut db,
            "authority",
            Revision::from(1),
            b"accepted",
            &[record(1)],
            &[],
            Some("boundary-operation")
        )
        .is_err());
        assert!(commit_operation(
            &mut db,
            "authority",
            last,
            b"accepted",
            &[record(1)],
            &[],
            Some("stale-writer")
        )
        .is_err());
        let next = commit_operation(
            &mut db,
            "authority",
            current,
            b"continued",
            &[],
            &[],
            Some("next-operation"),
        )
        .unwrap();
        assert!(matches!(next, Revision::Opaque(_)));
        assert_ne!(current, next);
        assert!(commit_operation(
            &mut db,
            "authority",
            last,
            b"accepted",
            &[record(1)],
            &[],
            Some("boundary-operation")
        )
        .is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM current_commit", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        let store = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert_eq!(
            store.read_state("authority").unwrap().unwrap().generation,
            next
        );
        assert_eq!(
            store.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        drop(store);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn capacity_retry_reconciles_prepared_commit_and_does_not_apply_work_twice() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"before".to_vec(), vec![])
            .unwrap();
        drop(store);
        let mut db = Connection::open(&path).unwrap();
        let work = [crate::indexed_work::WorkChange {
            collection: "owners".into(),
            key: "owner-1".into(),
            expected_digest: None,
            bytes: Some(b"live".to_vec()),
        }];
        prepare_with_operation(
            &mut db,
            "authority",
            1,
            b"accepted",
            &[record(1)],
            &work,
            Some("attempt-1"),
        )
        .unwrap();
        // Simulate a lost reply after the durability point, before the receipt
        // leaf was materialized. Retry must recover redo and preserve gen 2.
        assert_eq!(
            commit_operation(
                &mut db,
                "authority",
                1,
                b"accepted",
                &[record(1)],
                &work,
                Some("attempt-1")
            )
            .unwrap(),
            2
        );
        assert_eq!(
            receipt(&db, "session/tools", &record(1).key).unwrap(),
            Some(record(1).bytes)
        );
        assert_eq!(
            crate::indexed_work::get(&db, "owners", "owner-1")
                .unwrap()
                .unwrap()
                .bytes,
            b"live"
        );
        assert!(commit_operation(
            &mut db,
            "authority",
            1,
            b"changed",
            &[record(1)],
            &work,
            Some("attempt-1")
        )
        .is_err());
        assert!(commit_operation(
            &mut db,
            "authority",
            1,
            b"accepted",
            &[record(2)],
            &work,
            Some("attempt-1")
        )
        .is_err());
        assert!(commit_operation(
            &mut db,
            "authority",
            1,
            b"accepted",
            &[record(1)],
            &[],
            Some("attempt-1")
        )
        .is_err());
        // A different writer cannot reuse the operation's old expected gen.
        assert!(commit_operation(
            &mut db,
            "authority",
            1,
            b"accepted",
            &[record(1)],
            &work,
            Some("different-owner")
        )
        .is_err());
        commit_operation(
            &mut db,
            "authority",
            2,
            b"new owner",
            &[],
            &[],
            Some("attempt-2"),
        )
        .unwrap();
        assert!(commit_operation(
            &mut db,
            "authority",
            1,
            b"accepted",
            &[record(1)],
            &work,
            Some("attempt-1")
        )
        .is_err());
        assert_eq!(
            db.query_row("SELECT count(*) FROM current_commit", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(db);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn process_death_after_prepare_and_partial_leaf_commit_recovers_exactly() {
        use std::os::unix::process::ExitStatusExt;
        const CHILD: &str = "PAPERCLIP_RECEIPT_CRASH_TEST";
        if let Ok(path) = std::env::var(CHILD) {
            let path = PathBuf::from(path);
            let store = IndexedStore::open(&path, "crash-test", true).unwrap();
            store
                .commit("authority", 0, b"old".to_vec(), vec![record(0)])
                .unwrap();
            drop(store);
            let mut db = Connection::open(&path).unwrap();
            prepare(
                &mut db,
                "authority",
                1,
                b"accepted",
                &[record(1), record(2)],
            )
            .unwrap();
            if std::env::var("PAPERCLIP_RECEIPT_CRASH_PHASE").unwrap() == "leaf" {
                let (_, file) = route(&db, &logical("session/tools", &record(1).key)).unwrap();
                insert_batch(
                    &mut open_shard(&resolve_file(&db, &file).unwrap(), false).unwrap(),
                    &[record(1)],
                )
                .unwrap();
            }
            // SIGKILL the isolated test child: no destructors or final database
            // checkpoint can rescue durability on this path.
            std::process::Command::new("/bin/kill")
                .args(["-KILL", &std::process::id().to_string()])
                .status()
                .unwrap();
            panic!("test child survived SIGKILL");
        }
        for phase in ["prepare", "leaf"] {
            let root = std::env::temp_dir().join(format!("receipt-crash-{}", uuid::Uuid::new_v4()));
            let path = root.join("state.sqlite");
            let status=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact","indexed_partitions::tests::process_death_after_prepare_and_partial_leaf_commit_recovers_exactly","--nocapture"])
                .env(CHILD,&path).env("PAPERCLIP_RECEIPT_CRASH_PHASE",phase)
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().unwrap();
            assert_eq!(status.signal(), Some(9));
            let store = IndexedStore::open(&path, "crash-test", false).unwrap();
            assert_eq!(
                store.read_state("authority").unwrap().unwrap().bytes,
                b"accepted"
            );
            for i in 0..3 {
                assert_eq!(
                    store.receipt("session/tools", &record(i).key).unwrap(),
                    Some(record(i).bytes)
                );
            }
            drop(store);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn exhausted_root_capacity_preserves_previous_authority_and_reports_pressure() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"old".to_vec(), vec![record(0)])
            .unwrap();
        drop(store);
        let mut db = Connection::open(&path).unwrap();
        let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        db.execute_batch(&format!("PRAGMA max_page_count={pages};"))
            .unwrap();
        let large = ExactReceipt {
            bytes: vec![8; 2 * 1024 * 1024],
            ..record(1)
        };
        let failure = prepare(&mut db, "authority", 1, b"new", &[large]).unwrap_err();
        assert!(
            failure.to_string().starts_with("storage_pressure:"),
            "{failure}"
        );
        assert_eq!(
            db.query_row(
                "SELECT generation FROM current_state WHERE key='authority'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM receipt_prepare", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            receipt(&db, "session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        drop(db);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn tiny_receipt_batches_do_not_outgrow_partition_maintenance() {
        let (path, store) = fixture();
        let db = Connection::open(&path).unwrap();
        const PARTITION_BYTES: i64 = 64 * 1024;
        db.execute(
            "UPDATE receipt_storage_config SET partition_bytes=?1",
            [PARTITION_BYTES],
        )
        .unwrap();
        // Each batch is the admitted row limit but has no body bytes. Byte-only
        // maintenance credits copy just 128 rows while admitting another 4096.
        // Check immediately after writes, without idle time or manual drains.
        for batch in 0..8u64 {
            let records = (batch * 4096..(batch + 1) * 4096)
                .map(|id| ExactReceipt {
                    namespace: "small".into(),
                    key: format!("receipt-{id:020}"),
                    bytes: Vec::new(),
                })
                .collect();
            store
                .commit("authority", batch, b"current".to_vec(), records)
                .unwrap();
            let mut largest = 0;
            let mut cursor = None;
            while let Some(row) = routes::next(&db, "routes", cursor.as_deref()).unwrap() {
                cursor = Some(row.lower);
                largest = largest.max(row.bytes);
            }
            assert!(
                largest <= PARTITION_BYTES * 8,
                "batch {batch}: live partition grew to {largest} bytes"
            );
        }
        assert_eq!(
            store
                .receipt("small", "receipt-00000000000000000000")
                .unwrap(),
            Some(Vec::new())
        );
        assert_eq!(
            store
                .receipt("small", "receipt-00000000000000032767")
                .unwrap(),
            Some(Vec::new())
        );
        drop(db);
        drop(store);
        let reopened = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert_eq!(
            reopened
                .read_state("authority")
                .unwrap()
                .unwrap()
                .generation,
            8
        );
        assert_eq!(
            reopened
                .receipt("small", "receipt-00000000000000000000")
                .unwrap(),
            Some(Vec::new())
        );
        drop(reopened);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn tiny_partitions_split_with_concurrent_writes_and_keep_ancient_replay_and_pages() {
        let (path, store) = fixture();
        let db = Connection::open(&path).unwrap();
        db.execute("UPDATE receipt_storage_config SET partition_bytes=1024", [])
            .unwrap();
        for generation in 0..100 {
            store
                .commit(
                    "authority",
                    generation,
                    b"bounded".to_vec(),
                    (generation * 10..generation * 10 + 10)
                        .map(record)
                        .collect(),
                )
                .unwrap();
        }
        for _ in 0..800 {
            store.maintain().unwrap();
        }
        let partitions = partitions(&db, None, 1000).unwrap().len();
        assert!(partitions > 20, "only {partitions} partitions");
        assert_eq!(
            store.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        let mut cursor = String::new();
        let mut seen = 0;
        loop {
            let page = store
                .receipt_page("session/tools", &cursor, 17, MAX_BODY)
                .unwrap();
            if page.is_empty() {
                break;
            }
            for entry in &page {
                assert_eq!(entry.bytes, record(seen).bytes);
                seen += 1;
            }
            cursor = page.last().unwrap().key.clone();
        }
        assert_eq!(seen, 1000);
        drop(db);
        drop(store);
        let reopened = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert_eq!(
            reopened
                .read_state("authority")
                .unwrap()
                .unwrap()
                .generation,
            100
        );
        assert_eq!(
            reopened.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        let mut conflict = record(0);
        conflict.bytes = b"different".to_vec();
        assert!(reopened
            .commit("authority", 100, b"bad".to_vec(), vec![conflict])
            .is_err());
        drop(reopened);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn prepared_commit_rolls_forward_after_reopen_and_missing_partition_never_means_absence() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"old".to_vec(), vec![record(0)])
            .unwrap();
        drop(store);
        // Simulate death after durable intent, before all leaf writes/current
        // publication. Opening must finish the same accepted transaction.
        let mut db = Connection::open(&path).unwrap();
        let r = record(1);
        prepare(&mut db, "authority", 1, b"new", std::slice::from_ref(&r)).unwrap();
        drop(db);
        let reopened = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert_eq!(
            reopened.read_state("authority").unwrap().unwrap().bytes,
            b"new"
        );
        assert_eq!(
            reopened.receipt(&r.namespace, &r.key).unwrap(),
            Some(r.bytes)
        );
        drop(reopened);
        let db = Connection::open(&path).unwrap();
        let (_, file) = route(&db, "session/tools\0call").unwrap();
        fs::remove_file(resolve_file(&db, &file).unwrap()).unwrap();
        drop(db);
        let reopened = IndexedStore::open(&path, "partition-test", false).unwrap();
        assert!(reopened.receipt("session/tools", &record(0).key).is_err());
        drop(reopened);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn relocation_survives_restart_mid_copy_and_preserves_relative_archive_paths() {
        let (path, store) = fixture();
        store
            .commit(
                "authority",
                0,
                b"current".to_vec(),
                (0..300).map(record).collect(),
            )
            .unwrap();
        let volume = path.parent().unwrap().join("volume");
        fs::create_dir(&volume).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&volume, fs::Permissions::from_mode(0o700)).unwrap();
        }
        store.relocate_partition("", &volume).unwrap();
        store.maintain().unwrap();
        drop(store);
        let reopened = IndexedStore::open(&path, "partition-test", false).unwrap();
        reopened
            .commit("authority", 1, b"continued".to_vec(), vec![record(301)])
            .unwrap();
        for _ in 0..10 {
            reopened.maintain().unwrap();
        }
        assert_eq!(
            reopened.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        assert_eq!(
            reopened.receipt("session/tools", &record(301).key).unwrap(),
            Some(record(301).bytes)
        );
        let db = Connection::open(&path).unwrap();
        assert_eq!(migration(&db).unwrap().map(|_| ()), None);
        let (_, file) = route(&db, "session/tools\0call").unwrap();
        assert!(Path::new(&file).starts_with(volume.canonicalize().unwrap()));
        drop(db);
        drop(reopened);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn incomplete_redo_and_stale_current_generation_fail_closed() {
        for fault in [
            "missing_receipt",
            "changed_generation",
            "orphan_receipt",
            "missing_route",
        ] {
            let (path, store) = fixture();
            store
                .commit("authority", 0, b"old".to_vec(), vec![record(0)])
                .unwrap();
            drop(store);
            let mut db = Connection::open(&path).unwrap();
            prepare(&mut db, "authority", 1, b"new", &[record(1)]).unwrap();
            match fault {
                "missing_receipt" => db.execute("DELETE FROM receipt_prepare_rows", []).unwrap(),
                "changed_generation" => db
                    .execute("UPDATE current_state SET generation=3", [])
                    .unwrap(),
                "missing_route" => db
                    .execute("DELETE FROM receipt_prepare_routes", [])
                    .unwrap(),
                _ => db.execute("DELETE FROM receipt_prepare", []).unwrap(),
            };
            drop(db);
            assert!(
                IndexedStore::open(&path, "partition-test", false).is_err(),
                "accepted {fault}"
            );
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn replaced_partition_cannot_turn_ancient_replay_into_a_new_effect() {
        for during_redo in [false, true] {
            let (path, store) = fixture();
            store
                .commit("authority", 0, b"current".to_vec(), vec![record(0)])
                .unwrap();
            drop(store);
            let mut db = Connection::open(&path).unwrap();
            if during_redo {
                prepare(&mut db, "authority", 1, b"new", &[record(1)]).unwrap();
            }
            let (_, file) = route(&db, "session/tools\0call").unwrap();
            let shard = open_shard(&resolve_file(&db, &file).unwrap(), false).unwrap();
            shard.execute_batch("DELETE FROM receipt_rows; UPDATE receipt_totals SET records=0,bytes=0,fingerprint=zeroblob(32);").unwrap();
            drop(shard);
            drop(db);
            let reopened = IndexedStore::open(&path, "partition-test", false);
            if during_redo {
                assert!(reopened.is_err());
            } else {
                let reopened = reopened.unwrap();
                assert!(reopened.receipt("session/tools", &record(0).key).is_err());
                assert!(reopened
                    .commit("authority", 1, b"new".to_vec(), vec![record(0)])
                    .is_err());
                assert_eq!(
                    reopened
                        .read_state("authority")
                        .unwrap()
                        .unwrap()
                        .generation,
                    1
                );
            }
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn local_partition_routes_survive_directory_archive_without_rewriting_history() {
        let (path, store) = fixture();
        store
            .commit("authority", 0, b"current".to_vec(), vec![record(0)])
            .unwrap();
        drop(store);
        let archived = path.parent().unwrap().with_extension("archived");
        fs::rename(path.parent().unwrap(), &archived).unwrap();
        let reopened =
            IndexedStore::open(&archived.join("authority.sqlite"), "partition-test", false)
                .unwrap();
        assert_eq!(
            reopened.receipt("session/tools", &record(0).key).unwrap(),
            Some(record(0).bytes)
        );
        drop(reopened);
        fs::remove_dir_all(archived).unwrap();
    }
}
