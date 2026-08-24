use std::thread;
use std::time::Instant;

use serde_json::{json, Value};

use super::state::{
    Command, CommandDisposition, DurableState, DurableStateStore, EventPriority,
    StoredCommandResult,
};
use super::transport::{
    current_unix_ms, validate_control_identity, AuthenticatedTransport, ConnectionMetadata,
    LeaseCredential, ResolvedWsTarget,
};
use super::{BootstrapTicket, DurableRunnerConfig, DurableRunnerError, PROTOCOL, PROTOCOL_VERSION};

#[derive(Clone, Debug, PartialEq)]
pub struct CommandExecution {
    pub result: Value,
    pub events: Vec<(String, EventPriority, Value)>,
}

impl CommandExecution {
    pub fn result(result: Value) -> Self {
        Self {
            result,
            events: Vec::new(),
        }
    }
}

pub trait CommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError>;
}

pub fn run_durable_runner<E: CommandExecutor>(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
    mut executor: E,
) -> Result<(), DurableRunnerError> {
    config.validate()?;
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if state.lifecycle == "revoked" || state.lifecycle == "stopped" {
        return Ok(());
    }
    if recovered {
        state.reconnect_count = state.reconnect_count.saturating_add(1);
        state.record_diagnostic("runner restored its durable identity after process recovery");
        state.enqueue_event(
            &config,
            "runner.reconciled",
            EventPriority::P0,
            json!({"outcome": "same_durable_session_resumed"}),
        )?;
        store.save(&state)?;
    }
    // Resolve once. Every reconnect uses the same validated concrete addresses,
    // so DNS cannot redirect a retry after the trust decision.
    let target = ResolvedWsTarget::resolve(&config.connect_url)?;
    let started = Instant::now();
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut lease: Option<LeaseCredential> = None;

    loop {
        if started.elapsed() >= config.max_runtime {
            state.lifecycle = "recoverable_failure".to_owned();
            state.recoverable_failure = Some("transport_reconnect_deadline_exceeded".to_owned());
            state.record_diagnostic(
                "transport reconnect deadline elapsed; durable state is preserved",
            );
            store.save(&state)?;
            return Err(DurableRunnerError::invalid(
                "transport reconnect deadline elapsed; durable state is preserved",
            ));
        }
        if lease.as_ref().is_some_and(|credential| {
            current_unix_ms().is_ok_and(|now| now >= credential.expires_at_unix_ms)
        }) {
            state.lifecycle = "recoverable_failure".to_owned();
            state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
            state.record_diagnostic("connection lease expired; a fresh bootstrap is required");
            store.save(&state)?;
            return Err(DurableRunnerError::invalid(
                "connection lease expired; a fresh bootstrap is required",
            ));
        }

        let using_bootstrap = lease.is_none();
        let connection = AuthenticatedTransport::connect(
            &target,
            &config,
            &state,
            bootstrap_ticket.as_ref(),
            lease.as_ref(),
        );
        let (mut transport, welcome) = match connection {
            Ok(connection) => connection,
            Err(error) => {
                state.record_diagnostic(format!("transport reconnect scheduled: {error}"));
                store.save(&state)?;
                if using_bootstrap && error.bootstrap_maybe_consumed {
                    return Err(DurableRunnerError::invalid(
                        "bootstrap connection failed closed; provide a fresh one-use ticket",
                    ));
                }
                thread::sleep(config.reconnect_delay);
                continue;
            }
        };
        if let Some(next_lease) = welcome.lease {
            lease = Some(next_lease);
            // A bootstrap capability is one-use. It is destroyed only after a
            // mutually authenticated secure welcome exchanges it for a lease.
            bootstrap_ticket.take();
        }
        if let Some(acked_source_seq) = welcome.acked_source_seq {
            state.apply_ack(acked_source_seq)?;
        }
        state.lifecycle = "ready".to_owned();
        state.recoverable_failure = None;
        store.save(&state)?;
        let mut sent_source_seq = state.acked_source_seq;

        let mut stop_after_reply = false;
        let mut disconnected = false;
        for command in welcome.pending_commands {
            let (result, stop) =
                process_command(&mut state, &store, &config, &mut executor, &command)?;
            stop_after_reply |= stop;
            if let Err(error) = transport.send_json(&command_result_envelope(&state, &result)) {
                state.record_diagnostic(error.to_string());
                disconnected = true;
                break;
            }
        }
        if !disconnected && send_outbox(&mut transport, &state, &mut sent_source_seq).is_err() {
            state.record_diagnostic("outbox delivery failed; unacknowledged suffix will replay");
            disconnected = true;
        }
        if stop_after_reply && !disconnected {
            state.lifecycle = "stopped".to_owned();
            store.save(&state)?;
            return Ok(());
        }
        if disconnected {
            state.reconnect_count = state.reconnect_count.saturating_add(1);
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }

        let connection = welcome.connection;
        loop {
            if started.elapsed() >= config.max_runtime {
                break;
            }
            if current_unix_ms()? >= connection.expires_at_unix_ms {
                state.lifecycle = "recoverable_failure".to_owned();
                state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
                state.record_diagnostic("active connection lease expired");
                store.save(&state)?;
                return Err(DurableRunnerError::invalid(
                    "active connection lease expired; durable state is preserved",
                ));
            }
            let message = match transport.receive_json() {
                Ok(Some(message)) => message,
                Ok(None) => continue,
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    state.reconnect_count = state.reconnect_count.saturating_add(1);
                    store.save(&state)?;
                    break;
                }
            };
            if let Err(error) = validate_control_identity(&message, &state, Some(&connection)) {
                state.record_diagnostic(format!(
                    "control identity mismatch closed the connection: {error}"
                ));
                state.reconnect_count = state.reconnect_count.saturating_add(1);
                store.save(&state)?;
                break;
            }
            match message.get("kind").and_then(Value::as_str) {
                Some("ack") => {
                    let acked = message
                        .pointer("/payload/ackedSourceSeq")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| DurableRunnerError::invalid("ACK cursor is required"))?;
                    state.apply_ack(acked)?;
                    store.save(&state)?;
                }
                Some("command") => {
                    let command: Command =
                        serde_json::from_value(message.get("payload").cloned().ok_or_else(
                            || DurableRunnerError::invalid("command payload is required"),
                        )?)
                        .map_err(|error| {
                            DurableRunnerError::invalid(format!("command is malformed: {error}"))
                        })?;
                    let (result, stop) =
                        process_command(&mut state, &store, &config, &mut executor, &command)?;
                    let delivery = transport
                        .send_json(&command_result_envelope(&state, &result))
                        .and_then(|()| send_outbox(&mut transport, &state, &mut sent_source_seq));
                    if let Err(error) = delivery {
                        state.record_diagnostic(error.to_string());
                        state.reconnect_count = state.reconnect_count.saturating_add(1);
                        store.save(&state)?;
                        break;
                    }
                    if stop {
                        state.lifecycle = "stopped".to_owned();
                        store.save(&state)?;
                        return Ok(());
                    }
                }
                Some("revoke") => {
                    let epoch = message
                        .pointer("/payload/revocationEpoch")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| {
                            DurableRunnerError::invalid("revoke revocation epoch is required")
                        })?;
                    if epoch <= connection.revocation_epoch {
                        return Err(DurableRunnerError::invalid(
                            "revoke must advance the authenticated revocation epoch",
                        ));
                    }
                    state.lifecycle = "revoked".to_owned();
                    state.record_diagnostic("connection capability was revoked");
                    store.save(&state)?;
                    return Ok(());
                }
                Some("ping") => {
                    transport.send_json(&control_envelope(
                        &state,
                        &connection,
                        "pong",
                        json!({
                            "lifecycle": state.lifecycle,
                            "ackedSourceSeq": state.acked_source_seq,
                            "outboxBytes": state.outbox_bytes(),
                        }),
                    ))?;
                }
                _ => {
                    state.record_diagnostic(
                        "malformed or unsupported control frame closed the connection",
                    );
                    state.reconnect_count = state.reconnect_count.saturating_add(1);
                    store.save(&state)?;
                    break;
                }
            }
        }
        thread::sleep(config.reconnect_delay);
    }
}

