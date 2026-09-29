//! Transactional current state and exact, disk-backed replay receipts.
//!
//! The connection lives on one bounded storage executor. A successful reply is
//! a FULL-synchronous WAL commit, never just admission to an in-memory queue.
//! Reading current state does not enumerate receipts. Callers own their
//! authenticated namespace and must not turn storage errors into cache misses.

use crate::indexed_revision::Revision;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::durable::verify_private_directory;
use crate::durable::DurableRunnerError;

const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;
const MAX_COMMIT_BYTES: usize = 64 * 1024 * 1024;
const MAX_COMMIT_RECEIPTS: usize = 4_096;
const MAX_KEY_BYTES: usize = 1_024;

/// SQLite must own every descriptor for its database and sidecars. On POSIX,
/// closing even a read-only probe descriptor cancels this process's SQLite
/// locks, including the WAL dead-man switch. A later reader can then truncate
/// SHM underneath a live writer. Metadata checks do not open those files; the
/// SQLite connection itself supplies NOFOLLOW and the surrounding lifetime
/// fence prevents managed relocation. See sqlite.org/howtocorrupt.html#_2_2.
pub(crate) fn verify_sqlite_file(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "durable state path is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "durable state file is accessible by group or other users",
            ));
        }
    }
    Ok(())
}

