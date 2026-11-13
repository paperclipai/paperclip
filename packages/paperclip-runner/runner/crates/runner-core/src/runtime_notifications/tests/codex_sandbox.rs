#[test]
fn codex_activity_grant_uses_only_its_own_private_channel_directory() {
    let (_directory, config, _store, _state, server) = setup();
    let (_other_directory, _other_config, _other_store, _other_state, other) = setup();
    let channel = server.pipe.0.parent().unwrap();
    let other_channel = other.pipe.0.parent().unwrap();
    assert_ne!(channel, other_channel);
    verify_private_directory(channel).unwrap();
    assert!(fs::symlink_metadata(&server.pipe.0)
        .unwrap()
        .file_type()
        .is_fifo());
    let paths = [
        PathBuf::from("/runtime/runnerd"),
        context_path(&config.state_dir),
        server.pipe.0.with_extension("lock"),
        server.pipe.0.clone(),
    ];
    let profile = "paperclip-runner-workspace-read-only";
    let args = vec![
        "shell_environment_policy.include_only=[]".into(),
        format!("permissions.{profile}.filesystem={{\":root\"=\"none\"}}"),
    ];
    let projected = crate::codex_provider::runtime_notification_codex_args(&args, profile, &paths);
    let prefix = format!("permissions.{profile}.filesystem=");
    let value = projected
        .iter()
        .find_map(|arg| arg.strip_prefix(&prefix))
        .unwrap();
    let config = format!("filesystem={value}")
        .parse::<toml_edit::DocumentMut>()
        .unwrap();
    let filesystem = config["filesystem"].as_inline_table().unwrap();
    assert_eq!(
        filesystem
            .get(channel.to_str().unwrap())
            .and_then(toml_edit::Value::as_str),
        Some("write")
    );
    assert!(filesystem.get(other_channel.to_str().unwrap()).is_none());
    assert!(filesystem
        .get(paths[1].parent().unwrap().to_str().unwrap())
        .is_none());
}

#[test]
#[ignore = "requires source-pinned Linux CODEX_NOTIFICATION_SANDBOX_COMMAND or CODEX_NOTIFICATION_FIXTURE_EXPORT"]
fn read_only_codex_opens_with_runtime_activity_without_widening_file_access() {
    use std::process::Command;

    let directory = TestDirectory::create(&std::env::temp_dir()).unwrap();
    let config = config(directory.directory.join("state"));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&config.state_dir)
        .unwrap();
    let server = RuntimeNotifications::bind(&config.state_dir).unwrap();
    let workspace = directory.directory.join("workspace");
    let home = directory.directory.join("home");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&home).unwrap();
    fs::write(
        home.join("credential-fixture"),
        b"synthetic private credential",
    )
    .unwrap();
    fs::write(
        workspace.join("AGENTS.md"),
        b"Read-only fixture instructions.\n",
    )
    .unwrap();
    fs::write(
        config.state_dir.join("private-state"),
        b"must remain inaccessible",
    )
    .unwrap();
    let helper = config.state_dir.join("helper");
    fs::write(&helper, b"synthetic executable resource\n").unwrap();
    let paths = [
        helper,
        context_path(&config.state_dir),
        server.pipe.0.with_extension("lock"),
        server.pipe.0.clone(),
    ];
    let profile = "paperclip-runner-workspace-read-only";
    let resources = std::env::var("CODEX_NOTIFICATION_SANDBOX_RESOURCES")
        .expect("set the source-pinned Codex executable resource directory");
    let resources = serde_json::to_string(&resources).unwrap();
    let args = vec![
        "-c".into(),
        "shell_environment_policy.include_only=[\"PATH\"]".into(),
        "-c".into(),
        format!("permissions.{profile}.filesystem={{\":root\"=\"none\",\":minimal\"=\"read\",\":tmpdir\"=\"none\",{resources}=\"read\",\"{}\"=\"none\",\"{}\"=\"read\"}}", home.display(), workspace.display()),
        "-c".into(),
        format!("permissions.{profile}.network.enabled=false"),
    ];
    let extra = crate::codex_provider::runtime_notification_codex_args(&args, profile, &paths);
    let script = r#"
set -eu
test -z "${UNRELATED_SECRET:-}"
test "$(cat "$4/AGENTS.md")" = 'Read-only fixture instructions.'
if touch "$4/forbidden" 2>/dev/null; then exit 71; fi
if cat "$1/private-state" >/dev/null 2>&1; then exit 72; fi
if sh -c ': >> "$1"' ignored "$2" 2>/dev/null; then exit 73; fi
if sh -c ': >> "$1"' ignored "$3" 2>/dev/null; then exit 74; fi
if rm "$3" 2>/dev/null; then exit 75; fi
if cat "$6/credential-fixture" >/dev/null 2>&1; then exit 76; fi
cat "$2" >/dev/null
cat "$3" >/dev/null
printf 'synthetic notification frame\n' > "$5"
"#;
    let mut args = args;
    args.extend(extra);
    args.extend(["sandbox", "-P", profile, "-C"].map(str::to_owned));
    args.push(workspace.to_string_lossy().into_owned());
    args.extend(["--", "/bin/sh", "-c", script, "notification-sandbox"].map(str::to_owned));
    args.extend(
        [
            &config.state_dir,
            &paths[1],
            &paths[2],
            &workspace,
            &paths[3],
            &home,
        ]
        .map(|path| path.to_string_lossy().into_owned()),
    );
    if let Some(path) = std::env::var_os("CODEX_NOTIFICATION_FIXTURE_EXPORT") {
        fs::write(
            path,
            serde_json::to_vec_pretty(&json!({
                "args": args, "stateDirectory": config.state_dir,
                "pipe": server.pipe.0, "home": home, "workspace": workspace,
                "descriptor": fs::read_to_string(&paths[1]).unwrap(),
            }))
            .unwrap(),
        )
        .unwrap();
        return;
    }
    let command = std::env::var_os("CODEX_NOTIFICATION_SANDBOX_COMMAND").unwrap();
    let output = Command::new(command)
        .args(args)
        .current_dir(&workspace)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", &home)
        .env("CODEX_HOME", &home)
        .env("UNRELATED_SECRET", "must-not-reach-command")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "source-pinned sandbox failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
