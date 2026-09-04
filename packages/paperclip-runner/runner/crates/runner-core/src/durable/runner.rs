use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::state::{
    Command, CommandDisposition, DurableState, DurableStateStore, EventPriority,
    PendingTerminalDelivery, StoredCommandResult,
};
use super::transport::{
    current_unix_ms, validate_control_identity, AuthenticatedTransport, ConnectionMetadata,
    LeaseCredential, RunnerTransportEndpoint,
};
use super::{BootstrapTicket, DurableRunnerConfig, DurableRunnerError, PROTOCOL, PROTOCOL_VERSION};

#[derive(Clone, Debug, PartialEq)]
pub struct CommandExecution {
    pub result: Value,
    pub events: Vec<(String, EventPriority, Value)>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolledEvent {
    pub executor_event_id: String,
    pub event_type: String,
    pub priority: EventPriority,
    pub payload: Value,
}

impl CommandExecution {
    pub fn result(result: Value) -> Self {
        Self {
            result,
            events: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandLifecycle {
    Continue,
    Suspend,
    Shutdown,
}

const TERMINAL_RESULT_ACK_TIMEOUT: Duration = Duration::from_secs(2);

fn sleep_for_reconnect(base: Duration, max_delay: Duration, attempt: &mut u32) {
    let multiplier = 1_u128 << (*attempt).min(5);
    let uncapped = base.as_millis().saturating_mul(multiplier);
    let capped = uncapped.clamp(1, 5_000) as u64;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| u64::from(duration.subsec_nanos()));
    let jitter_percent = 75 + nanos % 51;
    *attempt = attempt.saturating_add(1);
    let delay = Duration::from_millis(capped.saturating_mul(jitter_percent) / 100).min(max_delay);
    if !delay.is_zero() {
        thread::sleep(delay);
    }
}

fn sleep_before_deadline(delay: Duration, deadline: Instant) {
    let bounded_delay = delay.min(deadline.saturating_duration_since(Instant::now()));
    if !bounded_delay.is_zero() {
        thread::sleep(bounded_delay);
    }
}

fn connection_attempt_deadline(
    config: &DurableRunnerConfig,
    started: Instant,
    disconnected_since: Option<Instant>,
) -> Instant {
    let now = Instant::now();
    let runtime_remaining = config
        .max_runtime
        .saturating_sub(now.saturating_duration_since(started));
    let remaining = disconnected_since.zip(config.reconnect_grace).map_or(
        runtime_remaining,
        |(disconnected_at, grace)| {
            runtime_remaining
                .min(grace.saturating_sub(now.saturating_duration_since(disconnected_at)))
        },
    );
    // Validation caps max_runtime at seven days, and reconnect grace can only
    // shorten this budget, so adding it to a current Instant cannot overflow.
    now + remaining
}

impl CommandLifecycle {
    fn for_terminal(command: &Command) -> Self {
        match command.command_type.as_str() {
            "runner.suspend" => Self::Suspend,
            "runner.shutdown" => Self::Shutdown,
            _ => Self::Continue,
        }
    }

    fn merge(self, next: Self) -> Self {
        match (self, next) {
            (Self::Shutdown, _) | (_, Self::Shutdown) => Self::Shutdown,
            (Self::Suspend, _) | (_, Self::Suspend) => Self::Suspend,
            _ => Self::Continue,
        }
    }

    fn durable_state(self) -> Option<&'static str> {
        match self {
            Self::Continue => None,
            Self::Suspend => Some("suspended"),
            Self::Shutdown => Some("stopped"),
        }
    }
}

pub trait CommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError>;

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        Ok(Vec::new())
    }

    /// Removes the prefix returned by `poll_events` after each event is
    /// durably committed to the PRP outbox. Implementations that retain
    /// provider events must not remove them before this acknowledgement.
    fn acknowledge_events(&mut self, _count: usize) -> Result<(), DurableRunnerError> {
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        Ok(())
    }
}

