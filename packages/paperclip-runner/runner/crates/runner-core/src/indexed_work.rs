//! Outstanding work is separate from immutable history and from the one-row
//! current checkpoint. Exact mutations share the authority commit boundary.
use crate::{durable::DurableRunnerError, indexed_store::storage_error};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
type Result<T> = std::result::Result<T, DurableRunnerError>;

#[derive(Clone, Debug)]
pub struct WorkChange {
    pub collection: String,
    pub key: String,
    pub expected_digest: Option<Vec<u8>>,
    pub bytes: Option<Vec<u8>>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct WorkRecord {
    pub key: String,
    pub bytes: Vec<u8>,
    pub digest: Vec<u8>,
}
fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS current_work(collection TEXT NOT NULL,key TEXT NOT NULL,bytes BLOB NOT NULL,digest BLOB NOT NULL,PRIMARY KEY(collection,key)) WITHOUT ROWID;").map_err(storage_error)
}
pub(crate) fn validate(changes: &[WorkChange]) -> Result<()> {
    if changes.len() > 128 {
        return Err(invalid(
            "storage_pressure: outstanding-work transaction bound",
        ));
    }
    for (index, change) in changes.iter().enumerate() {
        if change.collection.is_empty()
            || change.collection.len() > 128
            || change.key.is_empty()
            || change.key.len() > 1024
            || change.collection.contains('\0')
            || change.key.contains('\0')
            || change
                .expected_digest
                .as_ref()
                .is_some_and(|d| d.len() != 32)
            || change.bytes.as_ref().is_some_and(|b| b.len() > 16384)
            || changes[..index]
                .iter()
                .any(|prior| prior.collection == change.collection && prior.key == change.key)
        {
            return Err(invalid("invalid outstanding-work mutation"));
        }
    }
    Ok(())
}
pub(crate) fn get(db: &Connection, collection: &str, key: &str) -> Result<Option<WorkRecord>> {
    let value:Option<(Vec<u8>,Vec<u8>)>=db.query_row("SELECT CASE WHEN length(bytes)<=16384 THEN bytes END,CASE WHEN length(digest)=32 THEN digest END FROM current_work WHERE collection=?1 AND key=?2",params![collection,key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage_error)?;
    value
        .map(|(bytes, digest)| {
            if Sha256::digest(&bytes).as_slice() != digest {
                return Err(invalid("outstanding-work digest mismatch"));
            }
            Ok(WorkRecord {
                key: key.into(),
                bytes,
                digest,
            })
        })
        .transpose()
}
pub(crate) fn page(
    db: &Connection,
    collection: &str,
    after: &str,
    limit: usize,
) -> Result<Vec<WorkRecord>> {
    if !(1..=128).contains(&limit) || collection.len() > 128 || after.len() > 1024 {
        return Err(invalid("invalid outstanding-work page"));
    }
    let mut query = db
        .prepare(
            "SELECT key FROM current_work WHERE collection=?1 AND key>?2 ORDER BY key LIMIT ?3",
        )
        .map_err(storage_error)?;
    let keys = query
        .query_map(params![collection, after, limit as i64], |r| {
            r.get::<_, String>(0)
        })
        .map_err(storage_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(storage_error)?;
    keys.iter()
        .map(|key| get(db, collection, key)?.ok_or_else(|| invalid("outstanding work disappeared")))
        .collect()
}
pub(crate) fn apply(db: &Connection, changes: &[WorkChange]) -> Result<()> {
    validate(changes)?;
    for change in changes {
        if get(db, &change.collection, &change.key)?.map(|r| r.digest) != change.expected_digest {
            return Err(invalid("stale outstanding-work digest"));
        }
        if let Some(bytes) = &change.bytes {
            db.execute("INSERT INTO current_work VALUES(?1,?2,?3,?4) ON CONFLICT(collection,key) DO UPDATE SET bytes=excluded.bytes,digest=excluded.digest",params![change.collection,change.key,bytes,Sha256::digest(bytes).to_vec()]).map_err(storage_error)?;
        } else {
            db.execute(
                "DELETE FROM current_work WHERE collection=?1 AND key=?2",
                params![change.collection, change.key],
            )
            .map_err(storage_error)?;
        }
    }
    Ok(())
}
