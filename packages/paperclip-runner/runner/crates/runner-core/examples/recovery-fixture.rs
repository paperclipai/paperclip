use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use paperclip_runner_core::durable::{
    capture_bootstrap_ticket, run_durable_runner, Command, CommandExecution, CommandExecutor,
    DurableRunnerConfig, DurableRunnerError, EventPriority, PolledEvent,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    steps: usize,
    wait_after: usize,
    retention_limit: usize,
    release_file: PathBuf,
    receipt_file: PathBuf,
}

#[derive(Default)]
struct Work {
    started: bool,
    stopped: bool,
    resumed: bool,
    completed: usize,
    acknowledged: usize,
    peak_retained: usize,
    events: VecDeque<PolledEvent>,
}

type Shared = Arc<(Mutex<Work>, Condvar)>;

fn receipt(script: &Script, work: &Work, phase: &str) {
    let bytes = serde_json::to_vec(&json!({
        "pid": std::process::id(), "phase": phase, "completedSteps": work.completed,
        "retainedEvents": work.events.len(), "acknowledgedEvents": work.acknowledged,
        "peakRetainedEvents": work.peak_retained,
    }))
    .unwrap();
    let temporary = script.receipt_file.with_extension("pending");
    fs::write(&temporary, bytes).unwrap();
    fs::rename(temporary, &script.receipt_file).unwrap();
}

fn workload(script: Script, shared: Shared) {
    let (lock, changed) = &*shared;
    let mut work = lock.lock().unwrap();
    receipt(&script, &work, "admitted");
    loop {
        if work.stopped {
            receipt(&script, &work, "stopped");
            return;
        }
        if !work.started || !script.release_file.exists() {
            work = changed
                .wait_timeout(work, Duration::from_millis(10))
                .unwrap()
                .0;
            continue;
        }
        if work.completed == script.steps {
            receipt(&script, &work, "completed");
            work = changed.wait(work).unwrap();
            continue;
        }
        if work.completed == script.wait_after && !work.resumed {
            receipt(&script, &work, "awaiting_controller");
            work = changed.wait(work).unwrap();
            continue;
        }
        if work.events.len() == script.retention_limit {
            receipt(&script, &work, "backpressured");
            work = changed.wait(work).unwrap();
            continue;
        }
        let step = work.completed + 1;
        drop(work);
        let mut digest = Sha256::digest(step.to_le_bytes());
        for _ in 0..4096 {
            digest = Sha256::digest(digest);
        }
        work = lock.lock().unwrap();
        work.events.push_back(PolledEvent {
            executor_event_id: format!("fixture-step-{step}"),
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P2,
            payload: json!({"text": format!("step={step} sha256={digest:x}\n")}),
        });
        work.completed = step;
        work.peak_retained = work.peak_retained.max(work.events.len());
        receipt(&script, &work, "computing");
    }
}

struct ScriptedExecutor {
    shared: Shared,
    worker: Option<thread::JoinHandle<()>>,
}

impl ScriptedExecutor {
    fn new(script: Script) -> Self {
        let shared = Arc::new((Mutex::new(Work::default()), Condvar::new()));
        let worker_shared = shared.clone();
        Self {
            shared,
            worker: Some(thread::spawn(move || workload(script, worker_shared))),
        }
    }
}

impl CommandExecutor for ScriptedExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        let mut work = self.shared.0.lock().unwrap();
        match command.command_type.as_str() {
            "turn.start" => {
                if work.started {
                    return Err(DurableRunnerError::invalid("fixture turn started twice"));
                }
                work.started = true;
            }
            "turn.steer" => work.resumed = true,
            "session.snapshot" => {}
            "turn.stop" | "session.close" | "runner.shutdown" | "runner.suspend" => {
                work.stopped = true
            }
            _ => return Err(DurableRunnerError::invalid("unsupported fixture command")),
        }
        self.shared.1.notify_all();
        Ok(CommandExecution::result(json!({
            "completedSteps": work.completed, "retainedEvents": work.events.len(),
            "acknowledgedEvents": work.acknowledged, "pid": std::process::id(),
        })))
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.retained_events()
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        Ok(self
            .shared
            .0
            .lock()
            .unwrap()
            .events
            .iter()
            .cloned()
            .collect())
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        let mut work = self.shared.0.lock().unwrap();
        if count > work.events.len() {
            return Err(DurableRunnerError::invalid(
                "fixture acknowledged an unowned event",
            ));
        }
        work.events.drain(..count);
        work.acknowledged += count;
        self.shared.1.notify_all();
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        self.shared.0.lock().unwrap().stopped = true;
        self.shared.1.notify_all();
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| DurableRunnerError::invalid("fixture worker failed"))?;
        }
        Ok(())
    }
}

impl Drop for ScriptedExecutor {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |key: &str| -> Result<String, DurableRunnerError> {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].clone())
            .ok_or_else(|| DurableRunnerError::invalid(format!("missing {key}")))
    };
    let script: Script = serde_json::from_slice(&fs::read(value("--fixture-script")?)?)?;
    if script.steps == 0
        || script.steps > 4096
        || script.wait_after > script.steps
        || !(1..=256).contains(&script.retention_limit)
    {
        return Err("fixture workload exceeds its bounds".into());
    }
    let config = DurableRunnerConfig {
        connect_url: value("--connect-url")?,
        ca_bundle_path: None,
        state_dir: value("--state-dir")?.into(),
        runner_instance_id: value("--runner-id")?,
        environment_lease_id: value("--environment-lease-id")?,
        run_id: value("--run-id")?,
        normalized_session_id: value("--session-id")?,
        turn_id: value("--turn-id")?,
        item_id: value("--item-id")?,
        runner_version: value("--runner-version")?,
        runner_digest: value("--runner-digest")?,
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        max_outbox_bytes: value("--max-outbox-bytes")?.parse()?,
        p0_reserve_bytes: value("--p0-reserve-bytes")?.parse()?,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(20),
        reconnect_grace: Some(Duration::from_millis(
            value("--reconnect-grace-ms")?.parse()?,
        )),
        max_runtime: Duration::ZERO,
    };
    run_durable_runner(
        config,
        capture_bootstrap_ticket()?.ok_or("missing ticket")?,
        ScriptedExecutor::new(script),
    )?;
    Ok(())
}