pub fn run_durable_runner<E: CommandExecutor>(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
    mut executor: E,
) -> Result<(), DurableRunnerError> {
    config.validate()?;
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if state.lifecycle == "revoked"
        || (state.lifecycle == "stopped" && state.pending_terminal_delivery.is_none())
    {
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
    // Bind listener mode or resolve dial mode before processing commands. Dial
    // reconnects retain the same validated addresses so DNS cannot redirect a
    // retry after the trust decision.
    let endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id)?;
    let started = Instant::now();
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut lease: Option<LeaseCredential> = None;
    let mut authenticated_once = false;
    let mut disconnected_since: Option<Instant> = None;
    let mut reconnect_attempt = 0_u32;

    loop {
        if authenticated_once {
            let disconnected_at = disconnected_since.get_or_insert_with(Instant::now);
            if config
                .reconnect_grace
                .is_some_and(|grace| disconnected_at.elapsed() >= grace)
            {
                let _ = executor.shutdown();
                state.lifecycle = "recoverable_failure".to_owned();
                state.recoverable_failure = Some("transport_reconnect_grace_exceeded".to_owned());
                state.record_diagnostic(
                    "transport reconnect grace exceeded; durable state is preserved",
                );
                store.save(&state)?;
                return Err(DurableRunnerError::invalid(
                    "transport reconnect grace exceeded; durable state is preserved",
                ));
            }
        }
        if started.elapsed() >= config.max_runtime {
            let _ = executor.shutdown();
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
            let _ = executor.shutdown();
            state.lifecycle = "recoverable_failure".to_owned();
            state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
            state.record_diagnostic("connection lease expired; a fresh bootstrap is required");
            store.save(&state)?;
            return Err(DurableRunnerError::invalid(
                "connection lease expired; a fresh bootstrap is required",
            ));
        }

        let using_bootstrap = lease.is_none();
        let connect_deadline = connection_attempt_deadline(&config, started, disconnected_since);
        let connection = AuthenticatedTransport::connect(
            &endpoint,
            &config,
            &state,
            bootstrap_ticket.as_ref(),
            lease.as_ref(),
            connect_deadline,
        );
        let (mut transport, welcome) = match connection {
            Ok(Some(connection)) => connection,
            Ok(None) => {
                sleep_before_deadline(config.reconnect_delay, connect_deadline);
                continue;
            }
            Err(error) => {
                state.record_diagnostic(format!("transport reconnect scheduled: {error}"));
                store.save(&state)?;
                if Instant::now() >= connect_deadline {
                    // Re-enter the lifecycle checks immediately so an auth
                    // timeout cannot be misreported as a reusable-bootstrap
                    // failure or delayed by reconnect backoff.
                    continue;
                }
                if using_bootstrap && error.bootstrap_maybe_consumed {
                    return Err(DurableRunnerError::invalid(
                        "bootstrap connection failed closed; provide a fresh one-use ticket",
                    ));
                }
                sleep_for_reconnect(
                    config.reconnect_delay,
                    connect_deadline.saturating_duration_since(Instant::now()),
                    &mut reconnect_attempt,
                );
                continue;
            }
        };
        if Instant::now() >= connect_deadline {
            // A transport that authenticated after its lifecycle deadline is
            // never allowed to clear reconnect state or process commands.
            continue;
        }
        authenticated_once = true;
        disconnected_since = None;
        reconnect_attempt = 0;
        if let Some(next_lease) = welcome.lease {
            lease = Some(next_lease);
            // A bootstrap capability is one-use. It is destroyed only after a
            // mutually authenticated secure welcome exchanges it for a lease.
            bootstrap_ticket.take();
        }
        if let Some(acked_source_seq) = welcome.acked_source_seq {
            state.apply_ack(acked_source_seq)?;
        }
        let connection = welcome.connection;
        if state.pending_terminal_delivery.is_some() {
            return reconcile_pending_terminal_delivery(
                &mut state,
                &store,
                &config,
                &mut executor,
                &mut transport,
                &connection,
                &welcome.pending_commands,
            );
        }
        state.lifecycle = "ready".to_owned();
        state.recoverable_failure = None;
        store.save(&state)?;
        let mut sent_source_seq = state.acked_source_seq;

        let mut lifecycle_after_reply = CommandLifecycle::Continue;
        let mut disconnected = false;
        for command in welcome.pending_commands {
            let (result, lifecycle) =
                process_command(&mut state, &store, &config, &mut executor, &command)?;
            if let Some(durable_lifecycle) = lifecycle.durable_state() {
                persist_lifecycle_before_command_delivery(
                    &mut state,
                    &store,
                    durable_lifecycle,
                    &result,
                )?;
            }
            lifecycle_after_reply = lifecycle_after_reply.merge(lifecycle);
            if let Err(error) = transport.send_json(&command_result_envelope(&state, &result)) {
                if lifecycle.durable_state().is_some() {
                    return stop_after_terminal_result_delivery_failure(
                        &mut state,
                        &store,
                        &mut executor,
                        error,
                    );
                }
                state.record_diagnostic(error.to_string());
                disconnected = true;
                break;
            }
            if lifecycle.durable_state().is_some() {
                if let Err(error) = wait_for_terminal_result_ack(
                    &mut transport,
                    &mut state,
                    &store,
                    &connection,
                    &result,
                ) {
                    return stop_after_terminal_result_delivery_failure(
                        &mut state,
                        &store,
                        &mut executor,
                        error,
                    );
                }
                // A terminal lifecycle command is the final command this
                // process may accept. Flush its already-durable outbox below,
                // then release the executor without observing later commands.
                break;
            }
        }
        if !disconnected {
            if let Err(error) = send_outbox(&mut transport, &state, &mut sent_source_seq) {
                state.record_diagnostic(
                    "outbox delivery failed; unacknowledged suffix remains durable",
                );
                if lifecycle_after_reply.durable_state().is_some() {
                    // The terminal result was delivered above. Never reconnect
                    // this process and overwrite its durable terminal state as
                    // ready merely to retry a later outbox frame.
                    store.save(&state)?;
                    let _ = executor.shutdown();
                    return Err(error);
                }
                disconnected = true;
            }
        }
        if let Some(durable_lifecycle) = lifecycle_after_reply
            .durable_state()
            .filter(|_| !disconnected)
        {
            debug_assert_eq!(state.lifecycle, durable_lifecycle);
            return finish_terminal_transition_after_ack(&mut state, &store, &mut executor);
        }
        if disconnected {
            disconnected_since.get_or_insert_with(Instant::now);
            state.reconnect_count = state.reconnect_count.saturating_add(1);
            store.save(&state)?;
            let reconnect_deadline =
                connection_attempt_deadline(&config, started, disconnected_since);
            sleep_before_deadline(config.reconnect_delay, reconnect_deadline);
            continue;
        }
        loop {
            if started.elapsed() >= config.max_runtime {
                break;
            }
            poll_executor_events(&mut state, &store, &config, &mut executor)?;
            if let Err(error) = send_outbox(&mut transport, &state, &mut sent_source_seq) {
                disconnected_since.get_or_insert_with(Instant::now);
                state.record_diagnostic(error.to_string());
                state.reconnect_count = state.reconnect_count.saturating_add(1);
                store.save(&state)?;
                break;
            }
            if current_unix_ms()? >= connection.expires_at_unix_ms {
                let _ = executor.shutdown();
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
                    disconnected_since.get_or_insert_with(Instant::now);
                    state.record_diagnostic(error.to_string());
                    state.reconnect_count = state.reconnect_count.saturating_add(1);
                    store.save(&state)?;
                    break;
                }
            };
            if let Err(error) = validate_control_identity(&message, &state, Some(&connection)) {
                disconnected_since.get_or_insert_with(Instant::now);
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
                    let (result, lifecycle) =
                        process_command(&mut state, &store, &config, &mut executor, &command)?;
                    if let Some(durable_lifecycle) = lifecycle.durable_state() {
                        persist_lifecycle_before_command_delivery(
                            &mut state,
                            &store,
                            durable_lifecycle,
                            &result,
                        )?;
                    }
                    if let Err(error) =
                        transport.send_json(&command_result_envelope(&state, &result))
                    {
                        if lifecycle.durable_state().is_some() {
                            return stop_after_terminal_result_delivery_failure(
                                &mut state,
                                &store,
                                &mut executor,
                                error,
                            );
                        }
                        disconnected_since.get_or_insert_with(Instant::now);
                        state.record_diagnostic(error.to_string());
                        state.reconnect_count = state.reconnect_count.saturating_add(1);
                        store.save(&state)?;
                        break;
                    }
                    if lifecycle.durable_state().is_some() {
                        if let Err(error) = wait_for_terminal_result_ack(
                            &mut transport,
                            &mut state,
                            &store,
                            &connection,
                            &result,
                        ) {
                            return stop_after_terminal_result_delivery_failure(
                                &mut state,
                                &store,
                                &mut executor,
                                error,
                            );
                        }
                    }
                    if let Err(error) = send_outbox(&mut transport, &state, &mut sent_source_seq) {
                        state.record_diagnostic(
                            "outbox delivery failed; unacknowledged suffix remains durable",
                        );
                        store.save(&state)?;
                        if lifecycle.durable_state().is_some() {
                            // The controller has accepted this terminal result.
                            // Stop even though a later outbox frame failed so a
                            // reconnect cannot restore the runner to ready.
                            let _ = executor.shutdown();
                            return Err(error);
                        }
                        disconnected_since.get_or_insert_with(Instant::now);
                        state.reconnect_count = state.reconnect_count.saturating_add(1);
                        break;
                    }
                    if let Some(durable_lifecycle) = lifecycle.durable_state() {
                        debug_assert_eq!(state.lifecycle, durable_lifecycle);
                        return finish_terminal_transition_after_ack(
                            &mut state,
                            &store,
                            &mut executor,
                        );
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
                    state.record_diagnostic("connection capability was revoked");
                    persist_lifecycle_before_shutdown(
                        &mut state,
                        &store,
                        &mut executor,
                        "revoked",
                    )?;
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
                    disconnected_since.get_or_insert_with(Instant::now);
                    state.record_diagnostic(
                        "malformed or unsupported control frame closed the connection",
                    );
                    state.reconnect_count = state.reconnect_count.saturating_add(1);
                    store.save(&state)?;
                    break;
                }
            }
        }
        disconnected_since.get_or_insert_with(Instant::now);
        let reconnect_deadline = connection_attempt_deadline(&config, started, disconnected_since);
        sleep_before_deadline(config.reconnect_delay, reconnect_deadline);
    }
}