type Result<T> = std::result::Result<T, DurableRunnerError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSnapshot {
    pub generation: Revision,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ExactReceipt {
    pub namespace: String,
    pub key: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ReceiptPartition {
    pub lower_key: String,
    pub file: String,
    pub records: u64,
    pub bytes: u64,
}

enum Request {
    #[cfg(test)]
    TestCapacity(bool, mpsc::Sender<Result<()>>),
    ReadWork(
        String,
        String,
        mpsc::Sender<Result<Option<crate::indexed_work::WorkRecord>>>,
    ),
    WorkPage(
        String,
        String,
        usize,
        mpsc::Sender<Result<Vec<crate::indexed_work::WorkRecord>>>,
    ),
    ReadState(String, mpsc::Sender<Result<Option<StoredSnapshot>>>),
    ReadReceipt(String, String, mpsc::Sender<Result<Option<Vec<u8>>>>),
    ReadPage(
        String,
        String,
        usize,
        usize,
        mpsc::Sender<Result<Vec<ExactReceipt>>>,
    ),
    Commit {
        operation: String,
        key: String,
        expected_generation: Revision,
        bytes: Vec<u8>,
        receipts: Vec<ExactReceipt>,
        work: Vec<crate::indexed_work::WorkChange>,
        reply: mpsc::Sender<Result<Revision>>,
    },
    Maintain(mpsc::Sender<Result<()>>),
    Relocate(String, PathBuf, mpsc::Sender<Result<()>>),
    BeginBackup(PathBuf, String, mpsc::Sender<Result<()>>),
    BackupStep(mpsc::Sender<Result<bool>>),
    Partitions(
        Option<String>,
        usize,
        mpsc::Sender<Result<Vec<ReceiptPartition>>>,
    ),
    Close,
}

struct Executor {
    sender: mpsc::SyncSender<Request>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for Executor {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Close);
        if let Ok(thread) = self.thread.get_mut() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Clones share an executor, not an independently writable receipt cache.
#[derive(Clone)]
pub struct IndexedStore {
    path: PathBuf,
    executor: Arc<Executor>,
}

impl std::fmt::Debug for IndexedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexedStore")
            .field("path", &self.path)
            .finish()
    }
}

impl PartialEq for IndexedStore {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

impl IndexedStore {
    #[cfg(test)]
    pub(crate) fn test_capacity(&self, full: bool) {
        let (tx, rx) = mpsc::channel();
        self.executor
            .sender
            .send(Request::TestCapacity(full, tx))
            .unwrap();
        rx.recv().unwrap().unwrap();
    }
    fn retry<T>(&self, request: impl Fn(mpsc::Sender<Result<T>>) -> Request) -> Result<T> {
        loop {
            crate::storage_capacity::check_cancelled()?;
            let (tx, rx) = mpsc::channel();
            self.executor
                .sender
                .send(request(tx))
                .map_err(storage_error)?;
            match rx.recv().map_err(storage_error)? {
                Err(error) if crate::storage_capacity::wait(&error)? => continue,
                result => return result,
            }
        }
    }
    /// `create` is false when reopening an activated store: missing durable
    /// storage must never be silently replaced with an empty receipt ledger.
    pub fn open(path: &Path, binding: &str, create: bool) -> Result<Self> {
        crate::storage_capacity::retry(|| Self::open_once(path, binding, create, false))
    }

    /// Maintenance admission requires every execution connection to be closed.
    /// The exclusive lifetime remains owned until this handle and its worker close.
    pub(crate) fn open_quiescent(path: &Path, binding: &str) -> Result<Self> {
        Self::open_once(path, binding, false, true)
    }

    fn open_once(path: &Path, binding: &str, create: bool, exclusive: bool) -> Result<Self> {
        validate_key(binding)?;
        let parent = path
            .parent()
            .ok_or_else(|| invalid("store has no parent"))?;
        if create && !parent.exists() {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(parent).map_err(storage_error)?;
        }
        verify_private_directory(parent)?;
        // Acquire before reserving/opening any SQLite file and keep it through
        // the worker's final checkpoint and Connection::drop.
        let lifetime = if exclusive {
            crate::indexed_lifetime::StoreLifetime::exclusive(path)?
        } else {
            crate::indexed_lifetime::StoreLifetime::shared(path)?
        };
        if exclusive
            && match fs::symlink_metadata(crate::indexed_lifetime::archive_fence(path)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                _ => true,
            }
        {
            return Err(invalid("indexed archive must finish before snapshot"));
        }
        // Reserve with private permissions before SQLite can create sidecars.
        // Never follow a pre-existing symlink, including one for WAL or SHM.
        if create {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(file) => file.sync_all().map_err(storage_error)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(storage_error(error)),
            }
        }
        for suffix in ["", "-wal", "-shm"] {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            match crate::indexed_store::verify_sqlite_file(Path::new(&name)) {
                Ok(_) => {}
                Err(error)
                    if !suffix.is_empty() && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(storage_error(error)),
            }
        }
        let (sender, receiver) = mpsc::sync_channel(8);
        let (ready_tx, ready_rx) = mpsc::channel();
        // macOS exposes /var through a symlink. Resolve the already-verified
        // directory, while retaining NOFOLLOW protection for the database.
        let worker_path = parent.canonicalize().map_err(storage_error)?.join(
            path.file_name()
                .ok_or_else(|| invalid("store has no filename"))?,
        );
        let binding = binding.to_owned();
        let worker = thread::Builder::new()
            .name("runner-storage".into())
            .spawn(move || {
                let _lifetime = lifetime;
                let startup_lock =
                    match crate::indexed_partitions::PartitionLock::acquire(&worker_path) {
                        Ok(lock) => lock,
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                            return;
                        }
                    };
                let mut db = match open_database(&worker_path, &binding, create) {
                    Ok(db) => {
                        let _ = ready_tx.send(Ok(()));
                        db
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                drop(startup_lock);
                let partitioned = db
                    .query_row(
                        "SELECT schema_version FROM store_binding WHERE singleton=1",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
                    == 2;
                let mut routing_collector = crate::indexed_partitions::RoutingCollector::default();
                let mut pending_request = None;
                loop {
                    let request = match pending_request
                        .take()
                        .map(Ok)
                        .unwrap_or_else(|| receiver.recv_timeout(Duration::from_millis(100)))
                    {
                        Ok(request) => request,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if partitioned {
                                if let Ok(_lock) =
                                    crate::indexed_partitions::PartitionLock::acquire(&worker_path)
                                {
                                    if crate::indexed_partitions::recover(&mut db).is_ok() {
                                        let _ = crate::indexed_partitions::maintain(
                                            &mut db,
                                            &worker_path,
                                        );
                                        for _ in 0..16 {
                                            // Yield between GC pages if foreground work
                                            // arrived after the idle timer fired.
                                            match receiver.try_recv() {
                                                Ok(request) => {
                                                    pending_request = Some(request);
                                                    break;
                                                }
                                                Err(mpsc::TryRecvError::Disconnected) => break,
                                                Err(mpsc::TryRecvError::Empty) => {}
                                            }
                                            if routing_collector.step(&db).is_err() {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                    };
                    let lock = crate::indexed_partitions::PartitionLock::acquire(&worker_path);
                    let ready = lock
                        .as_ref()
                        .map(|_| ())
                        .map_err(|e| invalid(&e.to_string()))
                        .and_then(|_| {
                            if partitioned {
                                crate::indexed_partitions::recover(&mut db)
                            } else {
                                Ok(())
                            }
                        });
                    match request {
                        #[cfg(test)]
                        Request::TestCapacity(full, reply) => {
                            let result = (|| {
                                let pages: i64 = if full {
                                    db.query_row("PRAGMA page_count", [], |row| row.get(0))
                                        .map_err(storage_error)?
                                } else {
                                    1_073_741_823
                                };
                                db.pragma_update(None, "max_page_count", pages)
                                    .map_err(storage_error)
                            })();
                            let _ = reply.send(result);
                        }
                        Request::ReadWork(collection, key, reply) => {
                            let _ = reply
                                .send(ready.and_then(|_| {
                                    crate::indexed_work::get(&db, &collection, &key)
                                }));
                        }
                        Request::WorkPage(collection, after, limit, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                crate::indexed_work::page(&db, &collection, &after, limit)
                            }));
                        }
                        Request::ReadState(key, reply) => {
                            let _ = reply.send(ready.and_then(|_| read_state(&db, &key)));
                        }
                        Request::ReadReceipt(namespace, key, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if partitioned {
                                    crate::indexed_partitions::receipt(&db, &namespace, &key)
                                } else {
                                    read_receipt(&db, &namespace, &key)
                                }
                            }));
                        }
                        Request::ReadPage(namespace, after, limit, budget, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if partitioned {
                                    crate::indexed_partitions::page(
                                        &db, &namespace, &after, limit, budget,
                                    )
                                } else {
                                    read_page(&db, &namespace, &after, limit, budget)
                                }
                            }));
                        }
                        Request::Commit {
                            operation,
                            key,
                            expected_generation,
                            bytes,
                            receipts,
                            work,
                            reply,
                        } => {
                            let _ = reply.send(ready.and_then(|_| {
                                if partitioned {
                                    let generation = crate::indexed_partitions::commit_operation(
                                        &mut db,
                                        &key,
                                        expected_generation,
                                        &bytes,
                                        &receipts,
                                        &work,
                                        Some(&operation),
                                    )?;
                                    // A copy page stops at either 128 rows or 4 MiB. Reserve
                                    // work for both limits: small receipts can exhaust the row
                                    // budget without consuming a byte-derived credit. Fourfold
                                    // headroom also covers split publication and retired-file
                                    // cleanup. Work depends on this bounded commit, not history.
                                    let receipt_bytes = receipts
                                        .iter()
                                        .map(|record| record.bytes.len())
                                        .sum::<usize>();
                                    let maintenance_pages = 1
                                        + (receipt_bytes / (1024 * 1024)).max(receipts.len() / 32);
                                    for _ in 0..maintenance_pages {
                                        crate::indexed_partitions::maintain(&mut db, &worker_path)?;
                                    }
                                    // Charge collection to write maintenance before
                                    // replying. Reads never trigger filesystem cleanup
                                    // or leave it queued in front of the next read.
                                    // A cleanup failure cannot rewrite a committed
                                    // action's outcome; explicit maintenance reports it.
                                    for _ in 0..2 {
                                        if routing_collector.step(&db).is_err() {
                                            break;
                                        }
                                    }
                                    Ok(generation)
                                } else {
                                    if !work.is_empty() {
                                        return Err(invalid(
                                            "outstanding work requires indexed format 2",
                                        ));
                                    }
                                    commit_operation(
                                        &mut db,
                                        &key,
                                        expected_generation,
                                        &bytes,
                                        &receipts,
                                        Some(&operation),
                                    )
                                }
                            }));
                        }
                        Request::Maintain(reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if !partitioned {
                                    return Err(invalid(
                                        "partition maintenance requires indexed format 2",
                                    ));
                                }
                                crate::indexed_partitions::maintain(&mut db, &worker_path)?;
                                routing_collector.step(&db).map(|_| ())
                            }));
                        }
                        Request::Relocate(lower, destination, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if !partitioned {
                                    return Err(invalid(
                                        "partition relocation requires indexed format 2",
                                    ));
                                }
                                crate::indexed_partitions::relocate(&db, &lower, &destination)
                            }));
                        }
                        Request::BeginBackup(destination, filename, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if !partitioned {
                                    return Err(invalid("online backup requires indexed format 2"));
                                }
                                crate::indexed_partitions::begin_backup(
                                    &mut db,
                                    &destination,
                                    &filename,
                                )
                            }));
                        }
                        Request::BackupStep(reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if !partitioned {
                                    return Err(invalid("online backup requires indexed format 2"));
                                }
                                crate::indexed_partitions::backup_step(&mut db)
                            }));
                        }
                        Request::Partitions(after, limit, reply) => {
                            let _ = reply.send(ready.and_then(|_| {
                                if !partitioned {
                                    return Err(invalid(
                                        "partition inspection requires indexed format 2",
                                    ));
                                }
                                crate::indexed_partitions::partitions(&db, after.as_deref(), limit)
                            }));
                        }
                        Request::Close => break,
                    }
                }
                // No transaction escapes a request, so a reader cannot pin the WAL.
                let _ = db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            })
            .map_err(storage_error)?;
        if let Err(error) = ready_rx.recv().map_err(storage_error)? {
            let _ = worker.join();
            return Err(error);
        }
        Ok(Self {
            path: path.to_owned(),
            executor: Arc::new(Executor {
                sender,
                thread: Mutex::new(Some(worker)),
            }),
        })
    }

    /// Bounded maintenance is also driven between ordinary storage requests.
    pub fn maintain(&self) -> Result<()> {
        let (reply, receive) = mpsc::channel();
        self.executor
            .sender
            .send(Request::Maintain(reply))
            .map_err(storage_error)?;
        receive.recv().map_err(storage_error)?
    }

    /// Start or resume a snapshot into a new directory under a private parent.
    /// Live writes continue between bounded backup_step calls. The destination
    /// becomes visible only when every snapshot partition is verified.
    pub fn begin_backup(&self, destination: &Path) -> Result<()> {
        self.begin_named_backup(destination, "authority.sqlite")
    }
    pub(crate) fn begin_named_backup(&self, destination: &Path, filename: &str) -> Result<()> {
        let (reply, receive) = mpsc::channel();
        self.executor
            .sender
            .send(Request::BeginBackup(
                destination.to_owned(),
                filename.to_owned(),
                reply,
            ))
            .map_err(storage_error)?;
        receive.recv().map_err(storage_error)?
    }
    pub fn backup_step(&self) -> Result<bool> {
        let (reply, receive) = mpsc::channel();
        self.executor
            .sender
            .send(Request::BackupStep(reply))
            .map_err(storage_error)?;
        receive.recv().map_err(storage_error)?
    }

    pub fn partitions(&self, after: Option<&str>, limit: usize) -> Result<Vec<ReceiptPartition>> {
        if !(1..=128).contains(&limit) || after.is_some_and(|value| value.len() > 2049) {
            return Err(invalid("invalid partition page capacity"));
        }
        let (reply, receive) = mpsc::channel();
        self.executor
            .sender
            .send(Request::Partitions(after.map(str::to_owned), limit, reply))
            .map_err(storage_error)?;
        receive.recv().map_err(storage_error)?
    }

    /// Operator-selected private storage volume; logical receipt keys and the
    /// provider session remain unchanged throughout relocation.
    pub fn relocate_partition(&self, lower_key: &str, destination: &Path) -> Result<()> {
        let (reply, receive) = mpsc::channel();
        self.executor
            .sender
            .send(Request::Relocate(
                lower_key.into(),
                destination.to_owned(),
                reply,
            ))
            .map_err(storage_error)?;
        receive.recv().map_err(storage_error)?
    }

    /// Cursor pagination bounds allocation before reading each body. Keys are
    /// opaque; sequence callers use fixed-width decimal keys.
    pub fn receipt_page(
        &self,
        namespace: &str,
        after: &str,
        limit: usize,
        byte_budget: usize,
    ) -> Result<Vec<ExactReceipt>> {
        validate_key(namespace)?;
        if after.len() > MAX_KEY_BYTES
            || !(1..=128).contains(&limit)
            || byte_budget == 0
            || byte_budget > MAX_COMMIT_BYTES
        {
            return Err(invalid("invalid receipt page capacity"));
        }
        self.retry(|tx| Request::ReadPage(namespace.into(), after.into(), limit, byte_budget, tx))
    }

    pub fn read_state(&self, key: &str) -> Result<Option<StoredSnapshot>> {
        validate_key(key)?;
        self.retry(|tx| Request::ReadState(key.into(), tx))
    }

    pub fn receipt(&self, namespace: &str, key: &str) -> Result<Option<Vec<u8>>> {
        validate_key(namespace)?;
        validate_key(key)?;
        self.retry(|tx| Request::ReadReceipt(namespace.into(), key.into(), tx))
    }

    /// Commit current state and immutable receipts atomically. Generation zero
    /// means create, not overwrite. A stale owner cannot overwrite newer state.
    pub fn commit(
        &self,
        key: &str,
        expected_generation: impl Into<Revision>,
        bytes: Vec<u8>,
        receipts: Vec<ExactReceipt>,
    ) -> Result<Revision> {
        self.commit_with_work(key, expected_generation, bytes, receipts, vec![])
    }

    pub fn read_work(
        &self,
        collection: &str,
        key: &str,
    ) -> Result<Option<crate::indexed_work::WorkRecord>> {
        validate_key(collection)?;
        validate_key(key)?;
        self.retry(|tx| Request::ReadWork(collection.into(), key.into(), tx))
    }

    pub fn work_page(
        &self,
        collection: &str,
        after: &str,
        limit: usize,
    ) -> Result<Vec<crate::indexed_work::WorkRecord>> {
        validate_key(collection)?;
        if after.len() > 1024 || !(1..=128).contains(&limit) {
            return Err(invalid("invalid outstanding-work page"));
        }
        self.retry(|tx| Request::WorkPage(collection.into(), after.into(), limit, tx))
    }

    pub fn commit_with_work(
        &self,
        key: &str,
        expected_generation: impl Into<Revision>,
        bytes: Vec<u8>,
        receipts: Vec<ExactReceipt>,
        work: Vec<crate::indexed_work::WorkChange>,
    ) -> Result<Revision> {
        let expected_generation = expected_generation.into();
        validate_key(key)?;
        validate_bytes(&bytes)?;
        crate::indexed_work::validate(&work)?;
        let mut size = bytes.len()
            + work
                .iter()
                .map(|change| change.bytes.as_ref().map_or(0, Vec::len))
                .sum::<usize>();
        if receipts.len() > MAX_COMMIT_RECEIPTS {
            return Err(invalid("storage_pressure: transaction receipt bound"));
        }
        for receipt in &receipts {
            validate_key(&receipt.namespace)?;
            validate_key(&receipt.key)?;
            validate_bytes(&receipt.bytes)?;
            size = size
                .checked_add(receipt.bytes.len())
                .ok_or_else(|| invalid("transaction size overflow"))?;
        }
        if size > MAX_COMMIT_BYTES {
            return Err(invalid("storage_pressure: transaction byte bound"));
        }
        // Keep one exact storage request across capacity retries. The receipt
        // transaction owns this token; identical current bytes alone cannot
        // establish whether our write or another owner's write committed.
        let operation = uuid::Uuid::new_v4().to_string();
        self.retry(|tx| Request::Commit {
            operation: operation.clone(),
            key: key.into(),
            expected_generation,
            bytes: bytes.clone(),
            receipts: receipts.clone(),
            work: work.clone(),
            reply: tx,
        })
    }
}

