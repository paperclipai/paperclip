//! Fenced, restartable preparation of legacy local authority. The caller owns
//! the session fence; this module never replaces a live locator or source file.

use crate::indexed_revision::Revision;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::durable::{
    create_private_temporary_file, open_private_regular_file, DurableRunnerError,
};
use crate::indexed_store::{ExactReceipt, IndexedStore};

type Result<T> = std::result::Result<T, DurableRunnerError>;
const PROGRESS: &str = "legacy-import";
const PAGE_BYTES: usize = 8 * 1024 * 1024;

fn invalid(message: impl Into<String>) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}

struct HashReader<R> {
    inner: R,
    digest: Sha256,
    remaining: u64,
}
impl<R: Read> Read for HashReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        self.remaining = self
            .remaining
            .checked_sub(count as u64)
            .ok_or_else(|| io::Error::other("legacy source exceeded its admission bound"))?;
        self.digest.update(&bytes[..count]);
        Ok(count)
    }
}

fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}

/// The bound is the old format's admitted pending state, not indexed history.
/// Hash and decode the source once without allocating a second whole-file copy.
pub(crate) struct LegacySource {
    pub digest: String,
    path: PathBuf,
    metadata: fs::Metadata,
}
impl LegacySource {
    pub fn verify(&self) -> Result<()> {
        let current = open_private_regular_file(&self.path)
            .and_then(|file| file.metadata())
            .map_err(|e| invalid(e.to_string()))?;
        if !same_file(&self.metadata, &current) {
            return Err(invalid("legacy source changed during import"));
        }
        Ok(())
    }
}