fn persist_lifecycle_before_shutdown<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    executor: &mut E,
    lifecycle: &str,
) -> Result<(), DurableRunnerError> {
    state.lifecycle = lifecycle.to_owned();
    store.save(state)?;
    executor.shutdown()
}

fn persist_lifecycle_before_command_delivery(
    state: &mut DurableState,
    store: &DurableStateStore,
    lifecycle: &str,
    result: &StoredCommandResult,
) -> Result<(), DurableRunnerError> {
    // A terminal command result is already durable before this boundary. Save
    // its matching lifecycle before exposing that result to the controller,
    // then let the caller deliver the result before fallible provider cleanup.
    // Recovery can therefore never observe a ready runner after the controller
    // has already observed its terminal command result.
    state.lifecycle = lifecycle.to_owned();
    state.pending_terminal_delivery = Some(PendingTerminalDelivery {
        command_id: result.command_id.clone(),
        controller_seq: result.controller_seq,
        command_type: result.command_type.clone(),
        lifecycle: lifecycle.to_owned(),
    });
    store.save(state)
}

fn complete_terminal_delivery_after_cleanup(
    state: &mut DurableState,
    store: &DurableStateStore,
) -> Result<(), DurableRunnerError> {
    let pending = state.pending_terminal_delivery.as_ref().ok_or_else(|| {
        DurableRunnerError::invalid("terminal cleanup has no durable recovery fence")
    })?;
    if state.lifecycle != pending.lifecycle {
        return Err(DurableRunnerError::invalid(
            "terminal cleanup does not match its durable recovery fence",
        ));
    }
    state.pending_terminal_delivery = None;
    store.save(state)
}

