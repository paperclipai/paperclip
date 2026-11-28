use super::*;
use serde_json::json;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::PathBuf;

/// 2027-01-15T08:00:00Z.
const NOW: f64 = 1_800_000_000_000.0;
const IDENTITY: &str = "https://issuer.example::12345678-1234-4234-8234-123456789abc";
const OTHER: &str = "https://issuer.example::87654321-4321-4321-4321-cba987654321";

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
        fs::write(&path, bytes(value)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }
    fn entries(&self) -> usize {
        fs::read_dir(&self.0).unwrap().count()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn codex(account: &str, last_refresh: &str) -> Value {
    json!({"tokens":{"account_id":account, "access_token":"access", "refresh_token":"refresh"},
        "last_refresh": last_refresh})
}

fn grok(identity: &str, expires_at: Value) -> Value {
    json!({ identity: {"key":"access", "refresh_token":"refresh", "expires_at": expires_at}})
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

#[test]
fn replacement_follows_the_adapter_freshness_rules() {
    let codex_host = codex("account-1", "2027-01-15T07:59:00Z");
    let grok_host = grok(IDENTITY, json!(1_800_003_600));
    let api_key = json!({"OPENAI_API_KEY":"key"});
    #[rustfmt::skip]
    let cases = [
        ("codex newer", "codex", codex("account-1", "2027-01-15T07:59:59Z"), &codex_host, true),
        ("codex newer offset", "codex", codex("account-1", "2027-01-15T09:59:30+02:00"), &codex_host, true),
        ("codex within skew", "codex", codex("account-1", "2027-01-15T08:04:00Z"), &codex_host, true),
        ("codex implausible", "codex", codex("account-1", "2027-01-15T08:06:00Z"), &codex_host, false),
        ("codex older", "codex", codex("account-1", "2027-01-15T07:58:00Z"), &codex_host, false),
        ("codex equal", "codex", codex("account-1", "2027-01-15T07:59:00.000999Z"), &codex_host, false),
        ("codex other account", "codex", codex("account-2", "2027-01-15T07:59:59Z"), &codex_host, false),
        ("codex unparseable", "codex", codex("account-1", "recently"), &codex_host, false),
        ("codex api-key source", "codex", api_key.clone(), &codex_host, false),
        ("codex api-key host", "codex", codex("account-1", "2027-01-15T07:59:59Z"), &api_key, false),
        ("grok newer seconds", "grok", grok(IDENTITY, json!(1_800_003_660)), &grok_host, true),
        ("grok newer milliseconds", "grok", grok(IDENTITY, json!(1_800_003_660_000_u64)), &grok_host, true),
        ("grok newer ISO", "grok", grok(IDENTITY, json!("2027-01-15T09:01:00Z")), &grok_host, true),
        ("grok older", "grok", grok(IDENTITY, json!(1_800_003_540)), &grok_host, false),
        ("grok equal", "grok", grok(IDENTITY, json!(1_800_003_600_000_u64)), &grok_host, false),
        ("grok other identity", "grok", grok(OTHER, json!(1_800_003_660)), &grok_host, false),
        ("grok invalid identity", "grok", grok("issuer:12345678-1234-4234-8234-123456789abc", json!(1_800_003_660)), &grok_host, false),
        ("grok missing expiry", "grok", grok(IDENTITY, Value::Null), &grok_host, false),
        ("grok unreadable expiry", "grok", grok(IDENTITY, json!("tomorrow")), &grok_host, false),
        ("grok implausible", "grok", grok(IDENTITY, json!(1_800_000_000 + 401 * 86_400)), &grok_host, false),
        ("grok host expiry missing", "grok", grok(IDENTITY, json!(1_800_003_660)), &grok(IDENTITY, Value::Null), false),
    ];
    for (name, provider, source, destination, expected) in cases {
        let decision = prefer_source(
            &freshness(provider, &bytes(&source)),
            &freshness(provider, &bytes(destination)),
            NOW,
        );
        assert_eq!(decision, expected, "{name}");
    }
}

#[test]
fn replacement_is_atomic_and_keeps_the_file_mode() {
    let directory = Directory::new();
    let host = directory.write(
        "auth.json",
        &codex("account-1", "2027-01-15T07:59:00Z"),
        0o400,
    );
    let before = fs::metadata(&host).unwrap();
    let refreshed = bytes(&codex("account-1", "2027-01-15T07:59:59Z"));
    assert_eq!(
        write_back("codex", &refreshed, &host, NOW).unwrap(),
        WriteBack::Written
    );
    let after = fs::metadata(&host).unwrap();
    // A new inode was renamed into place; the old one was never truncated.
    assert_ne!(after.ino(), before.ino());
    assert_eq!(after.mode() & 0o7777, 0o400);
    assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
    assert_eq!(fs::read(&host).unwrap(), refreshed);
    assert_eq!(directory.entries(), 1, "no temporary file remains");
    // A second pass is a tie and leaves the file alone, tied to that file.
    assert_eq!(
        write_back("codex", &refreshed, &host, NOW).unwrap(),
        WriteBack::Kept(host_stamp(&host))
    );
}

#[test]
fn never_creates_follows_or_writes_an_unsafe_host_file() {
    let refreshed = bytes(&codex("account-1", "2027-01-15T07:59:59Z"));
    let directory = Directory::new();
    let missing = directory.0.join("auth.json");
    assert!(write_back("codex", &refreshed, &missing, NOW).is_err());
    assert!(!missing.exists());

    let target = directory.write(
        "target.json",
        &codex("account-1", "2027-01-15T07:59:00Z"),
        0o600,
    );
    let link = directory.0.join("link.json");
    symlink(&target, &link).unwrap();
    let open = directory.write(
        "open.json",
        &codex("account-1", "2027-01-15T07:59:00Z"),
        0o644,
    );
    for path in [link, open] {
        let before = fs::read(&path).unwrap();
        assert!(write_back("codex", &refreshed, &path, NOW).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    assert!(fs::symlink_metadata(directory.0.join("link.json"))
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn abandons_the_replacement_when_the_host_file_changes() {
    let directory = Directory::new();
    let host = directory.write(
        "auth.json",
        &codex("account-1", "2027-01-15T07:59:00Z"),
        0o600,
    );
    let (_, decided) = read_host_credential(&host).unwrap();
    // The host replaces its file after the decision read.
    let rewritten = directory.write(
        "next.json",
        &codex("account-1", "2027-01-15T07:59:30Z"),
        0o600,
    );
    fs::rename(&rewritten, &host).unwrap();
    let refreshed = bytes(&codex("account-1", "2027-01-15T07:59:59Z"));
    assert_eq!(
        replace_if_unchanged(&refreshed, &host, &decided).unwrap(),
        WriteBack::Raced
    );
    assert_eq!(
        fs::read(&host).unwrap(),
        bytes(&codex("account-1", "2027-01-15T07:59:30Z"))
    );
    assert_eq!(
        directory.entries(),
        1,
        "the abandoned replacement is removed"
    );
}