/// Resolve one proof reference without creating, recovering or checkpointing a
/// store. The same lifetime and operation fences used by writers cover routing,
/// partition fingerprints and the expected current generation.
pub fn read_only_receipt(
    path: &Path,
    binding: &str,
    generation: impl Into<Revision>,
    namespace: &str,
    key: &str,
) -> Result<Option<Vec<u8>>> {
    let generation = generation.into();
    validate_key(namespace)?;
    validate_key(key)?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("store has no parent"))?;
    verify_private_directory(parent)?;
    let path = parent.canonicalize().map_err(storage_error)?.join(
        path.file_name()
            .ok_or_else(|| invalid("store has no filename"))?,
    );
    let _lifetime = crate::indexed_lifetime::StoreLifetime::existing_shared(&path)?;
    let _operation = crate::indexed_partitions::PartitionLock::existing(&path)?;
    for suffix in ["", "-wal", "-shm"] {
        match crate::indexed_store::verify_sqlite_file(Path::new(&format!(
            "{}{suffix}",
            path.display()
        ))) {
            Ok(_) => {}
            Err(e) if !suffix.is_empty() && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(storage_error(e)),
        }
    }
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(storage_error)?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096;")
        .map_err(storage_error)?;
    let stored: (i64, String) = db
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage_error)?;
    if stored.0 != 2 || stored.1 != binding {
        return Err(invalid("indexed store binding or schema mismatch"));
    }
    crate::indexed_partitions::validate_backup(&db)?;
    if db
        .query_row("SELECT 1 FROM receipt_prepare LIMIT 1", [], |_| Ok(()))
        .optional()
        .map_err(storage_error)?
        .is_some()
    {
        return Err(invalid(
            "indexed receipt preparation requires owner recovery",
        ));
    }
    if read_state(&db, "authority")?.map(|s| s.generation) != Some(generation) {
        return Err(invalid("stale indexed proof generation"));
    }
    crate::indexed_partitions::read_only_receipt(&db, namespace, key)
}