fn finish_terminal_transition_after_ack<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    // Keep the durable fence through provider cleanup. If cleanup fails, a
    // replacement may authenticate only to retry terminal reconciliation and
    // cannot restore the suspended runner to ready.
    executor.shutdown()?;
    complete_terminal_delivery_after_cleanup(state, store)
}

fn wait_for_terminal_result_ack(
    transport: &mut AuthenticatedTransport,
    state: &mut DurableState,
    store: &DurableStateStore,
    connection: &ConnectionMetadata,
    result: &StoredCommandResult,
) -> Result<(), DurableRunnerError> {
    let deadline = Instant::now() + TERMINAL_RESULT_ACK_TIMEOUT;
    while Instant::now() < deadline {
        let Some(message) = transport.receive_json()? else {
            continue;
        };
        validate_control_identity(&message, state, Some(connection))?;
        match message.get("kind").and_then(Value::as_str) {
            Some("command_result_ack") => {
                let payload = message
                    .get("payload")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        DurableRunnerError::invalid(
                            "terminal command result acknowledgement payload is required",
                        )
                    })?;
                if payload.get("commandId").and_then(Value::as_str)
                    != Some(result.command_id.as_str())
                    || payload.get("commandType").and_then(Value::as_str)
                        != Some(result.command_type.as_str())
                    || payload.get("controllerSeq").and_then(Value::as_u64)
                        != Some(result.controller_seq)
                    || payload.get("status").and_then(Value::as_str) != Some(result.status.as_str())
                {
                    return Err(DurableRunnerError::invalid(
                        "terminal command result acknowledgement changed its durable identity",
                    ));
                }
                return Ok(());
            }
            Some("ack") => {
                let acked = message
                    .pointer("/payload/ackedSourceSeq")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| DurableRunnerError::invalid("ACK cursor is required"))?;
                state.apply_ack(acked)?;
                store.save(state)?;
            }
            Some("ping") => transport.send_json(&control_envelope(
                state,
                connection,
                "pong",
                json!({
                    "lifecycle": state.lifecycle,
                    "ackedSourceSeq": state.acked_source_seq,
                    "outboxBytes": state.outbox_bytes(),
                }),
            ))?,
            _ => {
                return Err(DurableRunnerError::invalid(
                    "controller sent a non-acknowledgement after a terminal command result",
                ));
            }
        }
    }
    Err(DurableRunnerError::invalid(
        "terminal command result acknowledgement timed out",
    ))
}

