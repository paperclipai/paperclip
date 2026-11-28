//! Writes a refreshed ACPX credential from the isolated provider home back to
//! the execution host's credential file.
//!
//! The decision rules match Core's local adapters: Codex compares
//! `tokens.account_id` and `last_refresh`, Grok compares the `<issuer>::<uuid>`
//! identity key and `expires_at`. The host file is replaced only by a strictly
//! fresher credential for the same identity, never by a different account.
//! Both providers rotate the refresh token on refresh and refuse a rotated one,
//! so an older credential must never replace a newer one.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use serde_json::Value;

const MAX_BYTES: u64 = 256 * 1024;
/// A Codex `last_refresh` records a past event. Allow only clock skew.
const MAX_FUTURE_LAST_REFRESH_SKEW_MS: f64 = 5.0 * 60.0 * 1000.0;
/// A Grok `expires_at` further ahead than this is not a plausible token expiry.
const MAX_PLAUSIBLE_EXPIRY_MS: f64 = 400.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// Below this magnitude a numeric `expires_at` is epoch seconds.
const EPOCH_SECONDS_MAX: f64 = 1e12;

#[derive(Debug, PartialEq)]
enum Expiry {
    Absent,
    Unreadable,
    At(f64),
}

#[derive(Debug, PartialEq)]
enum Freshness {
    Unusable,
    ApiKey,
    Codex {
        account: String,
        last_refresh: Option<f64>,
    },
    Grok {
        identity: String,
        expires: Expiry,
    },
}

/// The identity and change stamp of a host file, as one decision read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostStamp {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

#[cfg(unix)]
impl HostStamp {
    fn of(metadata: &fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
            mtime: (metadata.mtime(), metadata.mtime_nsec()),
            ctime: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

/// The current stamp of the host file, without reading its contents.
#[cfg(unix)]
pub(crate) fn host_stamp(path: &Path) -> Option<HostStamp> {
    fs::symlink_metadata(path)
        .ok()
        .map(|metadata| HostStamp::of(&metadata))
}

#[cfg(not(unix))]
pub(crate) fn host_stamp(_path: &Path) -> Option<HostStamp> {
    None
}

/// Outcome of one write-back attempt.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WriteBack {
    /// The host file now holds the refreshed credential.
    Written,
    /// Nothing was written. With a stamp, the host file it carries was at
    /// least as fresh, held another identity, or was not a usable credential;
    /// the decision holds only while the host file keeps that stamp. Without
    /// one, the refreshed credential itself is not usable.
    Kept(Option<HostStamp>),
    /// The host file changed while the replacement was prepared. Decide again
    /// against the new contents.
    Raced,
}

fn nonempty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn freshness(provider: &str, bytes: &[u8]) -> Freshness {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Freshness::Unusable;
    };
    let Some(object) = value.as_object() else {
        return Freshness::Unusable;
    };
    match provider {
        "codex" => {
            if nonempty(&value["OPENAI_API_KEY"]).is_some() {
                return Freshness::ApiKey;
            }
            let tokens = &value["tokens"];
            if !tokens.is_object() {
                return Freshness::Unusable;
            }
            let Some(account) = nonempty(&tokens["account_id"]) else {
                return Freshness::Unusable;
            };
            if ["id_token", "access_token", "refresh_token"]
                .iter()
                .all(|key| nonempty(&tokens[*key]).is_none())
            {
                return Freshness::Unusable;
            }
            Freshness::Codex {
                account: account.to_owned(),
                last_refresh: value["last_refresh"].as_str().and_then(parse_rfc3339_ms),
            }
        }
        "grok" => {
            if object.len() != 1 {
                return Freshness::Unusable;
            }
            let (identity, auth) = object.iter().next().expect("one entry");
            if !is_grok_identity(identity)
                || !auth.is_object()
                || nonempty(&auth["key"]).is_none()
                || nonempty(&auth["refresh_token"]).is_none()
            {
                return Freshness::Unusable;
            }
            let expires = match &auth["expires_at"] {
                Value::Null => Expiry::Absent,
                Value::String(raw) => parse_rfc3339_ms(raw).map_or(Expiry::Unreadable, Expiry::At),
                Value::Number(raw) => match raw.as_f64() {
                    Some(raw) if raw.is_finite() => Expiry::At(if raw < EPOCH_SECONDS_MAX {
                        raw * 1000.0
                    } else {
                        raw
                    }),
                    _ => Expiry::Unreadable,
                },
                _ => Expiry::Unreadable,
            };
            Freshness::Grok {
                identity: identity.clone(),
                expires,
            }
        }
        _ => Freshness::Unusable,
    }
}

/// `^.+::<uuid>$`, where `.` excludes line terminators as in JavaScript.
fn is_grok_identity(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.len() < 39 {
        return false;
    }
    let (prefix, suffix) = bytes.split_at(bytes.len() - 38);
    let uuid = &suffix[2..];
    let uuid_valid = uuid.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    });
    let Ok(prefix) = std::str::from_utf8(prefix) else {
        return false;
    };
    &suffix[..2] == b"::" && uuid_valid && !prefix.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// Whether `source` should replace `destination`, under Core's adapter rules.
