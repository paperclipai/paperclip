//! Exact CAS identities. Retained integer revisions keep their representation;
//! at the old boundary they switch permanently to opaque commit identities.
//! Revision order is never used to infer event or receipt order.
use crate::durable::DurableRunnerError;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;
use std::{fmt, str::FromStr};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Revision {
    #[default]
    Absent,
    Legacy(u64),
    Opaque(Uuid),
    /// A writer with an indeterminate outcome cannot re-admit writes.
    Fenced,
}

impl Revision {
    pub fn next(self) -> Result<Self, DurableRunnerError> {
        match self {
            Self::Absent => Ok(Self::Legacy(1)),
            Self::Legacy(n) if n > 0 && n < i64::MAX as u64 => Ok(Self::Legacy(n + 1)),
            Self::Legacy(n) if n == i64::MAX as u64 => Ok(Self::Opaque(Uuid::new_v4())),
            Self::Opaque(previous) => {
                let next = Uuid::new_v4();
                if next == previous {
                    return Err(DurableRunnerError::invalid(
                        "fresh indexed revision unavailable",
                    ));
                }
                Ok(Self::Opaque(next))
            }
            _ => Err(DurableRunnerError::invalid("indexed writer is fenced")),
        }
    }

    pub(crate) fn legacy(self) -> Option<u64> {
        match self {
            Self::Absent => Some(0),
            Self::Legacy(n) => Some(n),
            _ => None,
        }
    }

    pub(crate) fn fingerprint(self) -> Vec<u8> {
        // Preserve v1 retry fingerprints for retained integer commits.
        match self.legacy() {
            Some(n) => n.to_be_bytes().to_vec(),
            None => self.to_string().into_bytes(),
        }
    }
}

impl From<u64> for Revision {
    fn from(value: u64) -> Self {
        match value {
            0 => Self::Absent,
            n if n <= i64::MAX as u64 => Self::Legacy(n),
            _ => Self::Fenced,
        }
    }
}
impl PartialEq<u64> for Revision {
    fn eq(&self, other: &u64) -> bool {
        self.legacy() == Some(*other)
    }
}
impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => f.write_str("0"),
            Self::Legacy(n) => write!(f, "{n}"),
            Self::Opaque(id) => write!(f, "r:{id}"),
            Self::Fenced => f.write_str("fenced"),
        }
    }
}
impl FromStr for Revision {
    type Err = DurableRunnerError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if let Some(id) = value
            .strip_prefix("r:")
            .and_then(|s| Uuid::parse_str(s).ok())
        {
            if id.get_version_num() == 4
                && id.get_variant() == uuid::Variant::RFC4122
                && value == format!("r:{id}")
            {
                return Ok(Self::Opaque(id));
            }
        } else if let Ok(n) = value.parse::<u64>() {
            if n <= i64::MAX as u64 && n.to_string() == value {
                return Ok(n.into());
            }
        }
        Err(DurableRunnerError::invalid("invalid indexed revision"))
    }
}
impl FromSql for Revision {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value {
            ValueRef::Integer(n) if n > 0 => Ok(Self::Legacy(n as u64)),
            ValueRef::Text(bytes) => {
                match std::str::from_utf8(bytes).ok().and_then(|s| s.parse().ok()) {
                    Some(revision @ Self::Opaque(_)) => Ok(revision),
                    _ => Err(FromSqlError::InvalidType),
                }
            }
            _ => Err(FromSqlError::InvalidType),
        }
    }
}
impl ToSql for Revision {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        match self {
            Self::Legacy(n) if *n > 0 && *n <= i64::MAX as u64 => {
                Ok(ToSqlOutput::Owned(Value::Integer(*n as i64)))
            }
            Self::Opaque(_) => Ok(ToSqlOutput::Owned(Value::Text(self.to_string()))),
            _ => Err(rusqlite::Error::InvalidParameterName(
                "invalid persisted revision".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transitions_at_exact_boundary_and_never_wraps() {
        let last = Revision::from(i64::MAX as u64);
        let first = last.next().unwrap();
        let second = first.next().unwrap();
        assert!(matches!(first, Revision::Opaque(_)));
        assert_ne!(first, second);
        for revision in [
            Revision::Absent,
            Revision::from(9_007_199_254_740_993),
            last,
            first,
            second,
        ] {
            assert_eq!(revision.to_string().parse::<Revision>().unwrap(), revision);
        }
        assert!(Revision::Fenced.next().is_err());
    }
    #[test]
    fn rejects_ambiguous_or_invalid_encodings() {
        for value in [
            "01",
            "-1",
            "9223372036854775808",
            "r:00000000-0000-0000-0000-000000000001",
            "fenced",
        ] {
            assert!(value.parse::<Revision>().is_err(), "{value}");
        }
        assert!(Revision::column_result(ValueRef::Integer(0)).is_err());
        assert!(Revision::column_result(ValueRef::Text(b"1")).is_err());
    }
}
