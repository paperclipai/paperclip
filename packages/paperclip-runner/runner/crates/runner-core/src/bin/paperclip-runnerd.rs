use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use paperclip_runner_core::durable::{
    capture_bootstrap_ticket, redact_diagnostic_text, run_durable_runner, AcpxLaunchProfile,
    DurableRunnerConfig, OpenCodeLaunchProfile, QualifiedLaunchArtifact,
};
use paperclip_runner_core::local_runner::{run_local_runner, LocalRunnerError, RunnerConfig};
use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
use serde_json::json;

const RUNNERD_BUILD_METADATA_SCHEMA: &str = "paperclip-runner/runnerd-build-metadata/v1";
const RUNNER_DIAGNOSTIC_MAX_BYTES: usize = 64 * 1024;
const RUNNER_DIAGNOSTIC_TEMP_ATTEMPTS: usize = 32;

fn diagnostic_directory(args: &[String]) -> Option<PathBuf> {
    let index = args
        .iter()
        .position(|argument| argument == "--diagnostics-directory")?;
    args.get(index + 1).map(PathBuf::from)
}

fn bounded_redacted_diagnostic(message: &str) -> String {
    let mut diagnostic = redact_diagnostic_text(message);
    if diagnostic.len() <= RUNNER_DIAGNOSTIC_MAX_BYTES {
        return diagnostic;
    }
    let suffix = "…[truncated]";
    let byte_limit = RUNNER_DIAGNOSTIC_MAX_BYTES.saturating_sub(suffix.len());
    let boundary = diagnostic
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= byte_limit)
        .last()
        .unwrap_or(0);
    diagnostic.truncate(boundary);
    diagnostic.push_str(suffix);
    diagnostic
}

fn verify_private_diagnostics_directory(directory: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runner diagnostics path is not a real directory",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runner diagnostics directory is accessible by group or other users",
        ));
    }
    Ok(())
}

fn persist_runner_diagnostic(directory: &Path, message: &str) -> io::Result<()> {
    verify_private_diagnostics_directory(directory)?;
    let destination = directory.join("runnerd.stderr.log");
    let contents = bounded_redacted_diagnostic(message);
    let process_id = std::process::id();
    for attempt in 0..RUNNER_DIAGNOSTIC_TEMP_ATTEMPTS {
        let temporary = directory.join(format!(".runnerd.stderr.log.{process_id}.{attempt}.tmp"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = match options.open(&temporary) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let write_result = (|| {
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &destination)
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        return write_result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a runner diagnostic temporary file",
    ))
}

fn install_diagnostic_panic_hook(directory: Option<PathBuf>) {
    let Some(directory) = directory else {
        return;
    };
    std::panic::set_hook(Box::new(move |panic| {
        let _ = persist_runner_diagnostic(&directory, &format!("paperclip-runnerd panic: {panic}"));
    }));
}

fn build_metadata() -> serde_json::Value {
    json!({
        "schema": RUNNERD_BUILD_METADATA_SCHEMA,
        "binaryName": "paperclip-runnerd",
        "packageName": "@paperclipai/paperclip-runner",
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "binaryContractVersion": 2,
        "nativeExecutionVersion": 1,
        "harnessDriverVersion": 1,
        "prp": {
            "name": "paperclip.runner",
            "minimumVersion": 1,
            "maximumVersion": 1
        },
        "prpTransportModes": ["dial_ws_loopback", "dial_wss", "listen_ws"]
    })
}

fn value(args: &[String], name: &str) -> Result<String, LocalRunnerError> {
    let index = args
        .iter()
        .position(|argument| argument == name)
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing required argument {name}")))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))
}

fn optional_u64(args: &[String], name: &str) -> Result<Option<u64>, LocalRunnerError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    let value = args
        .get(index + 1)
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))?;
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| LocalRunnerError::invalid(format!("invalid {name}: {error}")))
}

fn optional_value(args: &[String], name: &str) -> Result<Option<String>, LocalRunnerError> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    args.get(index + 1)
        .cloned()
        .map(Some)
        .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))
}

fn acpx_launch_profile(args: &[String]) -> Result<Option<AcpxLaunchProfile>, LocalRunnerError> {
    let authority_digest = optional_value(args, "--acpx-launch-authority-digest")?;
    let command = optional_value(args, "--acpx-sidecar-command")?;
    let command_sha256 = optional_value(args, "--acpx-sidecar-command-sha256")?;
    let sidecar = optional_value(args, "--acpx-sidecar-script")?;
    let sidecar_sha256 = optional_value(args, "--acpx-sidecar-script-sha256")?;
    match (
        authority_digest,
        command,
        command_sha256,
        sidecar,
        sidecar_sha256,
    ) {
        (None, None, None, None, None) => Ok(None),
        (
            Some(authority_digest),
            Some(command),
            Some(command_sha256),
            Some(sidecar),
            Some(sidecar_sha256),
        ) => {
            let command = PathBuf::from(command);
            let sidecar = PathBuf::from(sidecar);
            Ok(Some(AcpxLaunchProfile {
                authority_digest,
                command: command.clone(),
                args: vec![sidecar.to_string_lossy().into_owned()],
                artifacts: vec![
                    QualifiedLaunchArtifact {
                        path: command,
                        sha256: command_sha256,
                    },
                    QualifiedLaunchArtifact {
                        path: sidecar,
                        sha256: sidecar_sha256,
                    },
                ],
            }))
        }
        _ => Err(LocalRunnerError::invalid(
            "ACPX sidecar launch profile requires its authority, command, script, and both SHA-256 digests",
        )),
    }
}

