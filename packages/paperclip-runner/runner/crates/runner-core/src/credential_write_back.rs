//! Writes a refreshed ACPX credential from the isolated provider home back to
//! the execution host's credential file.
//!
//! The decision rules match Core's local adapters: Codex compares
//! `tokens.account_id` and `last_refresh`, Grok compares the `<issuer>::<uuid>`
//! identity key and `expires_at`. The host file is replaced only by a strictly
//! fresher credential for the same identity, never by a different account.

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

/// Outcome of one write-back attempt.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WriteBack {
    /// The host file now holds the refreshed credential.
    Written,
    /// The host file is at least as fresh, holds another identity, or the
    /// refreshed credential is not usable. Nothing was written.
    Kept,
    /// The host file changed while the replacement was prepared. Retry later.
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

/// Parse `YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM)` to epoch
/// milliseconds, truncating the fraction to milliseconds like `Date.parse`.
fn parse_rfc3339_ms(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    let number = |start: usize, end: usize| -> Option<i64> {
        let digits = bytes.get(start..end)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            digits
                .iter()
                .fold(0_i64, |total, digit| total * 10 + i64::from(digit - b'0')),
        )
    };
    let separator = |index: usize, expected: u8| bytes.get(index) == Some(&expected);
    if !(separator(4, b'-')
        && separator(7, b'-')
        && separator(10, b'T')
        && separator(13, b':')
        && separator(16, b':'))
    {
        return None;
    }
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let mut index = 19;
    let mut millis = 0_i64;
    if separator(index, b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        for position in 0..3 {
            let digit = if start + position < index {
                i64::from(bytes[start + position] - b'0')
            } else {
                0
            };
            millis = millis * 10 + digit;
        }
    }
    let offset_minutes = match bytes.get(index) {
        Some(b'Z') if index + 1 == bytes.len() => 0,
        Some(sign @ (b'+' | b'-')) if index + 6 == bytes.len() && separator(index + 3, b':') => {
            let (hours, minutes) = (number(index + 1, index + 3)?, number(index + 4, index + 6)?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            let total = hours * 60 + minutes;
            if *sign == b'-' {
                -total
            } else {
                total
            }
        }
        _ => return None,
    };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if day < 1 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // Days since 1970-01-01 in the proleptic Gregorian calendar.
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    let seconds = ((days * 24 + hour) * 60 + minute - offset_minutes) * 60 + second;
    Some((seconds * 1000 + millis) as f64)
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
    use std::io::Write;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let source_freshness = freshness(provider, source);
    if matches!(source_freshness, Freshness::Unusable | Freshness::ApiKey) {
        return Ok(WriteBack::Kept);
    }
    let (mut current, metadata) = read_host_credential(destination)?;
    let replace = prefer_source(&source_freshness, &freshness(provider, &current), now_ms);
    current.fill(0);
    if !replace {
        return Ok(WriteBack::Kept);
    }
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
        // Fail closed if the host replaced or rewrote its file meanwhile; the
        // next scan decides again against the new contents.
        let latest = fs::symlink_metadata(destination)?;
        if latest.dev() != metadata.dev()
            || latest.ino() != metadata.ino()
            || latest.len() != metadata.len()
            || latest.mtime() != metadata.mtime()
            || latest.mtime_nsec() != metadata.mtime_nsec()
            || latest.ctime() != metadata.ctime()
            || latest.ctime_nsec() != metadata.ctime_nsec()
        {
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
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::PathBuf;

    const NOW: f64 = 1_800_000_000_000.0;
    const IDENTITY: &str = "https://issuer.example::12345678-1234-4234-8234-123456789abc";

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("credential-write-back-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn write(&self, name: &str, value: &Value, mode: u32) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
            path
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn rfc3339(ms: f64) -> String {
        let seconds = (ms / 1000.0) as i64;
        let days = seconds.div_euclid(86_400);
        let rest = seconds.rem_euclid(86_400);
        // Inverse of the civil-day conversion, for fixtures only.
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}123Z",
            rest / 3600,
            rest % 3600 / 60,
            rest % 60,
            (ms as i64).rem_euclid(1000)
        )
    }

    fn codex(account: &str, marker: &str, last_refresh_ms: f64) -> Value {
        json!({"tokens":{"account_id":account, "access_token":format!("access-{marker}"),
            "refresh_token":format!("refresh-{marker}"), "id_token":format!("id-{marker}")},
            "last_refresh": rfc3339(last_refresh_ms)})
    }

    fn grok(identity: &str, marker: &str, expires_at: Value) -> Value {
        json!({ identity: {"key":format!("access-{marker}"), "refresh_token":format!("refresh-{marker}"),
            "expires_at": expires_at}})
    }

    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }

    #[test]
    fn rfc3339_matches_javascript_date_parse() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_rfc3339_ms("2026-11-24T12:34:56.789999Z"),
            Some(1_795_523_696_789.0)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-11-24T14:34:56+02:00"),
            parse_rfc3339_ms("2026-11-24T12:34:56Z")
        );
        assert_eq!(
            parse_rfc3339_ms("2024-02-29T00:00:00Z"),
            Some(1_709_164_800_000.0)
        );
        assert_eq!(parse_rfc3339_ms(&rfc3339(NOW)), Some(NOW));
        for invalid in [
            "2025-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-11-24 12:34:56Z",
            "2026-11-24T12:34:56",
            "2026-11-24T12:34:56.Z",
            "2026-11-24T12:34Z",
            "2026-11-24",
            "yesterday",
        ] {
            assert_eq!(parse_rfc3339_ms(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn grok_identity_matches_the_adapter_pattern() {
        assert!(is_grok_identity(IDENTITY));
        assert!(is_grok_identity("x::12345678-1234-1234-1234-123456789ABC"));
        for invalid in [
            "::12345678-1234-1234-1234-123456789abc",
            "issuer:12345678-1234-1234-1234-123456789abc",
            "issuer::12345678123412341234123456789abc",
            "line\nbreak::12345678-1234-1234-1234-123456789abc",
            "issuer::12345678-1234-1234-1234-123456789abz",
        ] {
            assert!(!is_grok_identity(invalid), "{invalid}");
        }
    }

    #[test]
    fn codex_newer_refresh_replaces_the_host_file() {
        let directory = Directory::new();
        let host = directory.write(
            "auth.json",
            &codex("account-1", "host", NOW - 60_000.0),
            0o600,
        );
        let refreshed = bytes(&codex("account-1", "refreshed", NOW - 1_000.0));
        assert_eq!(
            write_back("codex", &refreshed, &host, NOW).unwrap(),
            WriteBack::Written
        );
        assert_eq!(fs::read(&host).unwrap(), refreshed);
        assert_eq!(fs::metadata(&host).unwrap().mode() & 0o777, 0o600);
        // A second pass is a tie and leaves the file alone.
        assert_eq!(
            write_back("codex", &refreshed, &host, NOW).unwrap(),
            WriteBack::Kept
        );
    }

    #[test]
    fn codex_keeps_older_equal_other_account_implausible_and_api_key_hosts() {
        let host_value = codex("account-1", "host", NOW - 60_000.0);
        let cases = [
            (
                "older",
                bytes(&codex("account-1", "older", NOW - 120_000.0)),
                host_value.clone(),
            ),
            (
                "equal",
                bytes(&codex("account-1", "equal", NOW - 60_000.0)),
                host_value.clone(),
            ),
            (
                "other account",
                bytes(&codex("account-2", "other", NOW)),
                host_value.clone(),
            ),
            (
                "implausible",
                bytes(&codex("account-1", "future", NOW + 6.0 * 60_000.0)),
                host_value.clone(),
            ),
            (
                "unparseable source",
                bytes(
                    &json!({"tokens":{"account_id":"account-1","access_token":"a"},"last_refresh":"recently"}),
                ),
                host_value.clone(),
            ),
            (
                "api-key source",
                bytes(&json!({"OPENAI_API_KEY":"key"})),
                host_value.clone(),
            ),
            (
                "api-key host",
                bytes(&codex("account-1", "newer", NOW)),
                json!({"OPENAI_API_KEY":"key"}),
            ),
            (
                "unusable host",
                bytes(&codex("account-1", "newer", NOW)),
                json!({"tokens":{}}),
            ),
        ];
        for (name, source, host_value) in cases {
            let directory = Directory::new();
            let host = directory.write("auth.json", &host_value, 0o600);
            let before = fs::read(&host).unwrap();
            assert_eq!(
                write_back("codex", &source, &host, NOW).unwrap(),
                WriteBack::Kept,
                "{name}"
            );
            assert_eq!(fs::read(&host).unwrap(), before, "{name}");
        }
        // Within the five-minute skew allowance a future value is still accepted.
        let directory = Directory::new();
        let host = directory.write("auth.json", &host_value, 0o600);
        let skewed = bytes(&codex("account-1", "skewed", NOW + 4.0 * 60_000.0));
        assert_eq!(
            write_back("codex", &skewed, &host, NOW).unwrap(),
            WriteBack::Written
        );
    }

    #[test]
    fn grok_newer_expiry_replaces_the_host_file_in_every_encoding() {
        let host_expiry = (NOW / 1000.0) + 3_600.0;
        for refreshed_expiry in [
            json!(host_expiry + 60.0),
            json!((host_expiry + 60.0) * 1000.0),
            json!(rfc3339((host_expiry + 60.0) * 1000.0)),
        ] {
            let directory = Directory::new();
            let host = directory.write(
                "auth.json",
                &grok(IDENTITY, "host", json!(host_expiry)),
                0o600,
            );
            let refreshed = bytes(&grok(IDENTITY, "refreshed", refreshed_expiry));
            assert_eq!(
                write_back("grok", &refreshed, &host, NOW).unwrap(),
                WriteBack::Written
            );
            assert_eq!(fs::read(&host).unwrap(), refreshed);
        }
    }

    #[test]
    fn grok_keeps_older_equal_other_identity_missing_unreadable_and_implausible() {
        let host_expiry = (NOW / 1000.0) + 3_600.0;
        let other = "https://issuer.example::87654321-4321-4321-4321-cba987654321";
        let cases = [
            (
                "older",
                grok(IDENTITY, "older", json!(host_expiry - 60.0)),
                json!(host_expiry),
            ),
            (
                "equal",
                grok(IDENTITY, "equal", json!(host_expiry * 1000.0)),
                json!(host_expiry),
            ),
            (
                "other identity",
                grok(other, "other", json!(host_expiry + 60.0)),
                json!(host_expiry),
            ),
            (
                "missing source expiry",
                grok(IDENTITY, "none", Value::Null),
                json!(host_expiry),
            ),
            (
                "missing host expiry",
                grok(IDENTITY, "newer", json!(host_expiry + 60.0)),
                Value::Null,
            ),
            (
                "unreadable source expiry",
                grok(IDENTITY, "bad", json!("tomorrow")),
                json!(host_expiry),
            ),
            (
                "unreadable host expiry",
                grok(IDENTITY, "newer", json!(host_expiry + 60.0)),
                json!(true),
            ),
            (
                "implausible",
                grok(IDENTITY, "far", json!(NOW / 1000.0 + 401.0 * 86_400.0)),
                json!(host_expiry),
            ),
        ];
        for (name, source, host_expiry) in cases {
            let directory = Directory::new();
            let host = directory.write("auth.json", &grok(IDENTITY, "host", host_expiry), 0o600);
            let before = fs::read(&host).unwrap();
            assert_eq!(
                write_back("grok", &bytes(&source), &host, NOW).unwrap(),
                WriteBack::Kept,
                "{name}"
            );
            assert_eq!(fs::read(&host).unwrap(), before, "{name}");
        }
    }

    #[test]
    fn replacement_is_atomic_and_keeps_the_file_mode() {
        let directory = Directory::new();
        let host = directory.write(
            "auth.json",
            &codex("account-1", "host", NOW - 60_000.0),
            0o400,
        );
        let before = fs::metadata(&host).unwrap();
        let refreshed = bytes(&codex("account-1", "refreshed", NOW));
        assert_eq!(
            write_back("codex", &refreshed, &host, NOW).unwrap(),
            WriteBack::Written
        );
        let after = fs::metadata(&host).unwrap();
        // A new inode was renamed into place; the old one was never truncated.
        assert_ne!(after.ino(), before.ino());
        assert_eq!(after.mode() & 0o7777, 0o400);
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
        assert_eq!(fs::read(&host).unwrap(), refreshed);
        let entries: Vec<_> = fs::read_dir(&directory.0).unwrap().collect();
        assert_eq!(entries.len(), 1, "no temporary file remains");
    }

    #[test]
    fn never_creates_or_follows_an_invalid_host_file() {
        let refreshed = bytes(&codex("account-1", "refreshed", NOW));
        let directory = Directory::new();
        let missing = directory.0.join("auth.json");
        assert!(write_back("codex", &refreshed, &missing, NOW).is_err());
        assert!(!missing.exists());

        let target = directory.write(
            "target.json",
            &codex("account-1", "target", NOW - 60_000.0),
            0o600,
        );
        let link = directory.0.join("link.json");
        symlink(&target, &link).unwrap();
        assert!(write_back("codex", &refreshed, &link, NOW).is_err());
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_ne!(fs::read(&target).unwrap(), refreshed);

        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(write_back("codex", &refreshed, &target, NOW).is_err());
        assert_ne!(fs::read(&target).unwrap(), refreshed);
    }
}