pub(crate) fn read_legacy<T: DeserializeOwned>(
    path: &Path,
    maximum: u64,
) -> Result<(T, LegacySource)> {
    let file = open_private_regular_file(path).map_err(|e| invalid(e.to_string()))?;
    let before = file.metadata().map_err(|e| invalid(e.to_string()))?;
    if before.len() > maximum {
        return Err(invalid("legacy source exceeds its admission bound"));
    }
    let mut reader = HashReader {
        inner: BufReader::with_capacity(64 * 1024, file),
        digest: Sha256::new(),
        remaining: maximum,
    };
    let state = serde_json::from_reader(&mut reader)
        .map_err(|e| invalid(format!("invalid legacy source: {e}")))?;
    let after = reader
        .inner
        .get_ref()
        .metadata()
        .map_err(|e| invalid(e.to_string()))?;
    let current = open_private_regular_file(path)
        .and_then(|file| file.metadata())
        .map_err(|e| invalid(e.to_string()))?;
    if !same_file(&before, &after) || !same_file(&before, &current) {
        return Err(invalid("legacy source changed during import"));
    }
    Ok((
        state,
        LegacySource {
            digest: format!("{:x}", reader.digest.finalize()),
            path: path.into(),
            metadata: before,
        },
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLegacyAuthority {
    pub schema: String,
    pub binding: String,
    pub fence_id: String,
    pub source_digest: String,
    pub current_digest: String,
    pub current_key: String,
    pub generation: u64,
    pub receipts: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    schema: String,
    binding: String,
    fence_id: String,
    source_digest: String,
    receipts: u64,
    receipt_digest: String,
    prepared: Option<PreparedLegacyAuthority>,
}

pub(crate) struct ImportWriter {
    pub store: IndexedStore,
    progress: Progress,
    generation: Revision,
    seen: u64,
    digest: Sha256,
    pending: Vec<ExactReceipt>,
    bytes: usize,
}

impl ImportWriter {
    pub fn open(path: &Path, binding: &str, fence: &str, source_digest: &str) -> Result<Self> {
        if fence.is_empty() || fence.len() > 240 || fence.chars().any(char::is_control) {
            return Err(invalid(
                "legacy import requires a bounded exclusive fence identity",
            ));
        }
        let store = IndexedStore::open(path, binding, true)?;
        let saved = store.read_state(PROGRESS)?;
        let mut generation = saved.as_ref().map_or(Revision::Absent, |s| s.generation);
        let progress: Progress = match saved {
            Some(saved) => {
                serde_json::from_slice(&saved.bytes).map_err(|e| invalid(e.to_string()))?
            }
            None => Progress {
                schema: "paperclip.runner.local-import.v1".into(),
                binding: binding.into(),
                fence_id: fence.into(),
                source_digest: source_digest.into(),
                receipts: 0,
                receipt_digest: format!("{:x}", Sha256::digest([])),
                prepared: None,
            },
        };
        if progress.schema != "paperclip.runner.local-import.v1"
            || progress.binding != binding
            || progress.fence_id != fence
            || progress.source_digest != source_digest
        {
            return Err(invalid("legacy import binding, fence, or source changed"));
        }
        if generation == 0 {
            // Never adopt a live store as an import destination.
            if store.read_state("runner")?.is_some()
                || store.read_state("codex-provider")?.is_some()
            {
                return Err(invalid(
                    "legacy import destination is already an execution authority",
                ));
            }
            generation = store.commit(
                PROGRESS,
                0,
                serde_json::to_vec(&progress).map_err(|e| invalid(e.to_string()))?,
                vec![],
            )?;
        }
        Ok(Self {
            store,
            progress,
            generation,
            seen: 0,
            digest: Sha256::new(),
            pending: vec![],
            bytes: 0,
        })
    }

    pub fn add(&mut self, receipt: ExactReceipt) -> Result<()> {
        if receipt.bytes.len() > 32 * 1024 * 1024 {
            return Err(invalid("legacy receipt exceeds per-record admission bound"));
        }
        for part in [
            receipt.namespace.as_bytes(),
            receipt.key.as_bytes(),
            receipt.bytes.as_slice(),
        ] {
            self.digest.update((part.len() as u64).to_be_bytes());
            self.digest.update(part);
        }
        self.seen = self
            .seen
            .checked_add(1)
            .ok_or_else(|| invalid("legacy receipt cursor overflow"))?;
        if self.seen <= self.progress.receipts {
            if self.seen == self.progress.receipts
                && format!("{:x}", self.digest.clone().finalize()) != self.progress.receipt_digest
            {
                return Err(invalid("legacy receipt prefix changed"));
            }
            return Ok(());
        }
        self.bytes += receipt.bytes.len();
        self.pending.push(receipt);
        if self.pending.len() >= 128 || self.bytes >= PAGE_BYTES {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.progress.receipts = self.seen;
        self.progress.receipt_digest = format!("{:x}", self.digest.clone().finalize());
        self.generation = self.store.commit(
            PROGRESS,
            self.generation,
            serde_json::to_vec(&self.progress).map_err(|e| invalid(e.to_string()))?,
            std::mem::take(&mut self.pending),
        )?;
        self.bytes = 0;
        Ok(())
    }

    pub fn finish(mut self, key: &str, current: Vec<u8>) -> Result<PreparedLegacyAuthority> {
        if self.seen < self.progress.receipts {
            return Err(invalid("legacy receipt source is incomplete"));
        }
        self.flush()?;
        let generation = match self.store.read_state(key)? {
            None => self.store.commit(key, 0, current.clone(), vec![])?,
            Some(existing) if existing.generation == 1 && existing.bytes == current => {
                Revision::from(1)
            }
            Some(_) => return Err(invalid("legacy import destination has advanced or changed")),
        };
        let proof = PreparedLegacyAuthority {
            schema: "paperclip.runner.prepared-legacy-authority.v1".into(),
            binding: self.progress.binding.clone(),
            fence_id: self.progress.fence_id.clone(),
            source_digest: self.progress.source_digest.clone(),
            current_digest: format!("{:x}", Sha256::digest(&current)),
            current_key: key.into(),
            generation: generation
                .legacy()
                .ok_or_else(|| invalid("legacy preparation revision is not initial"))?,
            receipts: self.seen,
        };
        if self
            .progress
            .prepared
            .as_ref()
            .is_some_and(|old| old != &proof)
        {
            return Err(invalid("prepared legacy authority changed"));
        }
        self.progress.prepared = Some(proof.clone());
        self.store.commit(
            PROGRESS,
            self.generation,
            serde_json::to_vec(&self.progress).map_err(|e| invalid(e.to_string()))?,
            vec![],
        )?;
        Ok(proof)
    }
}

pub(crate) fn require_prepared(store: &IndexedStore) -> Result<()> {
    if let Some(saved) = store.read_state(PROGRESS)? {
        let progress: Progress =
            serde_json::from_slice(&saved.bytes).map_err(|e| invalid(e.to_string()))?;
        if progress.prepared.is_none() {
            return Err(invalid("legacy import has not prepared its authority"));
        }
    }
    Ok(())
}

pub(crate) fn require_active_directory(directory: &Path) -> Result<()> {
    let Some(root) = directory.parent() else {
        return Ok(());
    };
    let path = root.join("indexed-migration.json");
    let mut file = match open_private_regular_file(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(invalid(e.to_string())),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| invalid(e.to_string()))?;
    let marker: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("legacy migration marker is invalid"))?;
    if bytes.len() > 16 * 1024
        || marker["schema"] != "paperclip.runner.legacy-activation.v1"
        || marker["phase"] != "active"
    {
        return Err(invalid("legacy migration is pending; execution is fenced"));
    }
    Ok(())
}

/// Used only inside a staging directory. Existing bytes must be identical.
pub(crate) fn publish_staged_locator(path: &Path, bytes: &[u8]) -> Result<()> {
    match open_private_regular_file(path) {
        Ok(mut file) => {
            let mut existing = Vec::new();
            Read::by_ref(&mut file)
                .take(8193)
                .read_to_end(&mut existing)
                .map_err(|e| invalid(e.to_string()))?;
            return if existing == bytes {
                Ok(())
            } else {
                Err(invalid(
                    "staged locator already contains different authority",
                ))
            };
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(invalid(e.to_string())),
    }
    let (temporary, mut file) = create_private_temporary_file(path)?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| invalid(e.to_string()))?;
    // Linking is no-clobber, unlike rename over a concurrently-created locator.
    fs::hard_link(&temporary, path).map_err(|e| invalid(e.to_string()))?;
    fs::remove_file(temporary).map_err(|e| invalid(e.to_string()))?;
    File::open(
        path.parent()
            .ok_or_else(|| invalid("locator lacks parent"))?,
    )
    .and_then(|f| f.sync_all())
    .map_err(|e| invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_import_resumes_exact_pages_without_publishing_partial_authority() {
        let root = std::env::temp_dir().join(format!("local-import-{}", uuid::Uuid::new_v4()));
        let path = root.join("runner-state.sqlite");
        let receipt = |n| ExactReceipt {
            namespace: "tools".into(),
            key: format!("call-{n:04}"),
            bytes: vec![n as u8; 512],
        };
        {
            let mut writer = ImportWriter::open(&path, "binding", "fence", "source").unwrap();
            for n in 0..150 {
                writer.add(receipt(n)).unwrap();
            }
            assert!(writer.store.read_state("runner").unwrap().is_none());
            assert!(require_prepared(&writer.store).is_err());
            // Simulated importer loss after a committed page and before the
            // buffered remainder. No current authority exists yet.
        }
        assert!(ImportWriter::open(&path, "binding", "other-fence", "source").is_err());
        assert!(ImportWriter::open(&path, "binding", "fence", "other-source").is_err());
        let mut writer = ImportWriter::open(&path, "binding", "fence", "source").unwrap();
        for n in 0..500 {
            writer.add(receipt(n)).unwrap();
        }
        let proof = writer.finish("runner", b"current".to_vec()).unwrap();
        assert_eq!(proof.receipts, 500);
        let store = IndexedStore::open(&path, "binding", false).unwrap();
        require_prepared(&store).unwrap();
        for n in [0, 127, 128, 499] {
            assert_eq!(
                store.receipt("tools", &format!("call-{n:04}")).unwrap(),
                Some(receipt(n).bytes)
            );
        }
        // Commit-before-publication retry is identical, not a new generation.
        let mut writer = ImportWriter::open(&path, "binding", "fence", "source").unwrap();
        for n in 0..500 {
            writer.add(receipt(n)).unwrap();
        }
        assert_eq!(writer.finish("runner", b"current".to_vec()).unwrap(), proof);
        store
            .commit("runner", 1, b"advanced".to_vec(), vec![])
            .unwrap();
        let mut writer = ImportWriter::open(&path, "binding", "fence", "source").unwrap();
        for n in 0..500 {
            writer.add(receipt(n)).unwrap();
        }
        assert!(writer.finish("runner", b"current".to_vec()).is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_source_reader_hashes_exact_bytes_and_rejects_changed_or_oversized_input() {
        let root =
            std::env::temp_dir().join(format!("local-import-source-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("source.json");
        let (temporary, mut file) = create_private_temporary_file(&path).unwrap();
        let bytes = b"{\"pending\":[1,2,3]}\n";
        file.write_all(bytes).unwrap();
        drop(file);
        fs::rename(temporary, &path).unwrap();
        let (value, source): (serde_json::Value, _) = read_legacy(&path, 1024).unwrap();
        assert_eq!(value["pending"][2], 3);
        assert_eq!(source.digest, format!("{:x}", Sha256::digest(bytes)));
        assert!(read_legacy::<serde_json::Value>(&path, 2).is_err());
        fs::write(&path, b"{}").unwrap();
        assert!(source.verify().is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