fn reconcile_pending_terminal_delivery<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    transport: &mut AuthenticatedTransport,
    connection: &ConnectionMetadata,
    pending_commands: &[Command],
) -> Result<(), DurableRunnerError> {
    let pending = state.pending_terminal_delivery.clone().ok_or_else(|| {
        DurableRunnerError::invalid("terminal result reconciliation has no durable fence")
    })?;
    if let Some(command) = pending_commands
        .iter()
        .find(|command| command.command_id == pending.command_id)
    {
        if command.controller_seq != pending.controller_seq
            || command.command_type != pending.command_type
        {
            return Err(DurableRunnerError::invalid(
                "controller changed the pending terminal command identity",
            ));
        }
        let (result, lifecycle) = process_command(state, store, config, executor, command)?;
        if lifecycle.durable_state() != Some(pending.lifecycle.as_str()) {
            return Err(DurableRunnerError::invalid(
                "pending terminal command did not replay its durable lifecycle",
            ));
        }
        if let Err(error) = transport.send_json(&command_result_envelope(state, &result)) {
            return stop_after_terminal_result_delivery_failure(state, store, executor, error);
        }
        if let Err(error) =
            wait_for_terminal_result_ack(transport, state, store, connection, &result)
        {
            return stop_after_terminal_result_delivery_failure(state, store, executor, error);
        }
    } else {
        // An authenticated welcome is the controller's authoritative pending
        // set. Absence means the prior write reached the controller even if
        // the runner did not observe transport success before it exited.
        state.record_diagnostic(
            "controller confirmed the pending terminal result was already delivered",
        );
        store.save(state)?;
    }

    let mut sent_source_seq = state.acked_source_seq;
    if let Err(error) = send_outbox(transport, state, &mut sent_source_seq) {
        state.record_diagnostic("outbox delivery failed after terminal result reconciliation");
        store.save(state)?;
        let _ = executor.shutdown();
        return Err(error);
    }
    finish_terminal_transition_after_ack(state, store, executor)
}

fn stop_after_terminal_result_delivery_failure<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    executor: &mut E,
    error: DurableRunnerError,
) -> Result<(), DurableRunnerError> {
    // The terminal transition was committed before the attempted delivery.
    // Its result may or may not have reached the controller, but reconnecting
    // this process would overwrite that durable state as ready and admit work
    // after shutdown/suspend. Leave the result journaled for reconciliation by
    // a future authorized process instead.
    state.record_diagnostic(error.to_string());
    store.save(state)?;
    let _ = executor.shutdown();
    Err(error)
}

fn poll_executor_events<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    let events = executor.poll_events()?;
    if events.is_empty() {
        return Ok(());
    }
    for event in events {
        // Commit and acknowledge one event at a time. If a later event is
        // oversized or the outbox is full, the accepted prefix is already
        // durable and the unacknowledged suffix remains with the executor.
        if state.has_executor_event_receipt(
            &event.executor_event_id,
            &event.event_type,
            event.priority,
            &event.payload,
        )? {
            executor.acknowledge_events(1)?;
            continue;
        }
        state.enqueue_executor_event(
            config,
            event.executor_event_id,
            event.event_type,
            event.priority,
            event.payload,
        )?;
        store.save(state)?;
        executor.acknowledge_events(1)?;
    }
    Ok(())
}

