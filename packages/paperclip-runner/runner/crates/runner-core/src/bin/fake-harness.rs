use std::path::PathBuf;
use std::process::ExitCode;

use paperclip_runner_core::phase2::{load_fake_harness_script, run_fake_harness, Phase2Error};

fn value(args: &[String], name: &str) -> Result<String, Phase2Error> {
    let index = args
        .iter()
        .position(|argument| argument == name)
        .ok_or_else(|| Phase2Error::invalid(format!("missing required argument {name}")))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| Phase2Error::invalid(format!("missing value for {name}")))
}

fn run() -> Result<i32, Phase2Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let script = load_fake_harness_script(&PathBuf::from(value(&args, "--script")?))?;
    let delay_override_ms = args
        .iter()
        .position(|argument| argument == "--delay-ms")
        .map(|index| {
            args.get(index + 1)
                .ok_or_else(|| Phase2Error::invalid("missing value for --delay-ms"))?
                .parse::<u64>()
                .map_err(|error| Phase2Error::invalid(format!("invalid --delay-ms: {error}")))
        })
        .transpose()?;
    run_fake_harness(script, delay_override_ms)
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(u8::try_from(code.clamp(0, 255)).unwrap_or(1)),
        Err(error) => {
            eprintln!("fake-harness: {error}");
            ExitCode::FAILURE
        }
    }
}
