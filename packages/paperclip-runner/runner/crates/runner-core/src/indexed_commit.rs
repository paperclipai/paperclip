//! One retry identity per current row, never a lifetime list. It shares the
//! root transaction with current state and receipt redo. A caller retries the
//! same storage request, not the command that produced it.
use crate::indexed_revision::Revision;
use crate::{
    durable::DurableRunnerError,
    indexed_store::{storage_error, ExactReceipt},
    indexed_work::WorkChange,
};
use rusqlite::{params, Connection, OptionalExtension};
type Result<T> = std::result::Result<T, DurableRunnerError>;

pub(crate) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS current_commit (state_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, generation INTEGER NOT NULL, digest BLOB NOT NULL, expected_generation TEXT) WITHOUT ROWID;").map_err(storage_error)?;
    let has_predecessor: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('current_commit') WHERE name='expected_generation')", [], |r| r.get(0)).map_err(storage_error)?;
    if !has_predecessor {
        db.execute_batch("ALTER TABLE current_commit ADD COLUMN expected_generation TEXT;")
            .map_err(storage_error)?;
    }
    Ok(())
}

fn fingerprint(
    key: &str,
    generation: Revision,
    predecessor: Option<Revision>,
    bytes: &[u8],
    receipts: &[ExactReceipt],
    work: &[WorkChange],
) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    };
    field(if predecessor.is_some() {
        b"paperclip.indexed-commit.v2"
    } else {
        b"paperclip.indexed-commit.v1"
    });
    field(key.as_bytes());
    field(&generation.fingerprint());
    if let Some(previous) = predecessor {
        field(&previous.fingerprint());
    }
    field(bytes);
    field(&(receipts.len() as u64).to_be_bytes());
    for receipt in receipts {
        field(receipt.namespace.as_bytes());
        field(receipt.key.as_bytes());
        field(&receipt.bytes);
    }
    field(&(work.len() as u64).to_be_bytes());
    for change in work {
        field(change.collection.as_bytes());
        field(change.key.as_bytes());
        for value in [&change.expected_digest, &change.bytes] {
            field(&[u8::from(value.is_some())]);
            if let Some(bytes) = value {
                field(bytes);
            }
        }
    }
    hash.finalize().to_vec()
}

pub(crate) fn record(
    db: &Connection,
    key: &str,
    operation: &str,
    expected: Revision,
    generation: Revision,
    bytes: &[u8],
    receipts: &[ExactReceipt],
    work: &[WorkChange],
) -> Result<()> {
    db.execute("INSERT INTO current_commit(state_key,operation_id,generation,digest,expected_generation) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(state_key) DO UPDATE SET operation_id=excluded.operation_id,generation=excluded.generation,digest=excluded.digest,expected_generation=excluded.expected_generation", params![key,operation,generation,fingerprint(key,generation,Some(expected),bytes,receipts,work),expected.to_string()]).map_err(storage_error)?;
    Ok(())
}

pub(crate) fn replay(
    db: &Connection,
    key: &str,
    operation: &str,
    expected: Revision,
    bytes: &[u8],
    receipts: &[ExactReceipt],
    work: &[WorkChange],
) -> Result<Option<Revision>> {
    let stamp: Option<(String, Revision, Vec<u8>, Option<String>)> = db.query_row("SELECT operation_id,generation,CASE WHEN length(digest)=32 THEN digest END,expected_generation FROM current_commit WHERE state_key=?1", [key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(storage_error)?;
    let Some((id, generation, digest, predecessor)) = stamp else {
        return Ok(None);
    };
    if id != operation {
        return Ok(None);
    }
    let predecessor = predecessor
        .map(|value| value.parse::<Revision>())
        .transpose()?;
    let follows = match predecessor {
        Some(value) => value == expected && generation != expected,
        None => {
            matches!((expected.legacy(), generation.legacy()), (Some(old), Some(new)) if old.checked_add(1) == Some(new))
        }
    };
    if !follows || digest != fingerprint(key, generation, predecessor, bytes, receipts, work) {
        return Err(DurableRunnerError::invalid(
            "indexed commit retry identity changed",
        ));
    }
    let current = crate::indexed_store::read_state(db, key)?;
    if !current.is_some_and(|state| state.generation == generation && state.bytes == bytes) {
        return Err(DurableRunnerError::invalid(
            "indexed commit retry was superseded",
        ));
    }
    Ok(Some(generation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn retained_retry_stamp_survives_schema_upgrade() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE current_commit(state_key TEXT PRIMARY KEY,operation_id TEXT,generation INTEGER,digest BLOB); CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB);").unwrap();
        db.execute(
            "INSERT INTO current_state VALUES('state',2,?1,?2)",
            params![b"accepted", Sha256::digest(b"accepted").as_slice()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO current_commit VALUES('state','old-operation',2,?1)",
            [fingerprint("state", 2.into(), None, b"accepted", &[], &[])],
        )
        .unwrap();
        initialize(&db).unwrap();
        initialize(&db).unwrap();
        assert_eq!(
            replay(
                &db,
                "state",
                "old-operation",
                1.into(),
                b"accepted",
                &[],
                &[]
            )
            .unwrap(),
            Some(2.into())
        );
        assert!(replay(
            &db,
            "state",
            "old-operation",
            0.into(),
            b"accepted",
            &[],
            &[]
        )
        .is_err());
    }

    #[test]
    fn opaque_retry_stamp_binds_the_predecessor_and_rejects_its_corruption() {
        let db = Connection::open_in_memory().unwrap();
        initialize(&db).unwrap();
        db.execute_batch("CREATE TABLE current_state(key TEXT PRIMARY KEY,generation INTEGER,bytes BLOB,digest BLOB);").unwrap();
        let previous = Revision::from(i64::MAX as u64);
        let next = previous.next().unwrap();
        db.execute(
            "INSERT INTO current_state VALUES('state',?1,?2,?3)",
            params![next, b"accepted", Sha256::digest(b"accepted").as_slice()],
        )
        .unwrap();
        record(
            &db,
            "state",
            "operation",
            previous,
            next,
            b"accepted",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(
            replay(&db, "state", "operation", previous, b"accepted", &[], &[]).unwrap(),
            Some(next)
        );
        db.execute("UPDATE current_commit SET expected_generation='1'", [])
            .unwrap();
        assert!(replay(&db, "state", "operation", 1.into(), b"accepted", &[], &[]).is_err());
    }
}