fn process_command<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    command: &Command,
) -> Result<(StoredCommandResult, bool), DurableRunnerError> {
    match state.begin_command(command)? {
        CommandDisposition::Replay(result) | CommandDisposition::Reject(result) => {
            return Ok((result, false));
        }
        CommandDisposition::Execute => {}
    }
    // Persist the pending marker before any command effect. If the process dies
    // in the effect window, recovery returns an indeterminate result and never
    // executes the same logical command twice.
    store.save(state)?;
    let execution = executor.execute(command)?;
    for (event_type, priority, payload) in execution.events {
        state.enqueue_event(config, event_type, priority, payload)?;
    }
    let result = state.complete_command(command, execution.result)?;
    store.save(state)?;
    let stop = matches!(
        command.command_type.as_str(),
        "runner.shutdown" | "runner.suspend"
    );
    Ok((result, stop))
}

fn send_outbox(
    transport: &mut AuthenticatedTransport,
    state: &DurableState,
    sent_source_seq: &mut u64,
) -> Result<(), DurableRunnerError> {
    for event in &state.outbox {
        if event.source_seq <= *sent_source_seq {
            continue;
        }
        transport.send_json(&event.envelope)?;
        *sent_source_seq = event.source_seq;
    }
    Ok(())
}

fn command_result_envelope(state: &DurableState, result: &StoredCommandResult) -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": "command_result",
        "runnerInstanceId": state.runner_instance_id,
        "environmentLeaseId": state.environment_lease_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "itemId": state.item_id,
        "payload": result,
    })
}

