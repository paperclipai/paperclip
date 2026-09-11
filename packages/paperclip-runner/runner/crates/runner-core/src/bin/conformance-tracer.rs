use paperclip_runner_core::{run_conformance_tracer, CONFORMANCE_FIXTURE};

fn main() {
    match run_conformance_tracer(CONFORMANCE_FIXTURE) {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("Conformance tracer failed: {error}");
            std::process::exit(1);
        }
    }
}