fn process_command<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    command: &Command,
) -> Result<(StoredCommandResult, CommandLifecycle), DurableRunnerError> {
    match state.begin_command(command)? {
        CommandDisposition::Replay(result) => {
            let lifecycle = if result.status == "pending" {
                CommandLifecycle::Continue
            } else {
                CommandLifecycle::for_terminal(command)
            };
            return Ok((result, lifecycle));
        }
        CommandDisposition::Reject(result) => {
            return Ok((result, CommandLifecycle::Continue));
        }
        CommandDisposition::Execute => {}
    }
    // Persist the pending marker before any command effect. If the process dies
    // in the effect window, recovery returns an indeterminate result and never
    // executes the same logical command twice.
    store.save(state)?;
    let execution = match executor.execute(command) {
        Ok(execution) => execution,
        Err(error) => {
            // An executor-returned error is a terminal observation, not crash
            // ambiguity. Commit it before replying so recovery can replay the
            // original provider/bootstrap failure without executing the
            // command twice. A process death inside execute still leaves the
            // pre-effect marker pending and remains indeterminate on recovery.
            let message = error.to_string();
            state.record_diagnostic(format!(
                "{} command failed: {message}",
                command.command_type
            ));
            let result = state.fail_command(
                command,
                json!({
                    "code": "command_execution_failed",
                    "message": message,
                }),
            )?;
            store.save(state)?;
            return Ok((result, CommandLifecycle::for_terminal(command)));
        }
    };
    for (event_type, priority, payload) in execution.events {
        state.enqueue_event(config, event_type, priority, payload)?;
    }
    let result = state.complete_command(command, execution.result)?;
    store.save(state)?;
    Ok((result, CommandLifecycle::for_terminal(command)))
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
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    struct CountingExecutor {
        calls: usize,
    }

    struct FailingExecutor {
        calls: usize,
    }

    struct ShutdownFailingExecutor;

    struct ShutdownCountingExecutor {
        shutdown_calls: usize,
    }

    struct RetainingEventExecutor {
        events: VecDeque<PolledEvent>,
        fail_acknowledgement: bool,
    }

    impl CommandExecutor for CountingExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            self.calls += 1;
            Ok(CommandExecution::result(json!({"calls": self.calls})))
        }
    }

    impl CommandExecutor for FailingExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            self.calls += 1;
            Err(DurableRunnerError::invalid(
                "provider bootstrap rejected authorization=Bearer test-secret",
            ))
        }
    }

    impl CommandExecutor for ShutdownFailingExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            Ok(CommandExecution::result(json!({"status": "completed"})))
        }

        fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
            Err(DurableRunnerError::invalid(
                "simulated terminal cleanup failure",
            ))
        }
    }

    impl CommandExecutor for ShutdownCountingExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            Ok(CommandExecution::result(json!({"status": "completed"})))
        }

        fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
            self.shutdown_calls += 1;
            Ok(())
        }
    }

    impl CommandExecutor for RetainingEventExecutor {
        fn execute(&mut self, _command: &Command) -> Result<CommandExecution, DurableRunnerError> {
            Ok(CommandExecution::result(json!({"status": "completed"})))
        }

        fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
            Ok(self.events.iter().cloned().collect())
        }

        fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
            if self.fail_acknowledgement {
                return Err(DurableRunnerError::invalid(
                    "simulated crash before provider acknowledgement",
                ));
            }
            if count > self.events.len() {
                return Err(DurableRunnerError::invalid(
                    "test acknowledgement exceeded pending events",
                ));
            }
            self.events.drain(..count);
            Ok(())
        }
    }

    fn config(directory: PathBuf) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:3000/path".to_owned(),
            ca_bundle_path: None,
            state_dir: directory,
            runner_instance_id: "runner_1".to_owned(),
            environment_lease_id: "environment_1".to_owned(),
            run_id: "run_1".to_owned(),
            normalized_session_id: "session_1".to_owned(),
            turn_id: "turn_1".to_owned(),
            item_id: "item_1".to_owned(),
            runner_version: "0.0.0".to_owned(),
            runner_digest: "sha256:test".to_owned(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 64 * 1024,
            p0_reserve_bytes: 4096,
            max_frame_bytes: 64 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(1),
        }
    }

    fn command(command_type: &str) -> Command {
        Command {
            schema: "paperclip.prp.command.v1".to_owned(),
            command_id: "command_1".to_owned(),
            controller_seq: 1,
            command_type: command_type.to_owned(),
            issued_at: "2026-08-24T00:00:00.000Z".to_owned(),
            deadline_at: None,
            precondition: None,
            payload: json!({}),
        }
    }

    #[test]
    fn terminal_lifecycle_is_durable_before_fallible_cleanup() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-terminal-before-cleanup-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = ShutdownFailingExecutor;

        let error = persist_lifecycle_before_shutdown(&mut state, &store, &mut executor, "stopped")
            .expect_err("cleanup failure remains observable");
        let (recovered, existed) = store.load_or_create(&config).unwrap();

        assert!(error.to_string().contains("terminal cleanup failure"));
        assert!(existed);
        assert_eq!(recovered.lifecycle, "stopped");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn terminal_result_delivery_failure_stops_without_reopening_lifecycle() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-terminal-result-delivery-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = ShutdownCountingExecutor { shutdown_calls: 0 };
        let command = command("runner.shutdown");
        let (result, lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
        persist_lifecycle_before_command_delivery(
            &mut state,
            &store,
            lifecycle.durable_state().unwrap(),
            &result,
        )
        .unwrap();

        let error = stop_after_terminal_result_delivery_failure(
            &mut state,
            &store,
            &mut executor,
            DurableRunnerError::invalid("simulated result delivery failure"),
        )
        .expect_err("terminal result delivery failure remains observable");
        let (recovered, existed) = store.load_or_create(&config).unwrap();

        assert!(error.to_string().contains("result delivery failure"));
        assert!(existed);
        assert_eq!(recovered.lifecycle, "stopped");
        assert_eq!(
            recovered
                .pending_terminal_delivery
                .as_ref()
                .map(|pending| pending.command_id.as_str()),
            Some("command_1")
        );
        assert_eq!(executor.shutdown_calls, 1);
        assert!(recovered
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("result delivery failure")));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn successful_terminal_cleanup_clears_the_recovery_fence() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-terminal-result-delivered-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let command = command("runner.suspend");
        let (result, lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();

        persist_lifecycle_before_command_delivery(
            &mut state,
            &store,
            lifecycle.durable_state().unwrap(),
            &result,
        )
        .unwrap();
        assert!(state.pending_terminal_delivery.is_some());
        complete_terminal_delivery_after_cleanup(&mut state, &store).unwrap();
        let (recovered, existed) = store.load_or_create(&config).unwrap();

        assert!(existed);
        assert_eq!(recovered.lifecycle, "suspended");
        assert!(recovered.pending_terminal_delivery.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_terminal_cleanup_keeps_the_recovery_fence() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-terminal-cleanup-failed-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = ShutdownFailingExecutor;
        let command = command("runner.suspend");
        let (result, lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
        persist_lifecycle_before_command_delivery(
            &mut state,
            &store,
            lifecycle.durable_state().unwrap(),
            &result,
        )
        .unwrap();

        let error = finish_terminal_transition_after_ack(&mut state, &store, &mut executor)
            .expect_err("cleanup failure remains fenced");
        let (recovered, existed) = store.load_or_create(&config).unwrap();

        assert!(error.to_string().contains("terminal cleanup failure"));
        assert!(existed);
        assert_eq!(recovered.lifecycle, "suspended");
        assert!(recovered.pending_terminal_delivery.is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn event_batch_keeps_accepted_prefix_and_unacknowledged_suffix() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-event-batch-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut config = config(directory.clone());
        config.max_frame_bytes = 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([
                PolledEvent {
                    executor_event_id: "provider-event-1".to_owned(),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "durable prefix"}),
                },
                PolledEvent {
                    executor_event_id: "provider-event-2".to_owned(),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "x".repeat(2048)}),
                },
            ]),
            fail_acknowledgement: false,
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("the oversized suffix must fail closed");
        assert!(error.to_string().contains("transport frame limit"));
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(state.outbox[0].event_type, "provider.notice.recorded");
        assert_eq!(executor.events.len(), 1);
        assert_eq!(
            executor.events[0].payload["message"],
            Value::String("x".repeat(2048))
        );

        let (reloaded, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(reloaded.outbox.len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn receipt_survives_outbox_ack_and_prevents_duplicate_delivery() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-event-ack-crash-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([PolledEvent {
                executor_event_id: "provider-event-before-ack-crash".to_owned(),
                event_type: "provider.notice.recorded".to_owned(),
                priority: EventPriority::P1,
                payload: json!({"message": "deliver exactly once"}),
            }]),
            fail_acknowledgement: true,
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("simulate a crash after outbox persistence");
        assert!(error
            .to_string()
            .contains("before provider acknowledgement"));
        assert_eq!(state.outbox.len(), 1);
        assert_eq!(executor.events.len(), 1);
        state
            .apply_ack(1)
            .expect("controller ACK removes the durable outbox copy");
        store.save(&state).unwrap();

        let (mut recovered_state, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert!(recovered_state.outbox.is_empty());
        executor.fail_acknowledgement = false;
        executor.events[0].payload = json!({"message": "different data"});
        let mismatch = poll_executor_events(&mut recovered_state, &store, &config, &mut executor)
            .expect_err("a retained identity cannot name different event data");
        assert!(mismatch.to_string().contains("reused with different"));
        executor.events[0].payload = json!({"message": "deliver exactly once"});
        poll_executor_events(&mut recovered_state, &store, &config, &mut executor)
            .expect("recovery acknowledges the retained provider copy");
        assert!(executor.events.is_empty());
        assert!(recovered_state.outbox.is_empty());
        assert_eq!(recovered_state.highest_source_seq(), 1);
        fs::remove_dir_all(directory).unwrap();
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
        let command = command("session.open");
        let first = process_command(&mut state, &store, &config, &mut executor, &command)
            .unwrap()
            .0;
        let replay = process_command(&mut state, &store, &config, &mut executor, &command)
            .unwrap()
            .0;
        assert_eq!(executor.calls, 1);
        assert_eq!(first, replay);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn executor_failure_is_durable_and_does_not_become_indeterminate() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-command-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = FailingExecutor { calls: 0 };
        let command = command("session.open");

        let (failed, failed_lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
        let (mut recovered, existed) = store.load_or_create(&config).unwrap();
        let replay = process_command(&mut recovered, &store, &config, &mut executor, &command)
            .unwrap()
            .0;

        assert!(existed);
        assert_eq!(executor.calls, 1);
        assert_eq!(failed_lifecycle, CommandLifecycle::Continue);
        assert_eq!(failed, replay);
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.result["code"], "command_execution_failed");
        assert_eq!(
            failed.result["message"],
            "provider bootstrap rejected authorization=Bearer [REDACTED]"
        );
        assert!(recovered.diagnostics.iter().any(|diagnostic| {
            diagnostic
                == "session.open command failed: provider bootstrap rejected authorization=Bearer [REDACTED]"
        }));
        assert!(recovered
            .diagnostics
            .iter()
            .all(|diagnostic| !diagnostic.contains("test-secret")));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_lifecycle_commands_replay_their_terminal_transition() {
        for (command_type, expected_lifecycle) in [
            ("runner.suspend", CommandLifecycle::Suspend),
            ("runner.shutdown", CommandLifecycle::Shutdown),
        ] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-runner-failed-lifecycle-{}-{}",
                command_type.replace('.', "-"),
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&directory);
            let config = config(directory.clone());
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let mut executor = FailingExecutor { calls: 0 };
            let command = command(command_type);

            let (failed, first_lifecycle) =
                process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
            let (mut recovered, _) = store.load_or_create(&config).unwrap();
            let (replay, replay_lifecycle) =
                process_command(&mut recovered, &store, &config, &mut executor, &command).unwrap();

            assert_eq!(failed.status, "failed");
            assert_eq!(failed, replay);
            assert_eq!(first_lifecycle, expected_lifecycle);
            assert_eq!(replay_lifecycle, expected_lifecycle);
            assert_eq!(executor.calls, 1);
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn process_death_after_journaling_remains_indeterminate_without_reexecution() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-command-indeterminate-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let command = command("session.open");

        assert_eq!(
            state.begin_command(&command).unwrap(),
            CommandDisposition::Execute
        );
        store.save(&state).unwrap();

        let (mut recovered, existed) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let replay = process_command(&mut recovered, &store, &config, &mut executor, &command)
            .unwrap()
            .0;

        assert!(existed);
        assert_eq!(executor.calls, 0);
        assert_eq!(replay.status, "indeterminate");
        assert_eq!(replay.result["code"], "execution_indeterminate");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn indeterminate_lifecycle_command_still_stops_after_recovery_delivery() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-lifecycle-indeterminate-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let command = command("runner.shutdown");

        assert_eq!(
            state.begin_command(&command).unwrap(),
            CommandDisposition::Execute
        );
        store.save(&state).unwrap();

        let (mut recovered, _) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let (result, lifecycle) =
            process_command(&mut recovered, &store, &config, &mut executor, &command).unwrap();

        assert_eq!(result.status, "indeterminate");
        assert_eq!(lifecycle, CommandLifecycle::Shutdown);
        assert_eq!(executor.calls, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn completed_shutdown_replay_still_stops_after_delivery() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-shutdown-replay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let command = command("runner.shutdown");

        let (_, first_stop) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
        let (_, replay_stop) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();

        assert_eq!(first_stop, CommandLifecycle::Shutdown);
        assert_eq!(replay_stop, CommandLifecycle::Shutdown);
        assert_eq!(executor.calls, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn completed_suspend_replay_remains_restartable() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-suspend-replay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = CountingExecutor { calls: 0 };
        let command = command("runner.suspend");

        let (_, first_lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();
        let (_, replay_lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &command).unwrap();

        assert_eq!(first_lifecycle, CommandLifecycle::Suspend);
        assert_eq!(replay_lifecycle, CommandLifecycle::Suspend);
        assert_eq!(first_lifecycle.durable_state(), Some("suspended"));
        assert_eq!(executor.calls, 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