fn open_database(path: &Path, binding: &str, create: bool) -> Result<Connection> {
    // The bundled engine is qualified independently of host Node/system SQLite.
    if rusqlite::version_number() < 3_051_003 {
        return Err(invalid("SQLite build lacks the WAL-reset fix"));
    }
    let mut db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(storage_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    // Avoid repeated mid-transaction fsyncs when a bounded admitted batch is
    // larger than the read cache. Dirty pages can exceed that cache only for
    // the current <=64 MiB transaction, never as a function of stored history.
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-4096; PRAGMA cache_spill=OFF; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;").map_err(storage_error)?;
    if create {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS store_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL, binding TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS current_state (key TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>0), bytes BLOB NOT NULL, digest BLOB NOT NULL) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS receipts (namespace TEXT NOT NULL, key TEXT NOT NULL, bytes BLOB NOT NULL, digest BLOB NOT NULL, PRIMARY KEY(namespace,key)) WITHOUT ROWID;").map_err(storage_error)?;
        tx.execute(
            "INSERT OR IGNORE INTO store_binding VALUES (1,2,?1)",
            [binding],
        )
        .map_err(storage_error)?;
        tx.commit().map_err(storage_error)?;
        #[cfg(unix)]
        fs::File::open(path.parent().unwrap())
            .and_then(|file| file.sync_all())
            .map_err(storage_error)?;
    }
    let stored: (i64, String) = db
        .query_row(
            "SELECT schema_version,binding FROM store_binding WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if ![1, 2].contains(&stored.0) || stored.1 != binding {
        return Err(invalid("indexed store binding or schema mismatch"));
    }
    crate::indexed_partitions::validate_backup(&db)?;
    crate::indexed_commit::initialize(&db)?;
    if stored.0 == 2 {
        crate::indexed_work::initialize(&db)?;
        if create {
            crate::indexed_partitions::initialize(&mut db, path)?;
        }
        crate::indexed_partitions::validate_routing(&db)?;
        crate::indexed_partitions::recover(&mut db)?;
    }
    Ok(db)
}