fn prefer_source(source: &Freshness, destination: &Freshness, now_ms: f64) -> bool {
    match (source, destination) {
        (
            Freshness::Codex {
                account: source_account,
                last_refresh: source_refresh,
            },
            Freshness::Codex {
                account: destination_account,
                last_refresh: destination_refresh,
            },
        ) if source_account == destination_account => match (source_refresh, destination_refresh) {
            (Some(source), Some(destination)) => {
                source - now_ms <= MAX_FUTURE_LAST_REFRESH_SKEW_MS && source > destination
            }
            _ => false,
        },
        (
            Freshness::Grok {
                identity: source_identity,
                expires: source_expiry,
            },
            Freshness::Grok {
                identity: destination_identity,
                expires: destination_expiry,
            },
        ) if source_identity == destination_identity => match (source_expiry, destination_expiry) {
            (Expiry::At(source), Expiry::At(destination)) => {
                source - now_ms <= MAX_PLAUSIBLE_EXPIRY_MS && source > destination
            }
            _ => false,
        },
        _ => false,
    }
}

/// RFC 3339 to epoch milliseconds, truncated like `Date.parse`. Anything the
/// parser rejects is unparseable, which keeps the host file.
fn parse_rfc3339_ms(value: &str) -> Option<f64> {
    let instant =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    Some(instant.unix_timestamp_nanos().div_euclid(1_000_000) as f64)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Read the host credential file: a bounded, private regular file owned by
/// the Runner user, opened without following a final symlink.
#[cfg(unix)]
pub(crate) fn read_host_credential(path: &Path) -> io::Result<(Vec<u8>, fs::Metadata)> {
    use rustix::fs::{open, Mode, OFlags};
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return Err(invalid("credential file path is not absolute"));
    }
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let mut file = File::from(fd);
    let before = file.metadata()?;
    if !before.is_file()
        || before.len() == 0
        || before.len() > MAX_BYTES
        || before.mode() & 0o077 != 0
        || before.uid() != rustix::process::getuid().as_raw()
    {
        return Err(invalid(
            "credential file is not a private, bounded regular file",
        ));
    }
    let mut bytes = Vec::new();
    let read = (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes);
    let after = file.metadata()?;
    if read.is_err()
        || after.len() != bytes.len() as u64
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        bytes.fill(0);
        return Err(invalid("credential file changed while read"));
    }
    Ok((bytes, before))
}

#[cfg(not(unix))]
pub(crate) fn read_host_credential(_path: &Path) -> io::Result<(Vec<u8>, fs::Metadata)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "credential files require Unix",
    ))
}

/// Replace `destination` with `source` when `source` is strictly fresher for
/// the same identity. The replacement is a synced temporary file in the same
/// directory, renamed over the host file, with the host file's mode and group
/// carried over. A missing or invalid host file is never created or replaced.
#[cfg(unix)]
pub(crate) fn write_back(
    provider: &str,
    source: &[u8],
    destination: &Path,
    now_ms: f64,
) -> io::Result<WriteBack> {
    let source_freshness = freshness(provider, source);
    if matches!(source_freshness, Freshness::Unusable | Freshness::ApiKey) {
        return Ok(WriteBack::Kept(None));
    }
    let (mut current, metadata) = read_host_credential(destination)?;
    let replace = prefer_source(&source_freshness, &freshness(provider, &current), now_ms);
    current.fill(0);
    if !replace {
        return Ok(WriteBack::Kept(Some(HostStamp::of(&metadata))));
    }
    replace_if_unchanged(source, destination, &metadata)
}

/// Rename a synced copy of `source` over `destination`, unless the host file
/// no longer matches `metadata` from the decision read. The caller then
/// decides again against the new contents.
#[cfg(unix)]
fn replace_if_unchanged(
    source: &[u8],
    destination: &Path,
    metadata: &fs::Metadata,
) -> io::Result<WriteBack> {
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let parent = destination
        .parent()
        .ok_or_else(|| invalid("credential file has no parent directory"))?;
    let name = destination
        .file_name()
        .ok_or_else(|| invalid("credential file has no name"))?
        .to_string_lossy();
    let temporary = parent.join(format!(
        ".{name}.{}.{}.paperclip-refresh",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| -> io::Result<WriteBack> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
            .open(&temporary)?;
        file.set_permissions(fs::Permissions::from_mode(metadata.mode() & 0o7777))?;
        if file.metadata()?.gid() != metadata.gid() {
            // Keep the host file's group when the Runner user may set it.
            let _ =
                rustix::fs::fchown(&file, None, Some(rustix::fs::Gid::from_raw(metadata.gid())));
        }
        file.write_all(source)?;
        file.sync_all()?;
        drop(file);
        if HostStamp::of(&fs::symlink_metadata(destination)?) != HostStamp::of(metadata) {
            return Ok(WriteBack::Raced);
        }
        fs::rename(&temporary, destination)?;
        File::open(parent)?.sync_all()?;
        Ok(WriteBack::Written)
    })();
    if !matches!(result, Ok(WriteBack::Written)) {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(unix))]
pub(crate) fn write_back(
    _provider: &str,
    _source: &[u8],
    _destination: &Path,
    _now_ms: f64,
) -> io::Result<WriteBack> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "credential files require Unix",
    ))
}

pub(crate) fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

#[cfg(all(test, unix))]
#[path = "tests/credential_write_back.rs"]
mod tests;
