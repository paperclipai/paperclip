use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use paperclip_runner_core::durable::{
    capture_bootstrap_ticket, run_durable_runner, BootstrapTicket, DurableRunnerConfig,
};
use paperclip_runner_core::local_runner::{run_local_runner, LocalRunnerError, RunnerConfig};
use serde_json::json;

const RUNNERD_BUILD_METADATA_SCHEMA: &str = "paperclip-runner/runnerd-build-metadata/v1";

fn build_metadata() -> serde_json::Value {
    json!({
        "schema": RUNNERD_BUILD_METADATA_SCHEMA,
        "binaryName": "paperclip-runnerd",
        "packageName": "@paperclipai/paperclip-runner",
        "packageVersion": env!("CARGO_PKG_VERSION"),
        "binaryContractVersion": 1,
        "nativeExecutionVersion": 1,
        "harnessDriverVersion": 1,
        "prp": {
            "name": "paperclip.runner",
            "minimumVersion": 1,
            "maximumVersion": 1
        }
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

fn usize_value(args: &[String], name: &str, default: usize) -> Result<usize, LocalRunnerError> {
    optional_u64(args, name)?.map_or(Ok(default), |value| {
        usize::try_from(value)
            .map_err(|error| LocalRunnerError::invalid(format!("invalid {name}: {error}")))
    })
}

fn duration_value(args: &[String], name: &str, default: u64) -> Result<Duration, LocalRunnerError> {
    Ok(Duration::from_millis(
        optional_u64(args, name)?.unwrap_or(default),
    ))
}

fn repeated_values(args: &[String], name: &str) -> Result<Vec<String>, LocalRunnerError> {
    let mut values = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            let value = args
                .get(index + 1)
                .ok_or_else(|| LocalRunnerError::invalid(format!("missing value for {name}")))?;
            values.push(value.clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(values)
}

/// Native runner keeps runnerd as the package-local process owner while the existing
/// Codex app-server remains the provider protocol implementation. Stdio stays
/// byte-for-byte JSON-RPC; runnerd writes process evidence only to stderr.
fn run_codex_app_server_proxy(args: &[String]) -> Result<(), LocalRunnerError> {
    let command_name = value(args, "--codex-command")?;
    let codex_args = repeated_values(args, "--codex-arg")?;
    let mut command = Command::new(&command_name);
    command
        .args(&codex_args)
        .env_clear()
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for key in [
        "ALL_PROXY",
        "CODEX_HOME",
        "HOME",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "LANG",
        "LC_ALL",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "PATH",
        "PATHEXT",
        "SSL_CERT_FILE",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TMPDIR",
        "WINDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        LocalRunnerError::invalid(format!("failed to start Codex app-server: {error}"))
    })?;
    eprintln!(
        "paperclip-runnerd: native codex proxy started runner_pid={} codex_pid={}",
        std::process::id(),
        child.id()
    );
    let status = child.wait().map_err(|error| {
        LocalRunnerError::invalid(format!("failed to wait for Codex app-server: {error}"))
    })?;
    eprintln!(
        "paperclip-runnerd: native codex proxy exited success={} code={}",
        status.success(),
        status
            .code()
            .map_or_else(|| "signal".to_owned(), |code| code.to_string())
    );
    if status.success() {
        Ok(())
    } else {
        Err(LocalRunnerError::invalid(
            "Codex app-server exited unsuccessfully",
        ))
    }
}

fn run_durable_mode(
    args: &[String],
    bootstrap_ticket: Option<BootstrapTicket>,
) -> Result<(), LocalRunnerError> {
    let config = DurableRunnerConfig {
        connect_url: value(args, "--connect-url")?,
        state_dir: PathBuf::from(value(args, "--state-dir")?),
        runner_instance_id: value(args, "--runner-id")?,
        environment_lease_id: value(args, "--environment-lease-id")?,
        run_id: value(args, "--run-id")?,
        normalized_session_id: value(args, "--session-id")?,
        turn_id: value(args, "--turn-id")?,
        item_id: value(args, "--item-id")?,
        runner_version: value(args, "--runner-version")?,
        runner_digest: value(args, "--runner-digest")?,
        fake_harness_path: args
            .iter()
            .any(|argument| argument == "--fake-harness")
            .then(|| value(args, "--fake-harness").map(PathBuf::from))
            .transpose()?,
        fake_harness_script_path: args
            .iter()
            .any(|argument| argument == "--fake-harness-script")
            .then(|| value(args, "--fake-harness-script").map(PathBuf::from))
            .transpose()?,
        max_outbox_bytes: usize_value(args, "--max-outbox-bytes", 64 * 1024)?,
        p0_reserve_bytes: usize_value(args, "--p0-reserve-bytes", 32 * 1024)?,
        max_frame_bytes: usize_value(args, "--max-frame-bytes", 1024 * 1024)?,
        reconnect_delay: duration_value(args, "--reconnect-delay-ms", 25)?,
        max_runtime: duration_value(args, "--max-runtime-ms", 15_000)?,
    };
    let bootstrap_ticket = bootstrap_ticket
        .ok_or_else(|| LocalRunnerError::invalid("runner bootstrap ticket is not available"))?;
    run_durable_runner(config, bootstrap_ticket)
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))
}

fn run(bootstrap_ticket: Option<BootstrapTicket>) -> Result<(), LocalRunnerError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.as_slice() == ["--build-metadata"] {
        println!("{}", build_metadata());
        return Ok(());
    }
    if args
        .iter()
        .any(|argument| argument == "--codex-app-server-proxy")
    {
        return run_codex_app_server_proxy(&args);
    }
    if args.iter().any(|argument| argument == "--connect-url") {
        return run_durable_mode(&args, bootstrap_ticket);
    }
    run_local_runner(RunnerConfig {
        run_id: value(&args, "--run-id")?,
        normalized_session_id: value(&args, "--session-id")?,
        runner_instance_id: value(&args, "--runner-id")?,
        fake_harness_path: PathBuf::from(value(&args, "--fake-harness")?),
        script_path: PathBuf::from(value(&args, "--script")?),
        delay_override_ms: optional_u64(&args, "--delay-ms")?,
        log_max_lines: usize_value(&args, "--log-max-lines", 32)?,
        log_max_bytes: usize_value(&args, "--log-max-bytes", 16_384)?,
        harness_max_line_bytes: usize_value(&args, "--harness-max-line-bytes", 64 * 1024)?,
        shutdown_grace: Duration::from_millis(
            optional_u64(&args, "--shutdown-grace-ms")?.unwrap_or(100),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_metadata_names_the_versioned_eval_contracts() {
        let metadata = build_metadata();
        assert_eq!(metadata["schema"], RUNNERD_BUILD_METADATA_SCHEMA);
        assert_eq!(metadata["packageVersion"], "0.1.2");
        assert_eq!(metadata["binaryContractVersion"], 1);
        assert_eq!(metadata["nativeExecutionVersion"], 1);
        assert_eq!(metadata["harnessDriverVersion"], 1);
        assert_eq!(metadata["prp"]["minimumVersion"], 1);
        assert_eq!(metadata["prp"]["maximumVersion"], 1);
    }
}

fn main() -> ExitCode {
    // Capture and remove the bootstrap capability before argument parsing or child work.
    let bootstrap_ticket = match capture_bootstrap_ticket() {
        Ok(ticket) => ticket,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            return ExitCode::FAILURE;
        }
    };
    match run(bootstrap_ticket) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            ExitCode::FAILURE
        }
    }
}