fn opencode_launch_profile(
    args: &[String],
) -> Result<Option<OpenCodeLaunchProfile>, LocalRunnerError> {
    let command = optional_value(args, "--opencode-proxy-command")?;
    let command_sha256 = optional_value(args, "--opencode-proxy-command-sha256")?;
    let proxy_script = optional_value(args, "--opencode-proxy-script")?;
    let proxy_script_sha256 = optional_value(args, "--opencode-proxy-script-sha256")?;
    let executable = optional_value(args, "--opencode-executable")?;
    let executable_sha256 = optional_value(args, "--opencode-executable-sha256")?;
    match (
        command,
        command_sha256,
        proxy_script,
        proxy_script_sha256,
        executable,
        executable_sha256,
    ) {
        (None, None, None, None, None, None) => Ok(None),
        (
            Some(command),
            Some(command_sha256),
            Some(proxy_script),
            Some(proxy_script_sha256),
            Some(executable),
            Some(executable_sha256),
        ) => Ok(Some(OpenCodeLaunchProfile {
            command: QualifiedLaunchArtifact {
                path: PathBuf::from(command),
                sha256: command_sha256,
            },
            proxy_script: QualifiedLaunchArtifact {
                path: PathBuf::from(proxy_script),
                sha256: proxy_script_sha256,
            },
            executable: QualifiedLaunchArtifact {
                path: PathBuf::from(executable),
                sha256: executable_sha256,
            },
        })),
        _ => Err(LocalRunnerError::invalid(
            "OpenCode launch profile requires command, proxy, executable, and all SHA-256 digests",
        )),
    }
}

fn usize_value(args: &[String], name: &str, default: usize) -> Result<usize, LocalRunnerError> {
    optional_u64(args, name)?.map_or(Ok(default), |value| {
        usize::try_from(value)
            .map_err(|error| LocalRunnerError::invalid(format!("invalid {name}: {error}")))
    })
}

fn run_durable(args: &[String]) -> Result<(), LocalRunnerError> {
    let ticket = capture_bootstrap_ticket()
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))?
        .ok_or_else(|| {
            LocalRunnerError::invalid(
                "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET is required for durable mode",
            )
        })?;
    let duration = |name: &str, default: u64| {
        optional_u64(args, name).map(|value| Duration::from_millis(value.unwrap_or(default)))
    };
    let state_dir = PathBuf::from(value(args, "--state-dir")?);
    let run_id = value(args, "--run-id")?;
    let has_connect = args.iter().any(|argument| argument == "--connect-url");
    let has_listener = ["--listen-address", "--listen-port", "--listen-path"]
        .iter()
        .any(|name| args.iter().any(|argument| argument == name));
    let connect_url = match (has_connect, has_listener) {
        (true, false) => value(args, "--connect-url")?,
        (false, true) => {
            let address = value(args, "--listen-address")?;
            let port = value(args, "--listen-port")?;
            let path = value(args, "--listen-path")?;
            if address != "0.0.0.0" || port != "43127" {
                return Err(LocalRunnerError::invalid(
                    "runner listener requires --listen-address 0.0.0.0 and --listen-port 43127",
                ));
            }
            if path != format!("/api/runner/v1/connect/{run_id}") {
                return Err(LocalRunnerError::invalid(
                    "runner listener path must exactly match the configured run",
                ));
            }
            format!("listen://{address}:{port}{path}")
        }
        _ => {
            return Err(LocalRunnerError::invalid(
                "durable runner requires exactly one connect URL or complete listener group",
            ))
        }
    };
    let ca_bundle_path = args
        .iter()
        .any(|argument| argument == "--ca-bundle-path")
        .then(|| value(args, "--ca-bundle-path").map(PathBuf::from))
        .transpose()?;
    if ca_bundle_path.is_some() && !connect_url.starts_with("wss://") {
        return Err(LocalRunnerError::invalid(
            "--ca-bundle-path is accepted only with wss://",
        ));
    }
    let config = DurableRunnerConfig {
        connect_url,
        ca_bundle_path,
        state_dir: state_dir.clone(),
        runner_instance_id: value(args, "--runner-id")?,
        environment_lease_id: value(args, "--environment-lease-id")?,
        run_id,
        normalized_session_id: value(args, "--session-id")?,
        turn_id: value(args, "--turn-id")?,
        item_id: value(args, "--item-id")?,
        runner_version: value(args, "--runner-version")?,
        runner_digest: value(args, "--runner-digest")?,
        acpx_launch_profile: acpx_launch_profile(args)?,
        opencode_launch_profile: opencode_launch_profile(args)?,
        max_outbox_bytes: usize_value(args, "--max-outbox-bytes", 16 * 1024 * 1024)?,
        p0_reserve_bytes: usize_value(args, "--p0-reserve-bytes", 1024 * 1024)?,
        max_frame_bytes: usize_value(args, "--max-frame-bytes", 1024 * 1024)?,
        reconnect_delay: duration("--reconnect-delay-ms", 250)?,
        reconnect_grace: optional_u64(args, "--reconnect-grace-ms")?.map(Duration::from_millis),
        max_runtime: duration("--max-runtime-ms", 60 * 60 * 1000)?,
    };
    let executor = NativeProviderCommandExecutor::with_runner_config(state_dir, &config);
    run_durable_runner(config, ticket, executor)
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))
}