fn control_envelope(
    state: &DurableState,
    connection: &ConnectionMetadata,
    kind: &str,
    payload: Value,
) -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "kind": kind,
        "runnerInstanceId": state.runner_instance_id,
        "environmentLeaseId": state.environment_lease_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "itemId": state.item_id,
        "connectionId": connection.connection_id,
        "connectionLeaseId": connection.lease_id,
        "payload": payload,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    struct CountingExecutor {
        calls: usize,
    }

    impl CommandExecutor for CountingExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            self.calls += 1;
            Ok(CommandExecution::result(json!({"calls": self.calls})))
        }
    }

    fn config(directory: PathBuf) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:3000/path".to_owned(),
            state_dir: directory,
            runner_instance_id: "runner_1".to_owned(),
            environment_lease_id: "environment_1".to_owned(),
            run_id: "run_1".to_owned(),
            normalized_session_id: "session_1".to_owned(),
            turn_id: "turn_1".to_owned(),
            item_id: "item_1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            max_outbox_bytes: 64 * 1024,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: Duration::from_millis(1),
            max_runtime: Duration::from_secs(1),
        }
    }

    fn command() -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: "command_1".to_owned(),
            controller_seq: 1,
            command_type: "session.open".to_owned(),
            issued_at: "2026-08-24T00:00:00.000Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload: json!({}),
        }
    }

    #[test]
    fn duplicate_delivery_replays_the_durable_result() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-command-replay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let first = process_command(&mut state, &store, &config, &mut executor, &command())
            .unwrap()
            .0;
        let replay = process_command(&mut state, &store, &config, &mut executor, &command())
            .unwrap()
            .0;
        assert_eq!(executor.calls, 1);
        assert_eq!(first, replay);
        fs::remove_dir_all(directory).unwrap();
    }
}
