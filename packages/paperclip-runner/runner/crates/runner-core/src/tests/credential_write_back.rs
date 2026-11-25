use super::*;
use serde_json::json;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::PathBuf;

const NOW: f64 = 1_800_000_000_000.0;
const IDENTITY: &str = "https://issuer.example::12345678-1234-4234-8234-123456789abc";

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("credential-write-back-{}", uuid::Uuid::new_v4()));
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