fn run(args: &[String]) -> Result<(), LocalRunnerError> {
    if args == ["--build-metadata"] {
        println!("{}", build_metadata());
        return Ok(());
    }
    if args.iter().any(|argument| argument == "--connect-url")
        || args.iter().any(|argument| argument == "--listen-address")
        || args.iter().any(|argument| argument == "--listen-port")
        || args.iter().any(|argument| argument == "--listen-path")
    {
        return run_durable(args);
    }
    run_local_runner(RunnerConfig {
        run_id: value(args, "--run-id")?,
        normalized_session_id: value(args, "--session-id")?,
        runner_instance_id: value(args, "--runner-id")?,
        fake_harness_path: PathBuf::from(value(args, "--fake-harness")?),
        script_path: PathBuf::from(value(args, "--script")?),
        delay_override_ms: optional_u64(args, "--delay-ms")?,
        log_max_lines: usize_value(args, "--log-max-lines", 32)?,
        log_max_bytes: usize_value(args, "--log-max-bytes", 16_384)?,
        command_history_limit: usize_value(args, "--command-history-limit", 4096)?,
        controller_max_line_bytes: usize_value(args, "--controller-max-line-bytes", 64 * 1024)?,
        harness_max_line_bytes: usize_value(args, "--harness-max-line-bytes", 64 * 1024)?,
        shutdown_grace: Duration::from_millis(
            optional_u64(args, "--shutdown-grace-ms")?.unwrap_or(100),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_metadata_advertises_the_remote_transport_contract() {
        let metadata = build_metadata();
        assert_eq!(metadata["schema"], RUNNERD_BUILD_METADATA_SCHEMA);
        assert_eq!(metadata["binaryContractVersion"], 2);
        assert_eq!(
            metadata["prpTransportModes"],
            json!(["dial_ws_loopback", "dial_wss", "listen_ws"])
        );
    }

    #[test]
    fn persistent_diagnostic_is_private_bounded_and_redacted() {
        let unique = format!(
            "paperclip-runnerd-diagnostic-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("test clock is after the Unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        fs::create_dir(&directory).expect("create diagnostic test directory");
        #[cfg(unix)]
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("make diagnostic test directory private");
        let path = directory.join("runnerd.stderr.log");
        fs::write(&path, "").expect("create runner diagnostic placeholder");
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("make runner diagnostic placeholder private");

        let diagnostic = format!(
            "OPENAI_API_KEY=raw-secret Authorization: Bearer another-secret {}",
            "x".repeat(RUNNER_DIAGNOSTIC_MAX_BYTES * 4)
        );
        persist_runner_diagnostic(&directory, &diagnostic)
            .expect("persist bounded runner diagnostic");

        let persisted = fs::read_to_string(&path).expect("read runner diagnostic");
        assert!(persisted.len() <= RUNNER_DIAGNOSTIC_MAX_BYTES);
        assert!(!persisted.contains("raw-secret"));
        assert!(!persisted.contains("another-secret"));
        assert!(persisted.contains("[REDACTED]"));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path)
                .expect("read runner diagnostic metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        fs::remove_dir_all(directory).expect("remove diagnostic test directory");
    }
}

fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let diagnostics_directory = diagnostic_directory(&args);
    install_diagnostic_panic_hook(diagnostics_directory.clone());
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = format!("paperclip-runnerd: {error}");
            if let Some(directory) = diagnostics_directory {
                if let Err(persist_error) = persist_runner_diagnostic(&directory, &message) {
                    eprintln!(
                        "paperclip-runnerd: failed to persist bounded diagnostic: {persist_error}"
                    );
                }
            } else {
                eprintln!("{message}");
            }
            ExitCode::FAILURE
        }
    }
}
