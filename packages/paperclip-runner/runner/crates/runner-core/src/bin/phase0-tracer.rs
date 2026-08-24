use paperclip_runner_core::{run_phase0_tracer, PHASE0_FIXTURE};

fn main() {
    match run_phase0_tracer(PHASE0_FIXTURE) {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("Phase 0 tracer failed: {error}");
            std::process::exit(1);
        }
    }
}