pub(crate) fn read_state(db: &Connection, key: &str) -> Result<Option<StoredSnapshot>> {
    // SQL guards allocation in the same snapshot, including a damaged or
    // externally modified file. Checking Vec::len after SELECT is too late.
    let row: Option<(Revision, Vec<u8>, Vec<u8>)> = db.query_row("SELECT generation,CASE WHEN length(bytes)<=?2 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM current_state WHERE key=?1", params![key, MAX_RECORD_BYTES as i64], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(storage_error)?;
    row.map(|(generation, bytes, digest)| {
        verify_digest(&bytes, &digest)?;
        Ok(StoredSnapshot {
            generation: Revision::try_from(generation).map_err(storage_error)?,
            bytes,
        })
    })
    .transpose()
}

fn read_receipt(db: &Connection, namespace: &str, key: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = db.query_row("SELECT CASE WHEN length(bytes)<=?3 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM receipts WHERE namespace=?1 AND key=?2", params![namespace,key,MAX_RECORD_BYTES as i64], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(storage_error)?;
    row.map(|(bytes, digest)| {
        verify_digest(&bytes, &digest)?;
        Ok(bytes)
    })
    .transpose()
}

fn read_page(
    db: &Connection,
    namespace: &str,
    after: &str,
    limit: usize,
    byte_budget: usize,
) -> Result<Vec<ExactReceipt>> {
    let mut statement = db.prepare("SELECT key,length(bytes) FROM receipts WHERE namespace=?1 AND key>?2 ORDER BY key LIMIT ?3").map_err(storage_error)?;
    let mut rows = statement
        .query(params![namespace, after, limit as i64])
        .map_err(storage_error)?;
    let mut result = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = rows.next().map_err(storage_error)? {
        let length =
            usize::try_from(row.get::<_, i64>(1).map_err(storage_error)?).map_err(storage_error)?;
        bytes = bytes
            .checked_add(length)
            .ok_or_else(|| invalid("receipt page size overflow"))?;
        if bytes > byte_budget {
            if result.is_empty() {
                return Err(invalid(
                    "storage_pressure: receipt exceeds page byte capacity",
                ));
            }
            break;
        }
        let key: String = row.get(0).map_err(storage_error)?;
        let body = read_receipt(db, namespace, &key)?
            .ok_or_else(|| invalid("indexed receipt disappeared"))?;
        result.push(ExactReceipt {
            namespace: namespace.into(),
            key,
            bytes: body,
        });
    }
    Ok(result)
}

fn commit_operation(
    db: &mut Connection,
    key: &str,
    expected: Revision,
    bytes: &[u8],
    receipts: &[ExactReceipt],
    operation: Option<&str>,
) -> Result<Revision> {
    if let Some(operation) = operation {
        if let Some(generation) =
            crate::indexed_commit::replay(db, key, operation, expected, bytes, receipts, &[])?
        {
            return Ok(generation);
        }
    }
    let generation = expected.next()?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let current: Option<Revision> = tx
        .query_row(
            "SELECT generation FROM current_state WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if current.unwrap_or_default() != expected {
        return Err(invalid("stale indexed store generation"));
    }
    for receipt in receipts {
        if let Some(existing) = read_receipt(&tx, &receipt.namespace, &receipt.key)? {
            if existing != receipt.bytes {
                return Err(invalid("exact receipt replay conflict"));
            }
        } else {
            tx.execute(
                "INSERT INTO receipts(namespace,key,bytes,digest) VALUES (?1,?2,?3,?4)",
                params![
                    receipt.namespace,
                    receipt.key,
                    receipt.bytes,
                    Sha256::digest(&receipt.bytes).as_slice()
                ],
            )
            .map_err(storage_error)?;
        }
    }
    tx.execute("INSERT INTO current_state(key,generation,bytes,digest) VALUES (?1,?2,?3,?4) ON CONFLICT(key) DO UPDATE SET generation=excluded.generation,bytes=excluded.bytes,digest=excluded.digest", params![key,generation,bytes,Sha256::digest(bytes).as_slice()]).map_err(storage_error)?;
    if let Some(operation) = operation {
        crate::indexed_commit::record(
            &tx,
            key,
            operation,
            expected,
            generation,
            bytes,
            receipts,
            &[],
        )?;
    }
    tx.commit().map_err(storage_error)?;
    Ok(generation)
}

fn verify_digest(bytes: &[u8], digest: &[u8]) -> Result<()> {
    validate_bytes(bytes)?;
    if Sha256::digest(bytes).as_slice() != digest {
        return Err(invalid("indexed store record digest mismatch"));
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(invalid("invalid indexed store key"));
    }
    Ok(())
}

fn validate_bytes(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(invalid("storage_pressure: record byte bound"));
    }
    Ok(())
}

fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
pub(crate) fn storage_error(error: impl std::fmt::Display + std::any::Any) -> DurableRunnerError {
    let any = &error as &dyn std::any::Any;
    let full = any.downcast_ref::<rusqlite::Error>().is_some_and(|error| matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::DiskFull))
        || any.downcast_ref::<std::io::Error>().is_some_and(|error| matches!(error.kind(), std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded))
        || any.downcast_ref::<rustix::io::Errno>().is_some_and(|error| matches!(std::io::Error::from_raw_os_error(error.raw_os_error()).kind(), std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded));
    if full {
        DurableRunnerError::storage_capacity(format!("storage_pressure: {error}"))
    } else {
        DurableRunnerError::invalid(format!("storage_unavailable: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("paperclip-indexed-{}", uuid::Uuid::new_v4()))
            .join("state.sqlite")
    }

    fn receipt(id: &str, bytes: &[u8]) -> ExactReceipt {
        ExactReceipt {
            namespace: "provider/session-1".into(),
            key: id.into(),
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn proof_receipts_are_generation_bound_and_do_not_repair_missing_state() {
        let path = path();
        let store = IndexedStore::open(&path, "proof-owner", true).unwrap();
        store
            .commit(
                "authority",
                0,
                b"current".to_vec(),
                vec![receipt("ancient", b"original")],
            )
            .unwrap();
        assert_eq!(
            read_only_receipt(&path, "proof-owner", 1, "provider/session-1", "ancient").unwrap(),
            Some(b"original".to_vec())
        );
        assert!(
            read_only_receipt(&path, "other-owner", 1, "provider/session-1", "ancient").is_err()
        );
        store
            .commit("authority", 1, b"new current".to_vec(), vec![])
            .unwrap();
        assert!(
            read_only_receipt(&path, "proof-owner", 1, "provider/session-1", "ancient").is_err()
        );
        assert_eq!(
            read_only_receipt(&path, "proof-owner", 2, "provider/session-1", "missing").unwrap(),
            None
        );
        drop(store);
        let missing = path.parent().unwrap().join("missing.sqlite");
        assert!(
            read_only_receipt(&missing, "proof-owner", 2, "provider/session-1", "ancient").is_err()
        );
        assert!(!missing.exists());
        assert!(!PathBuf::from(format!("{}.lifetime", missing.display())).exists());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn outstanding_work_mutations_share_the_authority_boundary_and_page_after_restart() {
        use crate::indexed_work::WorkChange;
        let path = path();
        let store = IndexedStore::open(&path, "work-owner", true).unwrap();
        let change = |key: &str, expected: Option<Vec<u8>>, bytes: Option<&[u8]>| WorkChange {
            collection: "process-owners".into(),
            key: key.into(),
            expected_digest: expected,
            bytes: bytes.map(Vec::from),
        };
        let generation = store
            .commit_with_work(
                "authority",
                0,
                b"one".to_vec(),
                vec![receipt("start", b"intent")],
                vec![change("launch-1", None, Some(b"started"))],
            )
            .unwrap();
        let owner = store
            .read_work("process-owners", "launch-1")
            .unwrap()
            .unwrap();
        assert!(store
            .commit_with_work(
                "authority",
                generation,
                b"wrong".to_vec(),
                vec![receipt("uncommitted", b"outcome")],
                vec![
                    change("launch-2", None, Some(b"new")),
                    change("launch-1", None, None)
                ]
            )
            .unwrap_err()
            .to_string()
            .contains("stale outstanding-work"));
        assert!(store
            .read_work("process-owners", "launch-2")
            .unwrap()
            .is_none());
        assert!(store
            .receipt("provider/session-1", "uncommitted")
            .unwrap()
            .is_none());
        assert_eq!(
            store.read_state("authority").unwrap().unwrap().bytes,
            b"one"
        );
        let work = (2..=129)
            .map(|n| change(&format!("launch-{n:04}"), None, Some(b"unresolved")))
            .collect();
        store
            .commit_with_work("authority", 1, b"two".to_vec(), vec![], work)
            .unwrap();
        drop(store);
        let store = IndexedStore::open(&path, "work-owner", false).unwrap();
        let first = store.work_page("process-owners", "", 128).unwrap();
        assert_eq!(first.len(), 128);
        assert_eq!(
            store
                .work_page("process-owners", &first.last().unwrap().key, 128)
                .unwrap()
                .len(),
            1
        );
        store
            .commit_with_work(
                "authority",
                2,
                b"three".to_vec(),
                vec![receipt("retired", b"exact stop proof")],
                vec![change("launch-1", Some(owner.digest), None)],
            )
            .unwrap();
        assert!(store
            .read_work("process-owners", "launch-1")
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .receipt("provider/session-1", "start")
                .unwrap()
                .unwrap(),
            b"intent"
        );
        assert_eq!(
            store
                .receipt("provider/session-1", "retired")
                .unwrap()
                .unwrap(),
            b"exact stop proof"
        );
        drop(store);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn state_and_receipts_commit_together_and_conflicts_rollback() {
        let path = path();
        {
            let store = IndexedStore::open(&path, "binding-1", true).unwrap();
            assert_eq!(
                store
                    .commit(
                        "authority",
                        0,
                        b"current".to_vec(),
                        vec![receipt("first", b"result")]
                    )
                    .unwrap(),
                1
            );
            assert!(store
                .commit(
                    "authority",
                    1,
                    b"wrong".to_vec(),
                    vec![receipt("second", b"new"), receipt("first", b"conflict")]
                )
                .is_err());
            assert_eq!(
                store.read_state("authority").unwrap().unwrap().bytes,
                b"current"
            );
            assert_eq!(store.receipt("provider/session-1", "second").unwrap(), None);
            assert!(store
                .commit("authority", 0, b"stale".to_vec(), vec![])
                .is_err());
        }
        let store = IndexedStore::open(&path, "binding-1", false).unwrap();
        assert_eq!(
            store
                .receipt("provider/session-1", "first")
                .unwrap()
                .unwrap(),
            b"result"
        );
        assert!(IndexedStore::open(&path, "wrong-binding", false).is_err());
        drop(store);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn missing_activated_store_is_not_a_cache_miss() {
        let path = path();
        assert!(IndexedStore::open(&path, "binding-1", false).is_err());
    }

    #[test]
    fn hundred_thousand_receipts_do_not_enter_current_state() {
        let path = path();
        {
            let store = IndexedStore::open(&path, "binding-1", true).unwrap();
            for batch in 0..100u64 {
                let receipts = (batch * 1_000..(batch + 1) * 1_000)
                    .map(|id| receipt(&format!("call-{id}"), format!("result-{id}").as_bytes()))
                    .collect();
                store
                    .commit(
                        "authority",
                        batch,
                        b"bounded-current-state".to_vec(),
                        receipts,
                    )
                    .unwrap();
            }
        }
        let store = IndexedStore::open(&path, "binding-1", false).unwrap();
        assert_eq!(
            store.read_state("authority").unwrap().unwrap(),
            StoredSnapshot {
                generation: Revision::from(100),
                bytes: b"bounded-current-state".to_vec()
            }
        );
        assert_eq!(
            store
                .receipt("provider/session-1", "call-0")
                .unwrap()
                .unwrap(),
            b"result-0"
        );
        assert_eq!(store.receipt("other-session", "call-0").unwrap(), None);
        drop(store);
        let db = Connection::open(&path).unwrap();
        let (routing_heads, largest_head_bytes): (i64, i64) = db
            .query_row(
                "SELECT count(*), coalesce(max(length(root)), 0) FROM receipt_routing_heads",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(
            routing_heads <= 1,
            "unexpected routing head count: {routing_heads}"
        );
        assert!(
            largest_head_bytes <= 16_384,
            "routing head grew to {largest_head_bytes} bytes"
        );
        let mut cursor: Option<String> = None;
        let mut count = 0_u64;
        loop {
            let page = crate::indexed_partitions::partitions(&db, cursor.as_deref(), 128).unwrap();
            if page.is_empty() {
                break;
            }
            count += page.iter().map(|partition| partition.records).sum::<u64>();
            cursor = page.last().map(|partition| partition.lower_key.clone());
        }
        assert_eq!(count, 100_000);
        drop(db);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
