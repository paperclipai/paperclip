use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Fixture {
    root: PathBuf,
    observer: CredentialObserver,
}
impl Fixture {
    fn new(provider: &str, seed: &Value) -> Self {
        let root =
            std::env::temp_dir().join(format!("credential-observer-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let mut observer = CredentialObserver::new(&root, "session");
        observer.loaded = true;
        observer.state = Some(State {
            schema: SCHEMA.to_owned(),
            session_id: "session".to_owned(),
            provider: provider.to_owned(),
            path: root.join("auth.json"),
            snapshot: parse_snapshot(provider, &serde_json::to_vec(seed).unwrap()),
            revision: 0,
            armed: false,
            pending: None,
            host_file: None,
            silent: false,
        });
        observer.save(observer.state.as_ref().unwrap()).unwrap();
        Self { root, observer }
    }
    fn write(&self, name: &str, value: &Value) {
        let path = self.root.join(name);
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.observer.watcher = None;
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn codex(marker: &str) -> Value {
    json!({"tokens":{"account_id":"account-1", "access_token":format!("access-{marker}"),
        "refresh_token":format!("refresh-{marker}"), "id_token":format!("identity-{marker}")}, "last_refresh":"metadata"})
}
fn grok(marker: &str) -> Value {
    json!({"https://issuer.example::12345678-1234-1234-1234-123456789abc":{
        "key":format!("access-{marker}"), "refresh_token":format!("refresh-{marker}"), "expires_at":1234}})
}

#[test]
fn refresh_is_durable_replayable_content_free_and_monotonic() {
    let mut f = Fixture::new("codex", &codex("before"));
    f.write("auth.json", &codex("before"));
    f.observer.activate().unwrap();
    assert!(f.observer.pending().is_none());
    f.write("auth.json", &codex("after"));
    f.observer.poll(true).unwrap();
    let event = f.observer.pending().unwrap();
    assert_eq!(event, update_event("codex", 1));
    let persisted = fs::read_to_string(f.root.join(STATE_FILE)).unwrap();
    for secret in [
        "access-before",
        "refresh-before",
        "identity-before",
        "access-after",
        "refresh-after",
        "identity-after",
    ] {
        assert!(!persisted.contains(secret));
        assert!(!event.payload.to_string().contains(secret));
    }
    let mut recovered = CredentialObserver::new(&f.root, "session");
    recovered.restore().unwrap();
    assert_eq!(recovered.pending(), Some(event));
    f.write("auth.json", &codex("newest"));
    recovered.poll(true).unwrap();
    assert_eq!(recovered.pending(), Some(update_event("codex", 1)));
    recovered.acknowledge(1).unwrap();
    recovered.poll(true).unwrap();
    assert_eq!(recovered.pending(), Some(update_event("codex", 2)));
    recovered.acknowledge(1).unwrap();
    recovered.poll(true).unwrap();
    assert!(recovered.pending().is_none());
    assert_eq!(recovered.state.as_ref().unwrap().revision, 2);
}

#[test]
fn directory_watch_handles_atomic_replacement() {
    let mut f = Fixture::new("codex", &codex("before"));
    f.write("auth.json", &codex("before"));
    f.observer.activate().unwrap();
    f.observer.dirty.store(false, Ordering::Relaxed);
    f.write("auth.tmp", &codex("after"));
    fs::rename(f.root.join("auth.tmp"), f.root.join("auth.json")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while f.observer.pending().is_none() && Instant::now() < deadline {
        f.observer.poll(false).unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
}

#[test]
fn periodic_reread_works_without_native_notifications() {
    let mut f = Fixture::new("codex", &codex("before"));
    f.write("auth.json", &codex("before"));
    f.observer.activate().unwrap();
    f.write("auth.json", &codex("after"));
    f.observer.watcher = None;
    f.observer.dirty.store(false, Ordering::Relaxed);
    f.observer.last_scan = Instant::now() - SCAN_INTERVAL;
    f.observer.poll(false).unwrap();
    assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
}

#[test]
fn ignores_metadata_partial_writes_and_deletion() {
    let mut f = Fixture::new("codex", &codex("before"));
    f.write("auth.json", &codex("before"));
    f.observer.activate().unwrap();
    let mut metadata = codex("before");
    metadata["last_refresh"] = json!("new metadata");
    f.write("auth.json", &metadata);
    f.observer.poll(true).unwrap();
    assert!(f.observer.pending().is_none());
    fs::write(f.root.join("auth.json"), "{partial").unwrap();
    f.observer.poll(true).unwrap();
    assert!(f.observer.pending().is_none());
    fs::remove_file(f.root.join("auth.json")).unwrap();
    f.observer.poll(true).unwrap();
    f.write("auth.json", &codex("after"));
    f.observer.poll(true).unwrap();
    assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
}

#[test]
fn account_changes_and_later_refreshes_survive_recovery_without_exposing_identity() {
    for provider in ["codex", "grok"] {
        let original = if provider == "codex" {
            codex("before")
        } else {
            grok("before")
        };
        let mut f = Fixture::new(provider, &original);
        f.write("auth.json", &original);
        f.observer.activate().unwrap();
        let mut changed = original.clone();
        let account = if provider == "codex" {
            changed["tokens"]["account_id"] = json!("different-account");
            "different-account"
        } else {
            let auth = changed
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .clone();
            changed = json!({"https://issuer.example::87654321-4321-4321-4321-cba987654321": auth});
            "87654321-4321-4321-4321-cba987654321"
        };
        f.write("auth.json", &changed);
        f.observer.poll(true).unwrap();
        assert_eq!(f.observer.pending(), Some(update_event(provider, 1)));
        let persisted = fs::read_to_string(f.root.join(STATE_FILE)).unwrap();
        assert!(!persisted.contains(account));
        assert!(!f
            .observer
            .pending()
            .unwrap()
            .payload
            .to_string()
            .contains(account));
        let mut recovered = CredentialObserver::new(&f.root, "session");
        recovered.restore().unwrap();
        assert_eq!(recovered.pending(), Some(update_event(provider, 1)));
        if provider == "codex" {
            changed["tokens"]["access_token"] = json!("refreshed-access");
        } else {
            changed
                .as_object_mut()
                .unwrap()
                .values_mut()
                .next()
                .unwrap()["key"] = json!("refreshed-access");
        }
        f.write("auth.json", &changed);
        recovered.poll(true).unwrap();
        assert_eq!(recovered.pending(), Some(update_event(provider, 1)));
        recovered.acknowledge(1).unwrap();
        recovered.poll(true).unwrap();
        assert_eq!(recovered.pending(), Some(update_event(provider, 2)));
        recovered.acknowledge(1).unwrap();
        recovered.poll(true).unwrap();
        assert!(recovered.pending().is_none());
        f.write("auth.json", &original);
        recovered.poll(true).unwrap();
        assert_eq!(recovered.pending(), Some(update_event(provider, 3)));
    }
}

#[test]
fn grok_seed_catches_pre_start_refresh_and_close_handoff() {
    let mut f = Fixture::new("grok", &grok("seed"));
    f.observer.poll(true).unwrap();
    assert!(f.observer.pending().is_none());
    f.write("auth.json", &grok("startup"));
    f.observer.activate().unwrap();
    assert_eq!(f.observer.pending(), Some(update_event("grok", 1)));
    f.observer.acknowledge(1).unwrap();
    f.write("auth-refresh.json", &grok("close"));
    fs::remove_file(f.root.join("auth.json")).unwrap();
    f.observer.poll(true).unwrap();
    assert_eq!(f.observer.pending(), Some(update_event("grok", 2)));
}

#[test]
fn codex_close_handoff_preserves_shutdown_refresh() {
    let mut f = Fixture::new("codex", &codex("seed"));
    f.write("auth.json", &codex("seed"));
    f.observer.activate().unwrap();
    assert!(f.observer.pending().is_none());
    f.write("auth-refresh.json", &codex("close"));
    fs::remove_file(f.root.join("auth.json")).unwrap();
    f.observer.poll(true).unwrap();
    assert_eq!(f.observer.pending(), Some(update_event("codex", 1)));
    f.observer.acknowledge(1).unwrap();
    f.observer.poll(true).unwrap();
    assert!(f.observer.pending().is_none());
}

#[test]
fn rejects_symlinks_unsafe_permissions_and_oversized_stores() {
    let f = Fixture::new("codex", &codex("seed"));
    f.write("auth.json", &codex("seed"));
    symlink(f.root.join("auth.json"), f.root.join("symlink.json")).unwrap();
    assert!(read_snapshot("codex", &f.root.join("symlink.json")).is_none());
    symlink(&f.root, f.root.join("parent-link")).unwrap();
    assert!(read_snapshot("codex", &f.root.join("parent-link/auth.json")).is_none());
    fs::set_permissions(f.root.join("auth.json"), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_snapshot("codex", &f.root.join("auth.json")).is_none());
    fs::set_permissions(f.root.join("auth.json"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(f.root.join("auth.json"), vec![b' '; MAX_BYTES as usize + 1]).unwrap();
    assert!(read_snapshot("codex", &f.root.join("auth.json")).is_none());
}

#[test]
fn observer_requires_opt_in_and_rejects_cross_session_recovery() {
    let f = Fixture::new("codex", &codex("seed"));
    let mut wrong_session = CredentialObserver::new(&f.root, "different-session");
    assert!(wrong_session.restore().is_err());
    let path = f.root.join("unused");
    fs::create_dir(&path).unwrap();
    let mut disabled = CredentialObserver::new(&path, "session");
    disabled
        .configure(&json!({"provider":{"kind":"codex"}}))
        .unwrap();
    assert!(disabled.state.is_none());
    disabled
        .configure(&json!({"observeCredentials":true,"provider":{"kind":"opencode"}}))
        .unwrap();
    assert!(disabled.state.is_none());
}

#[test]
fn fresh_acpx_observers_create_a_private_runtime_directory() {
    let f = Fixture::new("codex", &codex("seed"));
    for provider in ["codex", "grok"] {
        let state_dir = f.root.join(provider);
        fs::create_dir(&state_dir).unwrap();
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = state_dir.join("runtime");
        assert!(!runtime.exists());
        let mut observer = CredentialObserver::new(&state_dir, "session");
        observer.configure(&json!({"observeCredentials":true,"provider":{
            "kind":"acpx", "agent":provider, "runtimeDirectory":runtime, "normalizedSessionId":"session"
        }})).unwrap();
        assert_eq!(
            fs::metadata(&runtime).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(observer.state.as_ref().unwrap().provider, provider);
        assert!(observer.pending().is_none());
        observer.activate().unwrap();
        assert!(observer.pending().is_none());
    }
}

fn codex_at(marker: &str, last_refresh: &str) -> Value {
    let mut value = codex(marker);
    value["last_refresh"] = json!(last_refresh);
    value
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn with_host_file(f: &mut Fixture, silent: bool) -> PathBuf {
    let host = f.root.join("host").join("auth.json");
    fs::create_dir(host.parent().unwrap()).unwrap();
    let state = f.observer.state.as_mut().unwrap();
    state.host_file = Some(host.clone());
    state.silent = silent;
    let state = state.clone();
    f.observer.save(&state).unwrap();
    host
}

#[test]
fn host_file_receives_refreshes_during_the_session_and_at_close() {
    for silent in [false, true] {
        let seed = codex_at("seed", "2026-01-01T00:00:00Z");
        let mut f = Fixture::new("codex", &seed);
        let host = with_host_file(&mut f, silent);
        f.write("host/auth.json", &seed);
        f.write("auth.json", &seed);
        f.observer.activate().unwrap();
        assert!(f.observer.pending().is_none());
        for (marker, at) in [
            ("refreshed", "2026-02-01T00:00:00Z"),
            ("later", "2026-03-01T00:00:00Z"),
        ] {
            f.write("auth.json", &codex_at(marker, at));
            f.observer.poll(true).unwrap();
            assert_eq!(fs::read(&host).unwrap(), bytes(&codex_at(marker, at)));
            // Write-back does not wait for the first event's acknowledgement,
            // and a write-back-only binding emits no events.
            let expected = (!silent).then(|| update_event("codex", 1));
            assert_eq!(f.observer.pending(), expected, "silent={silent}");
        }
        let closed = codex_at("closed", "2026-04-01T00:00:00Z");
        f.write("auth-refresh.json", &closed);
        fs::remove_file(f.root.join("auth.json")).unwrap();
        f.observer.poll(true).unwrap();
        assert_eq!(fs::read(&host).unwrap(), bytes(&closed));
    }
}

#[test]
fn a_failed_write_back_fails_the_poll_without_exposing_the_credential() {
    let seed = codex_at("seed", "2026-01-01T00:00:00Z");
    let mut f = Fixture::new("codex", &seed);
    let host = with_host_file(&mut f, true);
    f.write("host/auth.json", &seed);
    f.write("auth.json", &seed);
    f.observer.activate().unwrap();
    fs::remove_file(&host).unwrap();
    let refreshed = codex_at("refreshed", "2026-02-01T00:00:00Z");
    f.write("auth.json", &refreshed);
    // The host file is gone: nothing is created and the poll fails.
    let error = f.observer.poll(true).unwrap_err().to_string();
    assert!(error.contains("write-back to the host credential file failed"));
    assert!(!error.contains("refreshed"));
    assert!(!host.exists());
    f.write("host/auth.json", &seed);
    f.observer.poll(true).unwrap();
    assert_eq!(fs::read(&host).unwrap(), bytes(&refreshed));
}

#[test]
fn a_repaired_host_file_receives_the_refresh_it_was_kept_from() {
    let seed = codex_at("seed", "2026-01-01T00:00:00Z");
    let mut f = Fixture::new("codex", &seed);
    let host = with_host_file(&mut f, true);
    f.write("host/auth.json", &seed);
    f.write("auth.json", &seed);
    f.observer.activate().unwrap();
    let refreshed = codex_at("refreshed", "2026-02-01T00:00:00Z");
    f.write("auth.json", &refreshed);
    // A host rewrite left malformed JSON: the refresh is kept back.
    fs::write(&host, b"{\"tokens\":").unwrap();
    fs::set_permissions(&host, fs::Permissions::from_mode(0o600)).unwrap();
    f.observer.poll(true).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"{\"tokens\":");
    // The same refreshed bytes are compared again once the host file changes.
    f.write("host/auth.json", &seed);
    f.observer.poll(true).unwrap();
    assert_eq!(fs::read(&host).unwrap(), bytes(&refreshed));
}

#[test]
fn host_file_binding_seeds_the_baseline_and_needs_an_acpx_file_session() {
    assert!(parse_host_credential_file(Some("relative/auth.json".into())).is_err());
    assert_eq!(parse_host_credential_file(Some("".into())).unwrap(), None);
    let f = Fixture::new("codex", &codex("seed"));
    let seed = codex_at("seed", "2026-01-01T00:00:00Z");
    let host = f.root.join("host-auth.json");
    f.write("host-auth.json", &seed);
    let runtime = f.root.join("runtime");
    for (provider, accepted) in [
        (json!({"kind":"codex"}), false),
        (
            json!({"kind":"acpx", "agent":"claude", "runtimeDirectory":runtime, "normalizedSessionId":"session"}),
            false,
        ),
        (
            json!({"kind":"acpx", "agent":"codex", "runtimeDirectory":runtime, "normalizedSessionId":"session"}),
            true,
        ),
    ] {
        let state_dir = f.root.join(format!("state-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&state_dir).unwrap();
        fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700)).unwrap();
        let mut observer = CredentialObserver::new(&state_dir, "session");
        observer.loaded = true;
        // No event opt-in: the binding alone configures write-back.
        let result =
            observer.configure_with_host_file(&json!({"provider":provider}), Some(host.clone()));
        if !accepted {
            let error = result.unwrap_err();
            assert!(error.to_string().contains("Codex or Grok ACPX"), "{error}");
            assert!(observer.state.is_none());
            continue;
        }
        result.unwrap();
        let state = observer.state.as_ref().unwrap();
        assert!(state.silent);
        assert_eq!(state.host_file, Some(host.clone()));
        assert_eq!(state.snapshot, parse_snapshot("codex", &bytes(&seed)));
    }
}

#[test]
fn acpx_directory_matches_the_typescript_session_layout() {
    assert_eq!(
        acpx_session_directory("session-1"),
        "session-1-84097828fc31a8c8"
    );
    let session = "...";
    assert!(acpx_session_directory(session).starts_with("session-"));
}

/// Saved observer state for an ACPX session home, as `configure` lays it out.
fn acpx_recovery_fixture(f: &Fixture, host_file: Option<PathBuf>) -> PathBuf {
    let home = f.root.join("runtime/acpx/session-dir/codex-home");
    fs::create_dir_all(&home).unwrap();
    for directory in [
        f.root.join("runtime"),
        f.root.join("runtime/acpx"),
        f.root.join("runtime/acpx/session-dir"),
        home.clone(),
    ] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let seed = codex_at("seed", "2026-01-01T00:00:00Z");
    let mut state = f.observer.state.clone().unwrap();
    state.path = home.join("auth.json");
    state.snapshot = parse_snapshot("codex", &serde_json::to_vec(&seed).unwrap());
    state.revision = 1;
    state.armed = true;
    state.pending = Some(update_event("codex", 1));
    state.host_file = host_file;
    f.observer.save(&state).unwrap();
    fs::write(
        home.join("auth.json"),
        serde_json::to_vec(&codex_at("refreshed", "2026-02-01T00:00:00Z")).unwrap(),
    )
    .unwrap();
    fs::set_permissions(home.join("auth.json"), fs::Permissions::from_mode(0o600)).unwrap();
    home
}

fn write_host(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn recovery_follows_the_host_file_the_runner_names() {
    let seed = codex_at("seed", "2026-01-01T00:00:00Z");
    let refreshed = codex_at("refreshed", "2026-02-01T00:00:00Z");
    // Adopt a newly supplied file, switch to a changed one, drop a removed one.
    for (saved, current) in [
        (None, Some("host-a")),
        (Some("host-a"), Some("host-b")),
        (Some("host-a"), None),
    ] {
        let f = Fixture::new("codex", &codex("seed"));
        let path = |name: &str| f.root.join(name).join("auth.json");
        for name in ["host-a", "host-b"] {
            write_host(&path(name), &seed);
        }
        acpx_recovery_fixture(&f, saved.map(path));
        let current = current.map(path);
        let mut recovered = CredentialObserver::new(&f.root, "session");
        recovered
            .restore_with_host_file(|| Ok(current.clone()))
            .unwrap();
        let persisted: State =
            serde_json::from_slice(&fs::read(f.root.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(persisted.host_file, current);
        assert_eq!(persisted.revision, 1);
        recovered.poll(true).unwrap();
        for name in ["host-a", "host-b"] {
            let expected = if current == Some(path(name)) {
                &refreshed
            } else {
                &seed
            };
            assert_eq!(fs::read(path(name)).unwrap(), bytes(expected), "{name}");
        }
        assert_eq!(recovered.pending(), Some(update_event("codex", 1)));
    }
}

#[test]
fn recovery_rejects_a_host_file_for_a_native_codex_home() {
    let f = Fixture::new("codex", &codex("seed"));
    let mut recovered = CredentialObserver::new(&f.root, "session");
    let error = recovered
        .restore_with_host_file(|| Ok(Some(f.root.join("host/auth.json"))))
        .err()
        .expect("a native home has no file credential");
    assert!(error.to_string().contains("Codex or Grok ACPX"), "{error}");
}
