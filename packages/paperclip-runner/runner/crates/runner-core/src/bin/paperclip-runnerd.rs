use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use paperclip_runner_core::durable::{
    capture_bootstrap_ticket, run_durable_runner, DurableRunnerConfig,
};
use paperclip_runner_core::local_runner::{run_local_runner, LocalRunnerError, RunnerConfig};
use paperclip_runner_core::provider_backend::CodexCommandExecutor;

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
    run_durable_runner(
        DurableRunnerConfig {
            connect_url: value(args, "--connect-url")?,
            state_dir: state_dir.clone(),
            runner_instance_id: value(args, "--runner-id")?,
            environment_lease_id: value(args, "--environment-lease-id")?,
            run_id: value(args, "--run-id")?,
            normalized_session_id: value(args, "--session-id")?,
            turn_id: value(args, "--turn-id")?,
            item_id: value(args, "--item-id")?,
            runner_version: value(args, "--runner-version")?,
            runner_digest: value(args, "--runner-digest")?,
            max_outbox_bytes: usize_value(args, "--max-outbox-bytes", 16 * 1024 * 1024)?,
            p0_reserve_bytes: usize_value(args, "--p0-reserve-bytes", 1024 * 1024)?,
            max_frame_bytes: usize_value(args, "--max-frame-bytes", 1024 * 1024)?,
            reconnect_delay: duration("--reconnect-delay-ms", 250)?,
            max_runtime: duration("--max-runtime-ms", 60 * 60 * 1000)?,
        },
        ticket,
        CodexCommandExecutor::new(state_dir),
    )
    .map_err(|error| LocalRunnerError::invalid(error.to_string()))
}

fn run() -> Result<(), LocalRunnerError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|argument| argument == "--connect-url") {
        return run_durable(&args);
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
        command_history_limit: usize_value(&args, "--command-history-limit", 4096)?,
        controller_max_line_bytes: usize_value(&args, "--controller-max-line-bytes", 64 * 1024)?,
        harness_max_line_bytes: usize_value(&args, "--harness-max-line-bytes", 64 * 1024)?,
        shutdown_grace: Duration::from_millis(
            optional_u64(&args, "--shutdown-grace-ms")?.unwrap_or(100),
        ),
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            ExitCode::FAILURE
        }
    }
}
