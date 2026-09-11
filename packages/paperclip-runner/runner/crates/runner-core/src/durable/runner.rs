use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::state::{
    Command, CommandDisposition, DurableState, DurableStateStore, EventPriority,
    PendingTerminalDelivery, PendingWarmRunTransition, StoredCommandResult, StoredOutboxEvent,
    WarmRunTransition, TRANSITION_STATE_SCHEMA,
};
use super::transport::{
    current_unix_ms, validate_control_identity, AuthenticatedTransport, ConnectionMetadata,
    LeaseCredential, RunnerTransportEndpoint,
};
use super::{BootstrapTicket, DurableRunnerConfig, DurableRunnerError, PROTOCOL};

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
const CUMULATIVE_ACK_PERSIST_INTERVAL: usize = 16;

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

pub(crate) fn next_authority_config(
    command: &Command,
    current: &DurableRunnerConfig,
) -> Result<Option<DurableRunnerConfig>, DurableRunnerError> {
    if command.command_type != "run.attach" {
        return Ok(None);
    }
    let Some(boundary) = command.payload.get("paperclipNextAuthority") else {
        return Ok(None);
    };
    let identity = boundary
        .get("identity")
        .and_then(Value::as_object)
        .ok_or_else(|| DurableRunnerError::invalid("run.attach authority identity is required"))?;
    let read_identity = |key: &str| {
        identity
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                DurableRunnerError::invalid(format!(
                    "run.attach authority identity field {key} is required"
                ))
            })
    };
    let connection = boundary
        .get("connection")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            DurableRunnerError::invalid("run.attach authority connection is required")
        })?;
    let connect_url = match connection.get("mode").and_then(Value::as_str) {
        Some("connect") => connection
            .get("connectUrl")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| DurableRunnerError::invalid("run.attach connect URL is required"))?,
        Some("listen") => {
            let address = connection
                .get("listenAddress")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    DurableRunnerError::invalid("run.attach listen address is required")
                })?;
            let port = connection
                .get("listenPort")
                .and_then(Value::as_u64)
                .ok_or_else(|| DurableRunnerError::invalid("run.attach listen port is required"))?;
            let path = connection
                .get("listenPath")
                .and_then(Value::as_str)
                .ok_or_else(|| DurableRunnerError::invalid("run.attach listen path is required"))?;
            format!("listen://{address}:{port}{path}")
        }
        _ => {
            return Err(DurableRunnerError::invalid(
                "run.attach authority connection mode is invalid",
            ));
        }
    };
    let mut next = current.clone();
    next.connect_url = connect_url;
    next.ca_bundle_path = connection
        .get("caBundlePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(Into::into);
    next.runner_instance_id = read_identity("runnerInstanceId")?;
    next.environment_lease_id = read_identity("environmentLeaseId")?;
    next.run_id = read_identity("runId")?;
    next.normalized_session_id = read_identity("normalizedSessionId")?;
    next.turn_id = read_identity("turnId")?;
    next.item_id = read_identity("itemId")?;
    next.validate()?;
    if next.runner_instance_id != current.runner_instance_id
        || next.environment_lease_id != current.environment_lease_id
        || next.normalized_session_id != current.normalized_session_id
        || next.run_id == current.run_id
    {
        return Err(DurableRunnerError::invalid(
            "run.attach authority changed an immutable session binding",
        ));
    }
    Ok(Some(next))
}

fn apply_authority_rotation(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &mut DurableRunnerConfig,
    endpoint: &mut RunnerTransportEndpoint,
    next: DurableRunnerConfig,
) -> Result<(), DurableRunnerError> {
    if !state.outbox.is_empty() || state.acked_source_seq < state.highest_source_seq() {
        return Err(DurableRunnerError::invalid(
            "warm authority rotation requires the old event outbox to be durably acknowledged",
        ));
    }
    if state.has_unobserved_v2_session_state() {
        return Err(DurableRunnerError::invalid(
            "warm authority rotation requires native v2 session state acknowledgement",
        ));
    }
    let reconnect_count = state.reconnect_count.saturating_add(1);
    let mut diagnostics = state.diagnostics.clone();
    let mut rotated = DurableState::new(&next);
    if let Some(mut transition) = state.warm_transition.clone() {
        transition.phase = "activating".to_owned();
        rotated.warm_transition = Some(transition);
        rotated.schema = TRANSITION_STATE_SCHEMA.to_owned();
    }
    rotated.reconnect_count = reconnect_count;
    rotated.diagnostics.append(&mut diagnostics);
    rotated.record_diagnostic("runner advanced to a new warm run authority");
    store.save(&rotated)?;
    *state = rotated;
    *config = next;
    endpoint.rotate(&config.connect_url, &config.run_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalDeliveryReconciliation {
    CleanupCompleted,
    ProviderCleanupPending,
}

pub trait CommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError>;

    /// Advances provider-side event correlation after a durable `run.attach`
    /// has moved runnerd to the next run-bound authority. The runner validates
    /// and persists the new authority before invoking this infallible hook.
    fn rotate_authority(&mut self, _config: &DurableRunnerConfig) {}

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        Ok(Vec::new())
    }

    /// Returns only already-retained evidence, without polling, restoration,
    /// launch, or provider RPCs. The runner commits and ACKs this FIFO before
    /// recording a command failure or completing an authority attachment.
    /// Other successful commands retain ordinary control-first backpressure.
    /// Persistence errors must not become an empty successful drain.
    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        Ok(Vec::new())
    }

    /// Advances already-pending autonomous cleanup while controller ACKs gate
    /// regular provider ingress. Must not start a provider or release events
    /// from their durable owner; terminal observation precedes deadline expiry.
    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        Ok(())
    }

    /// Removes the prefix returned by `poll_events` after every event in that
    /// prefix is durably committed to the PRP outbox. Implementations that retain
    /// provider events must not remove them before this acknowledgement.
    fn acknowledge_events(&mut self, _count: usize) -> Result<(), DurableRunnerError> {
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        Ok(())
    }

    /// Reconcile an already-durable terminal delivery without implicitly
    /// restoring a provider. A delivery-only result retains a separate fence
    /// until a new explicit stop proves physical provider cleanup.
    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        self.shutdown()?;
        Ok(TerminalDeliveryReconciliation::CleanupCompleted)
    }
}

fn shutdown_preserving_cleanup<E: CommandExecutor>(
    state: &DurableState,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    if state.warm_transition.is_some() {
        // A replacement executor may not have restored any provider. Its
        // ordinary shutdown hook is allowed to restore, so never invoke that
        // hook while only reconciling an authority receipt. Owned process
        // handles retain their normal drop/physical cleanup responsibilities.
        Ok(())
    } else if state.pending_terminal_delivery.is_some() || state.pending_provider_cleanup.is_some()
    {
        executor.reconcile_terminal_delivery().map(|_| ())
    } else {
        executor.shutdown()
    }
}

fn record_recoverable_transport_failure(state: &mut DurableState, reason: &str) {
    // A pending terminal receipt must retain its exact suspended/stopped
    // lifecycle so a new authenticated process can reconcile that receipt.
    // Record the transport failure separately instead of invalidating the
    // durable fence merely because this attempt could not authenticate.
    if state.pending_terminal_delivery.is_none() {
        state.lifecycle = "recoverable_failure".to_owned();
    }
    state.recoverable_failure = Some(reason.to_owned());
}

#[derive(Default)]
struct CumulativeAckPersistence {
    advanced_since_save: usize,
}

impl CumulativeAckPersistence {
    fn apply(
        &mut self,
        state: &mut DurableState,
        store: &DurableStateStore,
        acked_source_seq: u64,
        protocol_version: u64,
    ) -> Result<(), DurableRunnerError> {
        let previous = state.acked_source_seq;
        state.apply_ack(acked_source_seq, protocol_version)?;
        if acked_source_seq == previous {
            return Ok(());
        }
        self.advanced_since_save = self.advanced_since_save.saturating_add(1);
        // ACKs are cumulative and replay-safe: after a crash, an older durable
        // cursor only causes the controller to deduplicate the retained suffix
        // and return the same or a newer ACK. Persist often enough to bound that
        // replay, but do not rewrite a large outbox once for every frame in a
        // burst. Command and lifecycle mutations independently save the full
        // current state before authority can change; an incomplete batch may
        // safely replay from its older durable cursor.
        if self.advanced_since_save >= CUMULATIVE_ACK_PERSIST_INTERVAL || state.outbox.is_empty() {
            store.save(state)?;
            self.advanced_since_save = 0;
        }
        Ok(())
    }
}

pub fn run_durable_runner<E: CommandExecutor>(
    mut config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
    mut executor: E,
) -> Result<(), DurableRunnerError> {
    config.validate()?;
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if state.lifecycle == "revoked"
        || (state.lifecycle == "stopped"
            && state.pending_terminal_delivery.is_none()
            && state.pending_provider_cleanup.is_none())
    {
        return Ok(());
    }
    if recovered && state.warm_transition.is_none() {
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
    let mut endpoint = RunnerTransportEndpoint::new(&config.connect_url, &config.run_id)?;
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
                let _ = shutdown_preserving_cleanup(&state, &mut executor);
                record_recoverable_transport_failure(
                    &mut state,
                    "transport_reconnect_grace_exceeded",
                );
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
            let _ = shutdown_preserving_cleanup(&state, &mut executor);
            record_recoverable_transport_failure(
                &mut state,
                "transport_reconnect_deadline_exceeded",
            );
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
            let _ = shutdown_preserving_cleanup(&state, &mut executor);
            record_recoverable_transport_failure(&mut state, "lease_expired_requires_bootstrap");
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
        let protocol_version = welcome.connection.protocol_version;
        let upgrading_from_v1 =
            protocol_version >= 2 && state.last_connection_protocol_version == Some(1);
        if let Some(acked_source_seq) = welcome.acked_source_seq {
            // A v2 welcome immediately following a v1 connection reports the
            // shared cumulative cursor, including redacted placeholders. Do
            // not interpret that cursor as acknowledgement of their native v2
            // payloads; those are restored below with fresh source sequences.
            let acknowledgement_protocol = if upgrading_from_v1 {
                1
            } else {
                protocol_version
            };
            state.apply_ack(acked_source_seq, acknowledgement_protocol)?;
        }
        if protocol_version >= 2 {
            state.restore_v2_replay_events(&config)?;
        }
        state.last_connection_protocol_version = Some(protocol_version);
        let connection = welcome.connection;
        if let Some(transition) = state.warm_transition.clone() {
            if welcome.warm_transition_version != Some(1) {
                return Err(DurableRunnerError::invalid(
                    "warm transition capability was downgraded",
                ));
            }
            if transition.phase == "activating" {
                if welcome.warm_transition_phase.as_deref() != Some("activated")
                    || connection.lease_id != transition.receipt.lease_id
                    || connection.expires_at_unix_ms != transition.receipt.lease_expires_at_unix_ms
                    || connection.revocation_epoch != transition.receipt.lease_revocation_epoch
                    || welcome.warm_transition.as_ref()
                        != Some(
                            &serde_json::to_value(&transition.receipt)
                                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?,
                        )
                    || !welcome.pending_commands.is_empty()
                {
                    return Err(DurableRunnerError::invalid(
                        "new warm authority was not activated exactly",
                    ));
                }
                // Retain the downgrade-fenced receipt until the controller
                // durably records completion and acknowledges it. Neither a
                // successful write nor a welcome alone proves that boundary.
                if let Err(error) = confirm_warm_activation(
                    &mut transport,
                    &state,
                    &connection,
                    &transition.receipt,
                ) {
                    state.record_diagnostic(format!(
                        "warm activation confirmation interrupted: {error}"
                    ));
                    store.save(&state)?;
                    disconnected_since = Some(Instant::now());
                    continue;
                }
                let mut activated = state.clone();
                activated.warm_transition = None;
                activated.schema = "paperclip.runner.durable.state.v1".to_owned();
                store.save(&activated)?;
                state = activated;
                executor.rotate_authority(&config);
            } else {
                let next =
                    next_authority_config(&transition.command, &config)?.ok_or_else(|| {
                        DurableRunnerError::invalid("warm transition target disappeared")
                    })?;
                let mut sent = state.acked_source_seq;
                match deliver_warm_attachment(
                    &mut transport,
                    &mut state,
                    &store,
                    &config,
                    &next,
                    &connection,
                    &transition.command,
                    &transition.result,
                    &mut sent,
                ) {
                    Ok(()) => {
                        apply_authority_rotation(
                            &mut state,
                            &store,
                            &mut config,
                            &mut endpoint,
                            next,
                        )?;
                    }
                    Err(error) => {
                        state.record_diagnostic(format!(
                            "warm attachment receipt replay interrupted: {error}"
                        ));
                        store.save(&state)?;
                    }
                }
                disconnected_since = Some(Instant::now());
                continue;
            }
        }
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
        let mut ack_persistence = CumulativeAckPersistence::default();

        let mut lifecycle_after_reply = CommandLifecycle::Continue;
        let mut authority_rotation = None;
        let mut disconnected = false;
        for command in welcome.pending_commands {
            let next_authority = next_authority_config(&command, &config)?;
            require_warm_transition_capability(
                &next_authority,
                welcome.warm_transition_version,
                connection.protocol_version,
            )?;
            let (result, lifecycle) =
                process_command(&mut state, &store, &config, &mut executor, &command)?;
            let next_authority = next_authority.filter(|_| completed_attachment(&result));
            if let Some(durable_lifecycle) = lifecycle.durable_state() {
                persist_lifecycle_before_command_delivery(
                    &mut state,
                    &store,
                    durable_lifecycle,
                    &result,
                )?;
            }
            lifecycle_after_reply = lifecycle_after_reply.merge(lifecycle);
            let delivery = (|| {
                if let Some(next) = &next_authority {
                    return deliver_warm_attachment(
                        &mut transport,
                        &mut state,
                        &store,
                        &config,
                        next,
                        &connection,
                        &command,
                        &result,
                        &mut sent_source_seq,
                    );
                } else if result.status == "failed" {
                    send_outbox(
                        &mut transport,
                        &state,
                        &mut sent_source_seq,
                        protocol_version,
                    )?;
                }
                transport.send_json(&command_result_envelope(&state, &result, protocol_version))
            })();
            if let Err(error) = delivery {
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
            if next_authority.is_some() {
                authority_rotation = next_authority;
                break;
            }
        }
        if let Some(next) = authority_rotation {
            apply_authority_rotation(&mut state, &store, &mut config, &mut endpoint, next)?;
            disconnected_since = Some(Instant::now());
            continue;
        }
        if !disconnected {
            if let Err(error) = send_outbox(
                &mut transport,
                &state,
                &mut sent_source_seq,
                protocol_version,
            ) {
                state.record_diagnostic(
                    "outbox delivery failed; unacknowledged suffix remains durable",
                );
                if lifecycle_after_reply.durable_state().is_some() {
                    // The terminal result was delivered above. Never reconnect
                    // this process and overwrite its durable terminal state as
                    // ready merely to retry a later outbox frame.
                    store.save(&state)?;
                    let _ = shutdown_preserving_cleanup(&state, &mut executor);
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
            if let Err(error) = send_outbox(
                &mut transport,
                &state,
                &mut sent_source_seq,
                connection.protocol_version,
            ) {
                disconnected_since.get_or_insert_with(Instant::now);
                state.record_diagnostic(error.to_string());
                state.reconnect_count = state.reconnect_count.saturating_add(1);
                store.save(&state)?;
                break;
            }
            if current_unix_ms()? >= connection.expires_at_unix_ms {
                let _ = shutdown_preserving_cleanup(&state, &mut executor);
                record_recoverable_transport_failure(
                    &mut state,
                    "lease_expired_requires_bootstrap",
                );
                state.record_diagnostic("active connection lease expired");
                store.save(&state)?;
                return Err(DurableRunnerError::invalid(
                    "active connection lease expired; durable state is preserved",
                ));
            }
            // Read control before starting another fsynced provider batch.
            // Consuming the last cumulative ACK must not let a new output
            // suffix overtake the stop/suspend already queued behind it.
            let control_message = transport.receive_json();
            poll_executor_events_when_control_idle(
                &mut state,
                &store,
                &config,
                &mut executor,
                sent_source_seq,
                &control_message,
            )?;
            let message = match control_message {
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
                    ack_persistence.apply(
                        &mut state,
                        &store,
                        acked,
                        connection.protocol_version,
                    )?;
                }
                Some("command") => {
                    let command: Command =
                        serde_json::from_value(message.get("payload").cloned().ok_or_else(
                            || DurableRunnerError::invalid("command payload is required"),
                        )?)
                        .map_err(|error| {
                            DurableRunnerError::invalid(format!("command is malformed: {error}"))
                        })?;
                    let next_authority = next_authority_config(&command, &config)?;
                    require_warm_transition_capability(
                        &next_authority,
                        welcome.warm_transition_version,
                        connection.protocol_version,
                    )?;
                    let (result, lifecycle) =
                        process_command(&mut state, &store, &config, &mut executor, &command)?;
                    let next_authority = next_authority.filter(|_| completed_attachment(&result));
                    if let Some(durable_lifecycle) = lifecycle.durable_state() {
                        persist_lifecycle_before_command_delivery(
                            &mut state,
                            &store,
                            durable_lifecycle,
                            &result,
                        )?;
                    }
                    let delivery = (|| {
                        if let Some(next) = &next_authority {
                            return deliver_warm_attachment(
                                &mut transport,
                                &mut state,
                                &store,
                                &config,
                                next,
                                &connection,
                                &command,
                                &result,
                                &mut sent_source_seq,
                            );
                        } else if result.status == "failed" {
                            send_outbox(
                                &mut transport,
                                &state,
                                &mut sent_source_seq,
                                connection.protocol_version,
                            )?;
                        }
                        transport.send_json(&command_result_envelope(
                            &state,
                            &result,
                            connection.protocol_version,
                        ))
                    })();
                    if let Err(error) = delivery {
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
                    if let Some(next) = next_authority {
                        apply_authority_rotation(
                            &mut state,
                            &store,
                            &mut config,
                            &mut endpoint,
                            next,
                        )?;
                        disconnected_since = Some(Instant::now());
                        break;
                    }
                    if let Err(error) = send_outbox(
                        &mut transport,
                        &state,
                        &mut sent_source_seq,
                        connection.protocol_version,
                    ) {
                        state.record_diagnostic(
                            "outbox delivery failed; unacknowledged suffix remains durable",
                        );
                        store.save(&state)?;
                        if lifecycle.durable_state().is_some() {
                            // The controller has accepted this terminal result.
                            // Stop even though a later outbox frame failed so a
                            // reconnect cannot restore the runner to ready.
                            let _ = shutdown_preserving_cleanup(&state, &mut executor);
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
    shutdown_preserving_cleanup(state, executor)
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
    if state.pending_provider_cleanup.is_some() {
        return finish_terminal_reconciliation(state, store, executor);
    }
    executor.shutdown()?;
    complete_terminal_delivery_after_cleanup(state, store)
}

fn finish_terminal_reconciliation<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    let outcome = executor.reconcile_terminal_delivery()?;
    if outcome == TerminalDeliveryReconciliation::ProviderCleanupPending
        && state.pending_provider_cleanup.is_none()
    {
        state.pending_provider_cleanup =
            Some(state.pending_terminal_delivery.clone().ok_or_else(|| {
                DurableRunnerError::invalid(
                    "delivery-only reconciliation requires an exact terminal fence",
                )
            })?);
    }
    // Clearing delivery never clears a pre-existing physical cleanup fence.
    // Only a new successful turn.stop may do that.
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
    let mut ack_persistence = CumulativeAckPersistence::default();
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
                ack_persistence.apply(state, store, acked, connection.protocol_version)?;
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

fn completed_attachment(result: &StoredCommandResult) -> bool {
    result.command_type == "run.attach"
        && result.status == "completed"
        && !matches!(
            result.result.get("status").and_then(Value::as_str),
            Some("rejected" | "failed")
        )
}

fn wait_for_old_authority_outbox_ack(
    transport: &mut AuthenticatedTransport,
    state: &mut DurableState,
    store: &DurableStateStore,
    connection: &ConnectionMetadata,
    sent_source_seq: &mut u64,
) -> Result<(), DurableRunnerError> {
    send_outbox(
        transport,
        state,
        sent_source_seq,
        connection.protocol_version,
    )?;
    let target = state.highest_source_seq();
    let deadline = Instant::now() + TERMINAL_RESULT_ACK_TIMEOUT;
    while state.acked_source_seq < target {
        if Instant::now() >= deadline {
            return Err(DurableRunnerError::invalid(
                "old authority event acknowledgement timed out",
            ));
        }
        let Some(message) = transport.receive_json()? else {
            continue;
        };
        validate_control_identity(&message, state, Some(connection))?;
        match message.get("kind").and_then(Value::as_str) {
            Some("ack") => {
                let acked = message
                    .pointer("/payload/ackedSourceSeq")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| DurableRunnerError::invalid("ACK cursor is required"))?;
                state.apply_ack(acked, connection.protocol_version)?;
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
            // Do not execute or forget another command inside this fence. The
            // caller disconnects with the completed attach and old outbox still
            // durable; the controller replays its own pending command queue.
            _ => {
                return Err(DurableRunnerError::invalid(
                    "old authority acknowledgement fence received non-ACK control",
                ));
            }
        }
    }
    Ok(())
}

fn require_warm_transition_capability(
    next: &Option<DurableRunnerConfig>,
    version: Option<u64>,
    protocol_version: u64,
) -> Result<(), DurableRunnerError> {
    if next.is_some() && version != Some(1) {
        return Err(DurableRunnerError::invalid(
            "warm transition capability is required before attachment",
        ));
    }
    // Even a legacy state with no replay cache acquires native goal/capability
    // observations during run.attach. A v1 ACK covers only placeholders, so
    // reject before provider rebind rather than lose them during rotation.
    // The protocol version is lease-bound: reconnecting the same v1 lease is
    // not an upgrade. Such callers need fresh v2 authorization on the old run.
    if next.is_some() && protocol_version < 2 {
        return Err(DurableRunnerError::invalid(
            "warm authority attachment requires a negotiated v2 connection",
        ));
    }
    Ok(())
}

fn confirm_warm_activation(
    transport: &mut AuthenticatedTransport,
    state: &DurableState,
    connection: &ConnectionMetadata,
    receipt: &WarmRunTransition,
) -> Result<(), DurableRunnerError> {
    transport.send_json(&control_envelope(
        state,
        connection,
        "warm_transition_activated",
        json!({"transitionId": receipt.transition_id}),
    ))?;
    let deadline = Instant::now() + TERMINAL_RESULT_ACK_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(DurableRunnerError::invalid(
                "warm activation acknowledgement timed out",
            ));
        }
        let Some(message) = transport.receive_json()? else {
            continue;
        };
        validate_control_identity(&message, state, Some(connection))?;
        match message.get("kind").and_then(Value::as_str) {
            Some("warm_transition_activated_ack")
                if message
                    .pointer("/payload/transitionId")
                    .and_then(Value::as_str)
                    == Some(receipt.transition_id.as_str()) =>
            {
                return Ok(())
            }
            Some("ping") => {
                transport.send_json(&control_envelope(state, connection, "pong", json!({})))?
            }
            _ => {
                return Err(DurableRunnerError::invalid(
                    "warm activation fence received unrelated control",
                ))
            }
        }
    }
}

fn deliver_warm_attachment(
    transport: &mut AuthenticatedTransport,
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    next: &DurableRunnerConfig,
    connection: &ConnectionMetadata,
    command: &Command,
    result: &StoredCommandResult,
    sent_source_seq: &mut u64,
) -> Result<(), DurableRunnerError> {
    wait_for_old_authority_outbox_ack(transport, state, store, connection, sent_source_seq)?;
    let receipt = WarmRunTransition::new(
        config,
        next,
        command,
        result,
        state.acked_source_seq,
        connection.lease_id.clone(),
        connection.expires_at_unix_ms,
        connection.revocation_epoch,
    )?;
    if let Some(pending) = &state.warm_transition {
        if pending.phase != "prepared"
            || pending.receipt != receipt
            || pending.command != *command
            || pending.result != *result
        {
            return Err(DurableRunnerError::invalid(
                "warm attachment replay conflicts with its durable receipt",
            ));
        }
    } else {
        if state.pending_terminal_delivery.is_some() || state.pending_provider_cleanup.is_some() {
            return Err(DurableRunnerError::invalid(
                "warm attachment cannot cross a cleanup fence",
            ));
        }
        let mut prepared = state.clone();
        prepared.schema = TRANSITION_STATE_SCHEMA.to_owned();
        prepared.warm_transition = Some(PendingWarmRunTransition {
            receipt: receipt.clone(),
            phase: "prepared".to_owned(),
            command: command.clone(),
            result: result.clone(),
        });
        store.save(&prepared)?;
        *state = prepared;
    }
    transport.send_json(&command_result_envelope(
        state,
        result,
        connection.protocol_version,
    ))?;
    let expected = serde_json::to_value(&receipt)
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
    let deadline = Instant::now() + TERMINAL_RESULT_ACK_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return Err(DurableRunnerError::invalid(
                "warm attachment result acknowledgement timed out",
            ));
        }
        let Some(message) = transport.receive_json()? else {
            continue;
        };
        validate_control_identity(&message, state, Some(connection))?;
        match message.get("kind").and_then(Value::as_str) {
            Some("command_result_ack")
                if message
                    .pointer("/payload/commandId")
                    .and_then(Value::as_str)
                    == Some(result.command_id.as_str())
                    && message
                        .pointer("/payload/controllerSeq")
                        .and_then(Value::as_u64)
                        == Some(result.controller_seq)
                    && message
                        .pointer("/payload/commandType")
                        .and_then(Value::as_str)
                        == Some("run.attach")
                    && message.pointer("/payload/status").and_then(Value::as_str)
                        == Some("completed")
                    && message.pointer("/payload/warmTransition") == Some(&expected) =>
            {
                return Ok(())
            }
            Some("ping") => transport.send_json(&control_envelope(
                state,
                connection,
                "pong",
                json!({"warmTransitionId": receipt.transition_id}),
            ))?,
            Some("ack")
                if message
                    .pointer("/payload/ackedSourceSeq")
                    .and_then(Value::as_u64)
                    == Some(state.acked_source_seq) => {}
            _ => {
                return Err(DurableRunnerError::invalid(
                    "warm attachment result fence received unrelated control",
                ))
            }
        }
    }
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
        let delivery = (|| {
            if result.status == "failed" {
                let mut sent = state.acked_source_seq;
                send_outbox(transport, state, &mut sent, connection.protocol_version)?;
            }
            transport.send_json(&command_result_envelope(
                state,
                &result,
                connection.protocol_version,
            ))
        })();
        if let Err(error) = delivery {
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
    if let Err(error) = send_outbox(
        transport,
        state,
        &mut sent_source_seq,
        connection.protocol_version,
    ) {
        state.record_diagnostic("outbox delivery failed after terminal result reconciliation");
        store.save(state)?;
        let _ = shutdown_preserving_cleanup(state, executor);
        return Err(error);
    }
    finish_terminal_reconciliation(state, store, executor)
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
    let _ = shutdown_preserving_cleanup(state, executor);
    Err(error)
}

fn poll_executor_events_after_controller_ack<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    sent_source_seq: u64,
) -> Result<(), DurableRunnerError> {
    if state.pending_provider_cleanup.is_some() {
        return Ok(());
    }
    // The controller emits one cumulative ACK per durably committed event.
    // Polling another provider batch before consuming that already-sent prefix
    // makes the ACK/stop queue grow faster than this loop can read it. Keep
    // provider events at their durable owner while draining control frames in
    // order. Command handling, authentication and cumulative ACK processing
    // remain live; unsent outbox events must not fence their own first delivery.
    if state.acked_source_seq < sent_source_seq {
        return executor.maintain_backpressured_provider();
    }
    poll_executor_events(state, store, config, executor)
}

fn poll_executor_events_when_control_idle<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    sent_source_seq: u64,
    control_message: &Result<Option<Value>, DurableRunnerError>,
) -> Result<(), DurableRunnerError> {
    if state.pending_provider_cleanup.is_some() {
        return Ok(());
    }
    match control_message {
        Ok(None) => poll_executor_events_after_controller_ack(
            state,
            store,
            config,
            executor,
            sent_source_seq,
        ),
        // Autonomous receipt-limit cleanup must remain live under control/ACK
        // traffic, but it cannot ingest ordinary provider output. Auth and
        // command identity validation still precede every command effect.
        Ok(Some(_)) => executor.maintain_backpressured_provider(),
        // Keep the original transport failure and its existing reconnect path;
        // don't admit another provider batch while disconnected.
        Err(_) => Ok(()),
    }
}

fn poll_executor_events<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    if state.pending_provider_cleanup.is_some() {
        return Ok(());
    }
    let events = match executor.poll_events() {
        Ok(events) => events,
        Err(error) => {
            drain_retained_events(state, store, config, executor).map_err(|secondary| {
                DurableRunnerError::invalid(format!(
                    "{error}; retained failure evidence remains uncommitted: {secondary}"
                ))
            })?;
            return Err(error);
        }
    };
    commit_executor_events(state, store, config, executor, events)
}

fn drain_retained_events<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
) -> Result<(), DurableRunnerError> {
    let mut observed_heads = std::collections::HashSet::new();
    let mut total = 0usize;
    loop {
        let events = executor.retained_events()?;
        if events.is_empty() {
            return Ok(());
        }
        let first_id = events[0].executor_event_id.clone();
        total = total.saturating_add(events.len());
        if !observed_heads.insert(first_id) || total > 32_768 {
            return Err(DurableRunnerError::invalid(
                "retained failure evidence did not make bounded FIFO progress",
            ));
        }
        commit_executor_events(state, store, config, executor, events)?;
    }
}

fn commit_executor_events<E: CommandExecutor>(
    state: &mut DurableState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    executor: &mut E,
    events: Vec<PolledEvent>,
) -> Result<(), DurableRunnerError> {
    let mut events = events.into_iter().peekable();
    while events.peek().is_some() {
        let mut durable_prefix = 0;
        let committed = (|| -> Result<(), DurableRunnerError> {
            // Keep each PRP event's durable save. Only coalesce provider queue
            // acknowledgements, bounded below the retained receipt window so
            // a crash before the prefix ACK can replay every event exactly.
            for event in events.by_ref().take(128) {
                if !state.has_executor_event_receipt(
                    &event.executor_event_id,
                    &event.event_type,
                    event.priority,
                    &event.payload,
                )? {
                    state.enqueue_executor_event(
                        config,
                        event.executor_event_id,
                        event.event_type,
                        event.priority,
                        event.payload,
                    )?;
                    store.save(state)?;
                }
                durable_prefix += 1;
            }
            Ok(())
        })();
        // Even when a later save/validation fails, remove only the already
        // durable prefix. A failed provider ACK leaves that prefix replayable;
        // it must not hide the original commit/identity error, if any.
        let acknowledged = if durable_prefix > 0 {
            executor.acknowledge_events(durable_prefix)
        } else {
            Ok(())
        };
        committed?;
        acknowledged?;
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
    if let Some(pending) = state.pending_provider_cleanup.as_ref() {
        let fresh_stop =
            command.command_type == "turn.stop" && command.controller_seq > pending.controller_seq;
        let terminal_replay = command.command_id == pending.command_id
            && command.controller_seq == pending.controller_seq
            && command.command_type == pending.command_type;
        if !fresh_stop && !terminal_replay {
            return Err(DurableRunnerError::invalid(
                "provider cleanup requires a new exact turn.stop before other work",
            ));
        }
    }
    match state.begin_command(command)? {
        CommandDisposition::Replay(result) => {
            let lifecycle =
                if result.status == "pending" || state.pending_provider_cleanup.is_some() {
                    // Its terminal delivery was already reconciled. Replaying
                    // the old receipt must not replace the newer command cursor
                    // with another terminal-delivery fence at an older sequence.
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
    let mut execution = match executor.execute(command) {
        Ok(execution) => execution,
        Err(error) => {
            // Failure facts may follow a full retained provider backlog. Only
            // the non-restoring FIFO is legal here; regular poll can launch.
            // A failed evidence save leaves this command pending/indeterminate.
            drain_retained_events(state, store, config, executor).map_err(|secondary| {
                DurableRunnerError::invalid(format!(
                    "{error}; retained failure evidence remains uncommitted: {secondary}"
                ))
            })?;
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
    if command.command_type == "runner.drain" {
        // An explicit drain must make progress even while control traffic
        // prevents idle polling. Only move one already-retained prefix under
        // this authority, after the previous outbox is cumulatively ACKed.
        // Never restore/poll a provider here. The runner, not the executor,
        // owns this receipt; false also covers pending delivery/backpressure.
        let mut drained = false;
        if state.outbox.is_empty()
            && state.acked_source_seq == state.highest_source_seq()
            && execution.events.is_empty()
            && !matches!(
                execution.result.get("status").and_then(Value::as_str),
                Some("failed" | "rejected")
            )
        {
            let prefix: Vec<_> = executor.retained_events()?.into_iter().take(128).collect();
            drained = prefix.is_empty();
            commit_executor_events(state, store, config, executor, prefix)?;
        }
        execution
            .result
            .as_object_mut()
            .ok_or_else(|| DurableRunnerError::invalid("drain result is not an object"))?
            .insert("retainedEventsDrained".to_owned(), Value::Bool(drained));
    } else if command.command_type == "run.attach" {
        // Rotation must preserve the old authority's retained audit FIFO.
        // Ordinary successful controls must not pull a whole provider backlog
        // ahead of stop/suspend result delivery; regular polling retains its
        // existing cumulative-ACK backpressure for those events.
        drain_retained_events(state, store, config, executor)?;
    } else if command.command_type == "session.snapshot"
        && command.payload.get("quiesceForWarmAttach") == Some(&Value::Bool(true))
        && execution
            .result
            .get("warmAttachReady")
            .and_then(Value::as_bool)
            .is_some()
        && !matches!(
            execution.result.get("status").and_then(Value::as_str),
            Some("failed" | "rejected")
        )
        && state.outbox.is_empty()
        && state.acked_source_seq == state.highest_source_seq()
    {
        // Repeated explicit readiness probes can otherwise occupy the control
        // loop forever while retained startup facts keep readiness false. Move
        // only one already-retained prefix, without polling/restoring, and wait
        // for its ordinary cumulative ACK before the next probe can advance.
        // The current result remains conservative; the next probe recomputes it.
        let prefix = executor.retained_events()?.into_iter().take(128).collect();
        commit_executor_events(state, store, config, executor, prefix)?;
    }
    for (event_type, priority, payload) in execution.events {
        state.enqueue_event(config, event_type, priority, payload)?;
    }
    let cleanup_proven = state
        .pending_provider_cleanup
        .as_ref()
        .is_some_and(|pending| {
            command.command_type == "turn.stop"
                && command.controller_seq > pending.controller_seq
                && execution.result.get("providerExitConfirmed") == Some(&Value::Bool(true))
        });
    let result = state.complete_command(command, execution.result)?;
    if cleanup_proven {
        state.pending_provider_cleanup = None;
    }
    store.save(state)?;
    Ok((result, CommandLifecycle::for_terminal(command)))
}

fn event_envelope_for_protocol(event: &StoredOutboxEvent, protocol_version: u64) -> Value {
    let mut envelope = event.envelope.clone();
    if protocol_version == 1 && envelope.pointer("/payload/schemaVersion") == Some(&json!(2)) {
        // Preserve the source sequence on a v1 connection so its cumulative
        // ACK can advance past an event family that only exists in PRP v2.
        // Never copy the v2 payload because it can include a goal objective.
        envelope["payload"]["schema"] = json!("paperclip.prp.event.v1");
        envelope["payload"]["eventType"] = json!("runner.diagnostic");
        envelope["payload"]["schemaVersion"] = json!(1);
        envelope["payload"]["payload"] = json!({
            "reasonCode": "event_requires_prp_v2",
            "originalEventType": event.event_type,
        });
    }
    envelope["version"] = json!(protocol_version);
    envelope
}

fn send_outbox(
    transport: &mut AuthenticatedTransport,
    state: &DurableState,
    sent_source_seq: &mut u64,
    protocol_version: u64,
) -> Result<(), DurableRunnerError> {
    for event in &state.outbox {
        if event.source_seq <= *sent_source_seq {
            continue;
        }
        let envelope = event_envelope_for_protocol(event, protocol_version);
        transport.send_json(&envelope)?;
        *sent_source_seq = event.source_seq;
    }
    Ok(())
}

fn command_result_envelope(
    state: &DurableState,
    result: &StoredCommandResult,
    protocol_version: u64,
) -> Value {
    let mut payload = json!(result);
    // "indeterminate" is an internal crash-recovery journal state. On the
    // wire it is a failed command with the preserved execution_indeterminate
    // reason so the controller can settle the command and continue replay.
    if result.status == "indeterminate" {
        payload["status"] = json!("failed");
    }
    json!({
        "protocol": PROTOCOL,
        "version": protocol_version,
        "kind": "command_result",
        "runnerInstanceId": state.runner_instance_id,
        "environmentLeaseId": state.environment_lease_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "itemId": state.item_id,
        "payload": payload,
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
        "version": connection.protocol_version,
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
        acknowledgements: Vec<usize>,
    }

    struct StartupFailureExecutor {
        retained: RetainingEventExecutor,
        polls: usize,
        calls: usize,
        stalled_ack: bool,
        alternating_ack: bool,
    }

    impl CommandExecutor for StartupFailureExecutor {
        fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
            self.calls += 1;
            Err(DurableRunnerError::invalid(
                "original provider startup failure",
            ))
        }
        fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
            self.polls += 1;
            Err(DurableRunnerError::invalid(
                "original autonomous restore failure",
            ))
        }
        fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
            Ok(self.retained.events.iter().take(128).cloned().collect())
        }
        fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
            if self.stalled_ack {
                return Ok(());
            }
            if self.alternating_ack {
                self.retained.events.rotate_left(1);
                return Ok(());
            }
            self.retained.acknowledge_events(count)
        }
    }

    #[test]
    fn startup_failure_facts_cross_full_fifo_before_failed_command_and_never_poll() {
        for mode in [
            "command",
            "poll",
            "ack_failure",
            "invalid_suffix",
            "stalled_ack",
            "alternating_ack",
            "outbox_full",
        ] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-startup-facts-{mode}-{}",
                uuid::Uuid::new_v4()
            ));
            let mut config = config(directory.clone());
            config.max_frame_bytes = 4096;
            config.max_outbox_bytes = 1024 * 1024;
            if mode == "outbox_full" {
                config.max_outbox_bytes = 64 * 1024;
            }
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let mut executor = StartupFailureExecutor {
                retained: RetainingEventExecutor {
                    events: (0..if mode == "alternating_ack" { 2 } else { 131 })
                        .map(|index| PolledEvent {
                            executor_event_id: format!("startup-fifo-{index}"),
                            event_type: "harness.diagnostic".to_owned(),
                            priority: EventPriority::P0,
                            payload: if mode == "invalid_suffix" && index == 130 {
                                json!({"message":"x".repeat(8192)})
                            } else {
                                json!({"code":"provider_startup_ownership", "index":index})
                            },
                        })
                        .collect(),
                    fail_acknowledgement: mode == "ack_failure",
                    acknowledgements: Vec::new(),
                },
                polls: 0,
                calls: 0,
                stalled_ack: mode == "stalled_ack",
                alternating_ack: mode == "alternating_ack",
            };
            let command = command("session.open");
            if mode == "poll" {
                let failure =
                    poll_executor_events(&mut state, &store, &config, &mut executor).unwrap_err();
                assert!(failure
                    .to_string()
                    .starts_with("original autonomous restore failure"));
                assert_eq!(executor.polls, 1);
            } else {
                let outcome = process_command(&mut state, &store, &config, &mut executor, &command);
                if mode == "command" {
                    let result = outcome.unwrap().0;
                    assert_eq!(result.status, "failed");
                    assert_eq!(
                        result.result["message"],
                        "original provider startup failure"
                    );
                    let replay =
                        process_command(&mut state, &store, &config, &mut executor, &command)
                            .unwrap()
                            .0;
                    assert_eq!(result, replay);
                } else {
                    let error = outcome.unwrap_err().to_string();
                    assert!(error.starts_with("original provider startup failure; retained failure evidence remains uncommitted:"));
                    assert_eq!(
                        state.processed_commands[&command.command_id].status,
                        "pending"
                    );
                    let replay =
                        process_command(&mut state, &store, &config, &mut executor, &command)
                            .unwrap()
                            .0;
                    assert_eq!(replay.status, "pending");
                    assert_eq!(executor.calls, 1);
                }
                assert_eq!(executor.polls, 0);
            }
            let (reloaded, _) = store.load_or_create(&config).unwrap();
            let expected = match mode {
                "ack_failure" | "stalled_ack" => 128,
                "invalid_suffix" => 130,
                "alternating_ack" => 2,
                "outbox_full" => reloaded.outbox.len(),
                _ => 131,
            };
            assert_eq!(reloaded.outbox.len(), expected);
            if mode == "outbox_full" {
                assert!(expected > 0 && expected < 131);
                assert_eq!(executor.retained.events.len() + expected, 131);
                assert_eq!(
                    executor.retained.acknowledgements.iter().sum::<usize>(),
                    expected
                );
            }
            if matches!(mode, "command" | "poll") {
                assert!(executor.retained.events.is_empty());
                assert_eq!(executor.retained.acknowledgements, vec![128, 3]);
            }
            fs::remove_dir_all(directory).unwrap();
        }
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
            self.acknowledgements.push(count);
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
    fn indeterminate_recovery_result_is_a_failed_wire_result() {
        let state = DurableState::new(&config(PathBuf::from("unused")));
        let result = StoredCommandResult {
            command_id: "command_1".to_owned(),
            controller_seq: 1,
            command_type: "semantic_tool.result".to_owned(),
            status: "indeterminate".to_owned(),
            result: json!({"code": "execution_indeterminate"}),
        };
        let envelope = command_result_envelope(&state, &result, 2);
        assert_eq!(envelope.pointer("/payload/status"), Some(&json!("failed")));
        assert_eq!(
            envelope.pointer("/payload/result/code"),
            Some(&json!("execution_indeterminate")),
        );
    }

    #[test]
    fn v2_outbox_event_becomes_redacted_v1_diagnostic_without_losing_sequence() {
        let config = config(PathBuf::from("unused"));
        let mut state = DurableState::new(&config);
        state
            .enqueue_event(
                &config,
                "session.goal.updated",
                EventPriority::P1,
                json!({
                    "goal": {
                        "objective": "sensitive operator objective",
                        "status": "active"
                    }
                }),
            )
            .unwrap();
        let event = &state.outbox[0];

        let downgraded = event_envelope_for_protocol(event, 1);
        assert_eq!(downgraded["version"], json!(1));
        assert_eq!(
            downgraded.pointer("/payload/sourceSeq"),
            Some(&json!(event.source_seq)),
        );
        assert_eq!(
            downgraded.pointer("/payload/schema"),
            Some(&json!("paperclip.prp.event.v1")),
        );
        assert_eq!(
            downgraded.pointer("/payload/eventType"),
            Some(&json!("runner.diagnostic")),
        );
        assert_eq!(
            downgraded.pointer("/payload/payload/originalEventType"),
            Some(&json!("session.goal.updated")),
        );
        assert!(!downgraded
            .to_string()
            .contains("sensitive operator objective"));

        let native = event_envelope_for_protocol(event, 2);
        assert_eq!(native["version"], json!(2));
        assert_eq!(
            native.pointer("/payload/eventType"),
            Some(&json!("session.goal.updated")),
        );
    }

    #[test]
    fn pre_auth_deadline_preserves_pending_terminal_delivery_without_launching() {
        struct ColdOnlyExecutor;
        impl CommandExecutor for ColdOnlyExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                panic!("pre-auth expiry cannot execute a command");
            }
            fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
                panic!("pre-auth terminal expiry cannot restore a provider");
            }
            fn reconcile_terminal_delivery(
                &mut self,
            ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
                Ok(TerminalDeliveryReconciliation::ProviderCleanupPending)
            }
        }
        for (kind, lifecycle) in [
            ("runner.suspend", "suspended"),
            ("runner.shutdown", "stopped"),
        ] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-runner-terminal-deadline-{}-{lifecycle}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&directory);
            let mut config = config(directory.clone());
            config.max_runtime = Duration::from_nanos(1);
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let terminal = command(kind);
            state.begin_command(&terminal).unwrap();
            let failed = state
                .fail_command(&terminal, json!({"code": "original_failure"}))
                .unwrap();
            persist_lifecycle_before_command_delivery(&mut state, &store, lifecycle, &failed)
                .unwrap();
            let error = run_durable_runner(
                config.clone(),
                BootstrapTicket::new("unused-test-ticket".to_owned()).unwrap(),
                ColdOnlyExecutor,
            )
            .unwrap_err();
            assert!(error
                .to_string()
                .contains("transport reconnect deadline elapsed"));
            let (restored, _) = store
                .load_or_create(&config)
                .expect("timeout cannot invalidate the retained terminal fence");
            assert_eq!(restored.lifecycle, lifecycle);
            assert_eq!(
                restored.pending_terminal_delivery,
                state.pending_terminal_delivery
            );
            assert_eq!(
                restored.processed_commands.get(&terminal.command_id),
                Some(&failed)
            );
            assert_eq!(
                restored.recoverable_failure.as_deref(),
                Some("transport_reconnect_deadline_exceeded")
            );
            for reason in [
                "transport_reconnect_grace_exceeded",
                "lease_expired_requires_bootstrap",
            ] {
                let mut expired = restored.clone();
                record_recoverable_transport_failure(&mut expired, reason);
                store.save(&expired).unwrap();
                let (expired, _) = store.load_or_create(&config).unwrap();
                assert_eq!(expired.lifecycle, lifecycle);
                assert_eq!(
                    expired.pending_terminal_delivery,
                    state.pending_terminal_delivery
                );
                assert_eq!(
                    expired.processed_commands.get(&terminal.command_id),
                    Some(&failed)
                );
                assert_eq!(expired.recoverable_failure.as_deref(), Some(reason));
            }
            fs::remove_dir_all(directory).unwrap();
        }
        let mut ordinary = DurableState::new(&config(PathBuf::from("unused")));
        record_recoverable_transport_failure(&mut ordinary, "lease_expired_requires_bootstrap");
        assert_eq!(ordinary.lifecycle, "recoverable_failure");
    }

    #[test]
    fn pending_provider_cleanup_blocks_new_work_and_preserves_failed_terminal() {
        for kind in ["run.attach", "turn.start", "runner.drain", "runner.suspend"] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-runner-cleanup-gate-{}-{kind}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&directory);
            let config = config(directory.clone());
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let terminal = command("runner.suspend");
            state.begin_command(&terminal).unwrap();
            let failed = state
                .fail_command(&terminal, json!({"code": "retained_failure"}))
                .unwrap();
            state.lifecycle = "suspended".to_owned();
            let mut persisted = serde_json::to_value(&state).unwrap();
            persisted["pendingProviderCleanup"] = json!({
                "commandId": terminal.command_id,
                "controllerSeq": terminal.controller_seq,
                "commandType": terminal.command_type,
                "lifecycle": "suspended",
            });
            state = serde_json::from_value(persisted).unwrap();
            store.save(&state).unwrap();
            let mut next = command(kind);
            next.command_id = "new-command".to_owned();
            next.controller_seq = 2;
            let mut executor = CountingExecutor { calls: 0 };
            process_command(&mut state, &store, &config, &mut executor, &next)
                .expect_err("unproved provider cleanup must fence new work");
            assert_eq!(executor.calls, 0);
            assert_eq!(
                state.processed_commands.get(&terminal.command_id),
                Some(&failed)
            );
            assert_eq!(state.last_controller_command_seq, 1);
            let (restored, _) = store.load_or_create(&config).unwrap();
            assert!(!serde_json::to_value(restored).unwrap()["pendingProviderCleanup"].is_null());
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn delivery_only_reconciliation_keeps_cleanup_fenced_until_a_new_proven_stop() {
        struct ColdExecutor {
            polls: usize,
            maintenance: usize,
            shutdowns: usize,
            reconciliations: usize,
            calls: usize,
            stop_proof: Value,
        }
        impl CommandExecutor for ColdExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                self.calls += 1;
                if self.stop_proof == json!({"fail": true}) {
                    return Err(DurableRunnerError::invalid("new stop failed"));
                }
                Ok(CommandExecution::result(
                    json!({"providerExitConfirmed": self.stop_proof}),
                ))
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                self.polls += 1;
                Ok(Vec::new())
            }
            fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
                self.maintenance += 1;
                Ok(())
            }
            fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
                self.shutdowns += 1;
                Ok(())
            }
            fn reconcile_terminal_delivery(
                &mut self,
            ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
                self.reconciliations += 1;
                Ok(TerminalDeliveryReconciliation::ProviderCleanupPending)
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-delivery-only-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let terminal = command("runner.suspend");
        state.begin_command(&terminal).unwrap();
        let failed = state
            .fail_command(&terminal, json!({"code": "original_failure"}))
            .unwrap();
        persist_lifecycle_before_command_delivery(&mut state, &store, "suspended", &failed)
            .unwrap();
        let mut executor = ColdExecutor {
            polls: 0,
            maintenance: 0,
            shutdowns: 0,
            reconciliations: 0,
            calls: 0,
            stop_proof: Value::Null,
        };
        // Failed/expired terminal delivery cleanup must also remain cold.
        shutdown_preserving_cleanup(&state, &mut executor).unwrap();
        assert!(state.pending_terminal_delivery.is_some());
        finish_terminal_reconciliation(&mut state, &store, &mut executor).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        assert!(state.pending_terminal_delivery.is_none());
        assert_eq!(
            state.pending_provider_cleanup.as_ref().unwrap().command_id,
            terminal.command_id
        );
        assert_eq!(state.lifecycle, "suspended");
        assert_eq!(
            state.processed_commands.get(&terminal.command_id),
            Some(&failed)
        );
        shutdown_preserving_cleanup(&state, &mut executor).unwrap();
        poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();
        poll_executor_events_after_controller_ack(&mut state, &store, &config, &mut executor, 1)
            .unwrap();
        poll_executor_events_when_control_idle(
            &mut state,
            &store,
            &config,
            &mut executor,
            0,
            &Ok(Some(json!({"kind": "ping"}))),
        )
        .unwrap();
        assert_eq!(
            (executor.polls, executor.maintenance, executor.shutdowns),
            (0, 0, 0)
        );
        assert_eq!(executor.reconciliations, 3);
        let (replayed, _) =
            process_command(&mut state, &store, &config, &mut executor, &terminal).unwrap();
        assert_eq!(replayed, failed);
        assert_eq!(executor.calls, 0);
        for (index, proof) in [
            json!({"fail": true}),
            json!(false),
            json!("true"),
            json!(true),
        ]
        .into_iter()
        .enumerate()
        {
            executor.stop_proof = proof;
            let mut stop = command("turn.stop");
            stop.command_id = format!("new-stop-{index}");
            stop.controller_seq = index as u64 + 2;
            process_command(&mut state, &store, &config, &mut executor, &stop).unwrap();
            assert_eq!(state.pending_provider_cleanup.is_none(), index == 3);
            let (restored, _) = store.load_or_create(&config).unwrap();
            assert_eq!(
                restored.pending_provider_cleanup,
                state.pending_provider_cleanup
            );
            assert_eq!(
                restored.processed_commands.get(&terminal.command_id),
                Some(&failed)
            );
            if index == 0 {
                assert_eq!(
                    restored
                        .processed_commands
                        .get(&stop.command_id)
                        .unwrap()
                        .status,
                    "failed"
                );
                let (old_result, lifecycle) =
                    process_command(&mut state, &store, &config, &mut executor, &terminal).unwrap();
                assert_eq!(old_result, failed);
                assert_eq!(lifecycle, CommandLifecycle::Continue);
                assert!(state.pending_terminal_delivery.is_none());
                assert_eq!(state.last_controller_command_seq, 2);
                store
                    .load_or_create(&config)
                    .expect("old terminal replay cannot invalidate the new cursor");
            }
        }
        let mut start = command("turn.start");
        start.command_id = "after-cleanup".to_owned();
        start.controller_seq = 6;
        process_command(&mut state, &store, &config, &mut executor, &start).unwrap();
        assert_eq!(executor.calls, 5);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pending_provider_cleanup_rejects_forged_terminal_identity_on_reload() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-cleanup-marker-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let terminal = command("runner.suspend");
        state.begin_command(&terminal).unwrap();
        state
            .fail_command(&terminal, json!({"code": "original_failure"}))
            .unwrap();
        state.lifecycle = "suspended".to_owned();
        for (field, value) in [
            ("commandId", json!("foreign")),
            ("controllerSeq", json!(2)),
            ("commandType", json!("turn.start")),
            ("lifecycle", json!("ready")),
        ] {
            let mut encoded = serde_json::to_value(&state).unwrap();
            encoded["pendingProviderCleanup"] = json!({"commandId": terminal.command_id, "controllerSeq": 1, "commandType": "runner.suspend", "lifecycle": "suspended"});
            encoded["pendingProviderCleanup"][field] = value;
            store
                .save(&serde_json::from_value(encoded).unwrap())
                .unwrap();
            assert!(
                store.load_or_create(&config).is_err(),
                "must reject forged {field}"
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn warm_attachment_rejects_v1_before_provider_rebind_even_without_replay_cache() {
        let next = Some(config(std::path::PathBuf::from("unused")));
        assert!(require_warm_transition_capability(&next, Some(1), 1).is_err());
        assert!(require_warm_transition_capability(&next, Some(1), 2).is_ok());
        assert!(require_warm_transition_capability(&next, None, 2).is_err());
        assert!(require_warm_transition_capability(&None, None, 1).is_ok());
    }

    #[test]
    fn warm_rotation_preserves_unobserved_v2_session_state_until_native_ack() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-warm-v2-observation-{}",
            std::process::id()
        ));
        let mut current = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&current).unwrap();
        for (event_type, payload) in [
            (
                "session.capabilities.updated",
                json!({"sessionGoals": {"supported": true}}),
            ),
            (
                "session.goal.snapshot",
                json!({"goal": {"objective": "retained objective"}}),
            ),
        ] {
            state
                .enqueue_event(&current, event_type, EventPriority::P0, payload)
                .unwrap();
        }
        state.apply_ack(2, 1).unwrap();
        store.save(&state).unwrap();
        let before = serde_json::to_value(&state).unwrap();
        let mut next = current.clone();
        next.run_id = "run_2".to_owned();
        next.turn_id = "turn_2".to_owned();
        next.item_id = "item_2".to_owned();
        let mut endpoint =
            RunnerTransportEndpoint::new(&current.connect_url, &current.run_id).unwrap();
        assert!(apply_authority_rotation(
            &mut state,
            &store,
            &mut current,
            &mut endpoint,
            next.clone()
        )
        .is_err());
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
        assert_eq!(
            serde_json::to_value(store.load_or_create(&current).unwrap().0).unwrap(),
            before
        );
        assert_eq!(current.run_id, "run_1");

        // A newly authorized v2 connection observes native state on its original
        // authority. This is not a protocol upgrade of an existing v1 lease.
        state.restore_v2_replay_events(&current).unwrap();
        assert_eq!(state.outbox.len(), 2);
        assert!(state
            .outbox
            .iter()
            .all(|event| event.envelope["payload"]["runId"] == "run_1"));
        state.apply_ack(4, 2).unwrap();
        store.save(&state).unwrap();
        apply_authority_rotation(&mut state, &store, &mut current, &mut endpoint, next).unwrap();
        state.restore_v2_replay_events(&current).unwrap();
        assert!(
            state.outbox.is_empty(),
            "old observations must not be relabeled under the new run"
        );
        assert_eq!(state.run_id, "run_2");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn warm_run_attachment_rotates_only_the_run_authority() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-warm-authority-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut current = config(directory.clone());
        current.runner_digest = format!("sha256:{}", "a".repeat(64));
        let mut attach = command("run.attach");
        attach.payload = json!({
            "paperclipNextAuthority": {
                "identity": {
                    "runnerInstanceId": current.runner_instance_id,
                    "environmentLeaseId": current.environment_lease_id,
                    "runId": "run_2",
                    "normalizedSessionId": current.normalized_session_id,
                    "turnId": "turn_2",
                    "itemId": "item_2"
                },
                "connection": {
                    "mode": "connect",
                    "connectUrl": "ws://127.0.0.1:3001/path"
                }
            }
        });

        let next = next_authority_config(&attach, &current)
            .unwrap()
            .expect("attachment should carry a new authority");
        assert_eq!(next.run_id, "run_2");
        assert_eq!(next.connect_url, "ws://127.0.0.1:3001/path");

        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&current).unwrap();
        state
            .enqueue_event(&current, "run.attached", EventPriority::P0, json!({}))
            .unwrap();
        store.save(&state).unwrap();
        let mut endpoint =
            RunnerTransportEndpoint::new(&current.connect_url, &current.run_id).unwrap();
        assert!(apply_authority_rotation(
            &mut state,
            &store,
            &mut current,
            &mut endpoint,
            next.clone()
        )
        .is_err());
        assert_eq!(current.run_id, "run_1");
        let (preserved, _) = store.load_or_create(&current).unwrap();
        assert_eq!(preserved.outbox.len(), 1);
        state.apply_ack(1, 2).unwrap();
        store.save(&state).unwrap();
        apply_authority_rotation(&mut state, &store, &mut current, &mut endpoint, next).unwrap();

        assert_eq!(state.run_id, "run_2");
        assert_eq!(state.next_source_seq, 1);
        assert!(state.outbox.is_empty());
        assert_eq!(current.run_id, "run_2");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_drain_transfers_completed_semantic_result_despite_98_busy_controls() {
        struct DrainExecutor {
            retained: VecDeque<PolledEvent>,
            reads: usize,
            calls: usize,
            command_events: bool,
        }
        impl CommandExecutor for DrainExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                self.calls += 1;
                Ok(CommandExecution {
                    result: json!({}),
                    events: if self.command_events {
                        vec![(
                            "harness.diagnostic".to_owned(),
                            EventPriority::P0,
                            json!({"fromCommand": true}),
                        )]
                    } else {
                        vec![]
                    },
                })
            }
            fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                self.reads += 1;
                Ok(self.retained.iter().cloned().collect())
            }
            fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
                self.retained.drain(..count);
                Ok(())
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("drain must not poll, restore, or launch a provider")
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "paperclip-explicit-drain-prefix-{}",
            uuid::Uuid::new_v4()
        ));
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1_048_576;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        // The tool result has already completed under the old authority. No
        // idle receive is needed or permitted to retrieve its durable suffix.
        let mut executor = DrainExecutor {
            retained: (0..257)
                .map(|index| PolledEvent {
                    executor_event_id: format!("old-result-{index}"),
                    event_type: "semantic_tool.result".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({"index": index, "correlation": {"runId": config.run_id}}),
                })
                .collect(),
            reads: 0,
            calls: 0,
            command_events: false,
        };
        for seq in 1..=98 {
            let mut drain = command("runner.drain");
            drain.command_id = format!("drain-{seq}");
            drain.controller_seq = seq;
            let result = process_command(&mut state, &store, &config, &mut executor, &drain)
                .unwrap()
                .0;
            assert_eq!(result.status, "completed");
            assert_eq!(result.result["retainedEventsDrained"], json!(false));
        }
        assert_eq!(
            executor.reads, 1,
            "98 controls must advance exactly one ACK-bounded prefix"
        );
        assert_eq!(state.outbox.len(), 128);
        assert_eq!(executor.retained.len(), 129);
        assert_eq!(store.load_or_create(&config).unwrap().0.outbox.len(), 128);
        for seq in 99..=100 {
            state.apply_ack(state.highest_source_seq(), 2).unwrap();
            store.save(&state).unwrap();
            let mut drain = command("runner.drain");
            drain.command_id = format!("drain-{seq}");
            drain.controller_seq = seq;
            process_command(&mut state, &store, &config, &mut executor, &drain).unwrap();
            let calls = executor.calls;
            let reads = executor.reads;
            process_command(&mut state, &store, &config, &mut executor, &drain).unwrap();
            assert_eq!(executor.calls, calls, "command replay cannot execute again");
            assert_eq!(
                executor.reads, reads,
                "command replay cannot consume another prefix"
            );
        }
        assert!(executor.retained.is_empty());
        assert_eq!(state.highest_source_seq(), 257);
        assert_eq!(state.outbox.len(), 1);
        let event = &state.outbox[0];
        assert_eq!(event.envelope["runId"], json!(config.run_id));
        assert_eq!(
            event.envelope["payload"]["payload"]["correlation"]["runId"],
            json!(config.run_id)
        );
        assert_eq!(event.envelope["payload"]["payload"]["index"], json!(256));
        state.apply_ack(state.highest_source_seq(), 2).unwrap();
        store.save(&state).unwrap();
        let mut drained = command("runner.drain");
        drained.command_id = "empty-drain".to_owned();
        drained.controller_seq = 101;
        let result = process_command(&mut state, &store, &config, &mut executor, &drained)
            .unwrap()
            .0;
        assert_eq!(result.result["retainedEventsDrained"], json!(true));
        executor.command_events = true;
        drained.command_id = "drain-emits-command-event".to_owned();
        drained.controller_seq = 102;
        let result = process_command(&mut state, &store, &config, &mut executor, &drained)
            .unwrap()
            .0;
        assert_eq!(result.result["retainedEventsDrained"], json!(false));
        assert_eq!(
            state.outbox.len(),
            1,
            "command-generated events also require a durable ACK"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_drain_preserves_unsettled_suffix_on_disk_ack_and_oversized_failures() {
        struct FaultExecutor {
            events: VecDeque<PolledEvent>,
            acked: usize,
            mode: &'static str,
            path: PathBuf,
        }
        impl CommandExecutor for FaultExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                // An executor cannot self-certify the runner's durable fence.
                Ok(CommandExecution::result(
                    json!({"retainedEventsDrained": true}),
                ))
            }
            fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                if self.mode == "disk" {
                    fs::rename(&self.path, self.path.with_extension("preserved")).unwrap();
                    fs::create_dir(&self.path).unwrap();
                }
                Ok(self.events.iter().cloned().collect())
            }
            fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
                if self.mode == "ack" {
                    return Err(DurableRunnerError::invalid("fixture provider ACK lost"));
                }
                self.acked += count;
                self.events.drain(..count);
                Ok(())
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("drain failure must not restore or poll a provider")
            }
        }
        for mode in ["disk", "ack", "oversized"] {
            let directory = std::env::temp_dir()
                .join(format!("paperclip-drain-{mode}-{}", uuid::Uuid::new_v4()));
            let mut config = config(directory.clone());
            config.max_frame_bytes = 4096;
            config.max_outbox_bytes = 1_048_576;
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let mut executor = FaultExecutor {
                events: (0..2).map(|index| PolledEvent {
                    executor_event_id: format!("drain-fault-{index}"),
                    event_type: "semantic_tool.result".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({"index": index, "data": if mode == "oversized" && index == 1 {
                        "x".repeat(8192)
                    } else { "small".to_owned() }}),
                }).collect(),
                acked: 0, mode, path: store.path().to_path_buf(),
            };
            let drain = command("runner.drain");
            assert!(process_command(&mut state, &store, &config, &mut executor, &drain).is_err());
            if mode == "disk" {
                fs::remove_dir(store.path()).unwrap();
                fs::rename(store.path().with_extension("preserved"), store.path()).unwrap();
            }
            let (mut reloaded, _) = store.load_or_create(&config).unwrap();
            assert_eq!(
                reloaded.outbox.len(),
                match mode {
                    "disk" => 0,
                    "ack" => 2,
                    _ => 1,
                }
            );
            assert_eq!(executor.acked, if mode == "oversized" { 1 } else { 0 });
            assert_eq!(
                executor.events.len(),
                if mode == "oversized" { 1 } else { 2 }
            );
            let replay = process_command(&mut reloaded, &store, &config, &mut executor, &drain)
                .unwrap()
                .0;
            assert_ne!(
                replay.status, "completed",
                "a failed drain cannot mint a reusable receipt"
            );
            assert_ne!(
                replay.result.get("retainedEventsDrained"),
                Some(&json!(true))
            );
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn ordinary_success_preserves_retained_backlog_for_control_first_polling() {
        struct StopExecutor {
            retained: Vec<PolledEvent>,
            retained_reads: usize,
        }
        impl CommandExecutor for StopExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                Ok(CommandExecution::result(
                    json!({"providerExitConfirmed": true}),
                ))
            }
            fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                self.retained_reads += 1;
                Ok(self.retained.clone())
            }
            fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
                self.retained.drain(..count);
                Ok(())
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("a control command must not poll the provider")
            }
        }
        for kind in ["turn.stop", "runner.suspend", "session.snapshot"] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-control-first-retained-{}",
                uuid::Uuid::new_v4()
            ));
            let mut config = config(directory.clone());
            config.max_outbox_bytes = 1_048_576;
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let retained = (0..131)
                .map(|index| PolledEvent {
                    executor_event_id: format!("retained-{index}"),
                    event_type: "item.delta".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"delta": "retained backlog"}),
                })
                .collect::<Vec<_>>();
            let mut executor = StopExecutor {
                retained,
                retained_reads: 0,
            };
            let result =
                process_command(&mut state, &store, &config, &mut executor, &command(kind))
                    .unwrap()
                    .0;
            assert_eq!(result.status, "completed");
            assert_eq!(
                executor.retained_reads, 0,
                "{kind} must not move the provider FIFO ahead of control delivery"
            );
            assert_eq!(executor.retained.len(), 131);
            assert!(state.outbox.is_empty());
            assert!(store.load_or_create(&config).unwrap().0.outbox.is_empty());
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn explicit_quiescing_snapshot_advances_one_retained_prefix_only_after_old_ack() {
        struct SnapshotExecutor {
            retained: VecDeque<PolledEvent>,
            reads: usize,
            result_override: Option<Value>,
        }
        impl CommandExecutor for SnapshotExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                Ok(CommandExecution::result(
                    self.result_override.clone().unwrap_or_else(|| {
                        json!({
                            "warmAttachReady": self.retained.is_empty(),
                        })
                    }),
                ))
            }
            fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                self.reads += 1;
                Ok(self.retained.iter().cloned().collect())
            }
            fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
                self.retained.drain(..count);
                Ok(())
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("readiness transfer must not poll or restore a provider")
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "paperclip-warm-readiness-prefix-{}",
            uuid::Uuid::new_v4()
        ));
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1_048_576;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = SnapshotExecutor {
            retained: (0..131)
                .map(|index| PolledEvent {
                    executor_event_id: format!("retained-{index}"),
                    event_type: "harness.diagnostic".to_owned(),
                    priority: EventPriority::P0,
                    payload: json!({"index": index}),
                })
                .collect(),
            reads: 0,
            result_override: None,
        };
        for seq in 1..=4 {
            let mut snapshot = command("session.snapshot");
            snapshot.command_id = format!("snapshot-{seq}");
            snapshot.controller_seq = seq;
            snapshot.payload = json!({"quiesceForWarmAttach": true});
            if seq == 3 || seq == 4 {
                state.apply_ack(state.highest_source_seq(), 2).unwrap();
                store.save(&state).unwrap();
            }
            let result = process_command(&mut state, &store, &config, &mut executor, &snapshot)
                .unwrap()
                .0;
            assert_eq!(result.result["warmAttachReady"], json!(seq == 4));
            match seq {
                1 | 2 => {
                    assert_eq!(
                        executor.reads, 1,
                        "unACKed outbox blocks another retained prefix"
                    );
                    assert_eq!(executor.retained.len(), 3);
                    assert_eq!(state.outbox.len(), 128);
                }
                3 => {
                    assert_eq!(executor.reads, 2);
                    assert!(executor.retained.is_empty());
                    assert_eq!(state.outbox.len(), 3);
                }
                4 => assert!(state.outbox.is_empty()),
                _ => unreachable!(),
            }
        }
        executor.retained.push_back(PolledEvent {
            executor_event_id: "retained-negative".to_owned(),
            event_type: "harness.diagnostic".to_owned(),
            priority: EventPriority::P0,
            payload: json!({"negative": true}),
        });
        let reads = executor.reads;
        for (index, result) in [
            json!({"status": "rejected", "warmAttachReady": false}),
            json!({"status": "failed", "warmAttachReady": true}),
            json!({"status": "completed"}),
            json!({"warmAttachReady": "true"}),
        ]
        .into_iter()
        .enumerate()
        {
            executor.result_override = Some(result);
            let mut snapshot = command("session.snapshot");
            snapshot.command_id = format!("negative-snapshot-{index}");
            snapshot.controller_seq = 5 + index as u64;
            snapshot.payload = json!({"quiesceForWarmAttach": true});
            process_command(&mut state, &store, &config, &mut executor, &snapshot).unwrap();
            assert_eq!(
                executor.reads, reads,
                "only a genuine readiness result may transfer a prefix"
            );
            assert_eq!(executor.retained.len(), 1);
            assert!(state.outbox.is_empty());
        }
        assert!(store.load_or_create(&config).unwrap().0.outbox.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn completed_attachment_commits_retained_fifo_before_execution_events_and_replays_without_effects(
    ) {
        struct AttachExecutor {
            calls: usize,
            retained: VecDeque<PolledEvent>,
            fail_ack: bool,
        }
        impl CommandExecutor for AttachExecutor {
            fn execute(&mut self, _: &Command) -> Result<CommandExecution, DurableRunnerError> {
                self.calls += 1;
                Ok(CommandExecution {
                    result: json!({"status":"resumed"}),
                    events: vec![(
                        "run.attached".to_owned(),
                        EventPriority::P0,
                        json!({"order":3}),
                    )],
                })
            }
            fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                Ok(self.retained.iter().cloned().collect())
            }
            fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
                if self.fail_ack {
                    return Err(DurableRunnerError::invalid("retained ACK failure"));
                }
                self.retained.drain(..count);
                Ok(())
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("no polling during command receipt transfer")
            }
        }
        for fail_ack in [false, true] {
            let directory = std::env::temp_dir().join(format!(
                "paperclip-attach-evidence-{}",
                uuid::Uuid::new_v4()
            ));
            let config = config(directory.clone());
            let store = DurableStateStore::new(&directory).unwrap();
            let (mut state, _) = store.load_or_create(&config).unwrap();
            let mut executor = AttachExecutor {
                calls: 0,
                fail_ack,
                retained: (1..=2)
                    .map(|order| PolledEvent {
                        executor_event_id: format!("retained-{order}"),
                        event_type: "harness.diagnostic".to_owned(),
                        priority: EventPriority::P0,
                        payload: json!({"order":order}),
                    })
                    .collect(),
            };
            let attach = command("run.attach");
            let outcome = process_command(&mut state, &store, &config, &mut executor, &attach);
            if fail_ack {
                assert!(outcome.is_err());
                assert_eq!(
                    state.processed_commands[&attach.command_id].status,
                    "pending"
                );
            } else {
                assert!(completed_attachment(&outcome.unwrap().0));
            }
            let (mut reloaded, _) = store.load_or_create(&config).unwrap();
            assert_eq!(
                reloaded
                    .outbox
                    .iter()
                    .map(|event| event
                        .envelope
                        .pointer("/payload/payload/order")
                        .or_else(|| event.envelope.pointer("/payload/order"))
                        .cloned()
                        .unwrap_or(Value::Null))
                    .collect::<Vec<_>>(),
                if fail_ack {
                    vec![json!(1), json!(2)]
                } else {
                    vec![json!(1), json!(2), json!(3)]
                }
            );
            let replay = process_command(&mut reloaded, &store, &config, &mut executor, &attach)
                .unwrap()
                .0;
            assert_eq!(executor.calls, 1);
            assert_eq!(
                replay.status,
                if fail_ack {
                    "indeterminate"
                } else {
                    "completed"
                }
            );
            for (status, payload_status) in [
                ("failed", "resumed"),
                ("pending", "resumed"),
                ("rejected", "resumed"),
                ("completed", "rejected"),
                ("completed", "failed"),
            ] {
                let mut rejected = replay.clone();
                rejected.status = status.to_owned();
                rejected.result = json!({"status":payload_status});
                assert!(!completed_attachment(&rejected));
            }
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn warm_run_attachment_reuses_the_provider_ingress_listener() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-warm-listener-authority-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut current = config(directory.clone());
        current.connect_url = "listen://0.0.0.0:43127/api/runner/v1/connect/run_1".to_owned();
        current.runner_digest = format!("sha256:{}", "a".repeat(64));
        let mut next = current.clone();
        next.run_id = "run_2".to_owned();
        next.turn_id = "turn_2".to_owned();
        next.item_id = "item_2".to_owned();
        next.connect_url = "listen://0.0.0.0:43127/api/runner/v1/connect/run_2".to_owned();

        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&current).unwrap();
        let mut endpoint =
            RunnerTransportEndpoint::new(&current.connect_url, &current.run_id).unwrap();

        apply_authority_rotation(&mut state, &store, &mut current, &mut endpoint, next).unwrap();

        assert_eq!(current.run_id, "run_2");
        assert_eq!(state.run_id, "run_2");
        match endpoint {
            RunnerTransportEndpoint::Listen { path, .. } => {
                assert_eq!(path, "/api/runner/v1/connect/run_2");
            }
            RunnerTransportEndpoint::Dial(_) => panic!("listener mode must remain active"),
        }
        fs::remove_dir_all(directory).unwrap();
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
    fn cumulative_ack_bursts_checkpoint_without_blocking_the_next_command() {
        struct AckObservingExecutor {
            config: DurableRunnerConfig,
            acked_before_effect: Option<u64>,
        }
        impl CommandExecutor for AckObservingExecutor {
            fn execute(
                &mut self,
                _command: &Command,
            ) -> Result<CommandExecution, DurableRunnerError> {
                let store = DurableStateStore::new(&self.config.state_dir)?;
                let (persisted, _) = store.load_or_create(&self.config)?;
                self.acked_before_effect = Some(persisted.acked_source_seq);
                Ok(CommandExecution::result(json!({"status": "completed"})))
            }
        }

        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-ack-checkpoint-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 2 * 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        for index in 1..=128 {
            state
                .enqueue_event(
                    &config,
                    "item.delta",
                    EventPriority::P1,
                    json!({"index": index}),
                )
                .unwrap();
        }
        store.save(&state).unwrap();

        let mut persistence = CumulativeAckPersistence::default();
        for ack in 1..CUMULATIVE_ACK_PERSIST_INTERVAL as u64 {
            persistence.apply(&mut state, &store, ack, 2).unwrap();
        }
        let (before_checkpoint, _) = store.load_or_create(&config).unwrap();
        assert_eq!(before_checkpoint.acked_source_seq, 0);
        assert_eq!(before_checkpoint.outbox.len(), 128);

        persistence
            .apply(
                &mut state,
                &store,
                CUMULATIVE_ACK_PERSIST_INTERVAL as u64,
                2,
            )
            .unwrap();
        let (first_checkpoint, _) = store.load_or_create(&config).unwrap();
        assert_eq!(
            first_checkpoint.acked_source_seq,
            CUMULATIVE_ACK_PERSIST_INTERVAL as u64
        );
        assert_eq!(
            first_checkpoint.outbox.len(),
            128 - CUMULATIVE_ACK_PERSIST_INTERVAL
        );

        persistence
            .apply(
                &mut state,
                &store,
                CUMULATIVE_ACK_PERSIST_INTERVAL as u64 + 1,
                2,
            )
            .unwrap();
        let mut next_command = command("runner.drain");
        next_command.controller_seq = 1;
        let mut executor = AckObservingExecutor {
            config: config.clone(),
            acked_before_effect: None,
        };
        process_command(&mut state, &store, &config, &mut executor, &next_command).unwrap();
        let (after_command, _) = store.load_or_create(&config).unwrap();
        assert_eq!(
            after_command.acked_source_seq,
            CUMULATIVE_ACK_PERSIST_INTERVAL as u64 + 1
        );
        assert_eq!(
            executor.acked_before_effect,
            Some(CUMULATIVE_ACK_PERSIST_INTERVAL as u64 + 1)
        );

        for ack in CUMULATIVE_ACK_PERSIST_INTERVAL as u64 + 2..=128 {
            persistence.apply(&mut state, &store, ack, 2).unwrap();
        }
        let (fully_acked, _) = store.load_or_create(&config).unwrap();
        assert_eq!(fully_acked.acked_source_seq, 128);
        assert!(fully_acked.outbox.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn provider_poll_yields_until_the_sent_controller_ack_prefix_is_consumed() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-controller-ack-fairness-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: (1..=128)
                .map(|index| PolledEvent {
                    executor_event_id: format!("provider-event-{index}"),
                    event_type: "item.delta".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"index": index}),
                })
                .collect(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        poll_executor_events_after_controller_ack(&mut state, &store, &config, &mut executor, 0)
            .unwrap();
        let sent_source_seq = state.highest_source_seq();
        assert_eq!(sent_source_seq, 128);
        executor.events.push_back(PolledEvent {
            executor_event_id: "provider-event-129".to_owned(),
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P1,
            payload: json!({"index": 129}),
        });

        // This is the real loop ordering: before each received ACK the runner
        // has a provider poll opportunity. A 128-event provider prefix must not
        // turn 128 queued controller ACKs into 128 further provider batches.
        for ack in 1..=128 {
            poll_executor_events_after_controller_ack(
                &mut state,
                &store,
                &config,
                &mut executor,
                sent_source_seq,
            )
            .unwrap();
            assert_eq!(state.highest_source_seq(), 128, "before ACK {ack}");
            assert_eq!(executor.events.len(), 1);
            state.apply_ack(ack, 2).unwrap();
            store.save(&state).unwrap();
        }
        assert_eq!(executor.acknowledgements, vec![128]);
        poll_executor_events_after_controller_ack(
            &mut state,
            &store,
            &config,
            &mut executor,
            sent_source_seq,
        )
        .unwrap();
        assert_eq!(executor.acknowledgements, vec![128, 1]);
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(reloaded.acked_source_seq, 128);
        assert_eq!(reloaded.outbox.len(), 1);
        assert_eq!(reloaded.outbox[0].source_seq, 129);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn controller_ack_debt_runs_cleanup_without_moving_event_or_ack_cursors() {
        struct MaintenanceExecutor {
            calls: usize,
            fail: bool,
        }
        impl CommandExecutor for MaintenanceExecutor {
            fn execute(
                &mut self,
                _command: &Command,
            ) -> Result<CommandExecution, DurableRunnerError> {
                unreachable!("no controller command is needed for autonomous cleanup")
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("ordinary provider ingress must remain gated")
            }
            fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
                self.calls += 1;
                if self.fail {
                    Err(DurableRunnerError::invalid("cleanup persistence failed"))
                } else {
                    Ok(())
                }
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-controller-ack-maintenance-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state
            .enqueue_event(
                &config,
                "item.delta",
                EventPriority::P1,
                json!({"index": 1}),
            )
            .unwrap();
        store.save(&state).unwrap();
        let original = serde_json::to_value(&state).unwrap();
        let mut executor = MaintenanceExecutor {
            calls: 0,
            fail: false,
        };
        poll_executor_events_after_controller_ack(&mut state, &store, &config, &mut executor, 1)
            .unwrap();
        assert_eq!(executor.calls, 1);
        assert_eq!(serde_json::to_value(&state).unwrap(), original);
        executor.fail = true;
        assert!(poll_executor_events_after_controller_ack(
            &mut state,
            &store,
            &config,
            &mut executor,
            1
        )
        .unwrap_err()
        .to_string()
        .contains("cleanup persistence failed"));
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(serde_json::to_value(&reloaded).unwrap(), original);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn controller_commands_progress_while_provider_poll_waits_for_ack() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-controller-command-fairness-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state
            .enqueue_event(
                &config,
                "item.delta",
                EventPriority::P1,
                json!({"index": 1}),
            )
            .unwrap();
        store.save(&state).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([PolledEvent {
                executor_event_id: "provider-pending-delta".to_owned(),
                event_type: "item.delta".to_owned(),
                priority: EventPriority::P1,
                payload: json!({"index": 2}),
            }]),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        poll_executor_events_after_controller_ack(&mut state, &store, &config, &mut executor, 1)
            .unwrap();
        let (result, lifecycle) = process_command(
            &mut state,
            &store,
            &config,
            &mut executor,
            &command("runner.suspend"),
        )
        .unwrap();
        persist_lifecycle_before_command_delivery(
            &mut state,
            &store,
            lifecycle.durable_state().unwrap(),
            &result,
        )
        .unwrap();
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(reloaded.lifecycle, "suspended");
        assert!(reloaded.pending_terminal_delivery.is_some());
        assert_eq!(reloaded.acked_source_seq, 0);
        assert_eq!(reloaded.outbox.len(), 1);
        assert_eq!(executor.events.len(), 1);
        assert!(executor.acknowledgements.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn queued_suspend_precedes_provider_tail_after_last_controller_ack() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-control-before-provider-tail-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        state
            .enqueue_event(
                &config,
                "item.delta",
                EventPriority::P1,
                json!({"index": 0}),
            )
            .unwrap();
        state.apply_ack(1, 2).unwrap();
        store.save(&state).unwrap();
        let mut executor = RetainingEventExecutor {
            events: (1..=128)
                .map(|index| PolledEvent {
                    executor_event_id: format!("tail-{index}"),
                    event_type: "item.delta".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"index": index}),
                })
                .collect(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        let suspend = command("runner.suspend");
        let pending_control = Ok(Some(json!({"kind": "command", "payload": suspend})));
        poll_executor_events_when_control_idle(
            &mut state,
            &store,
            &config,
            &mut executor,
            1,
            &pending_control,
        )
        .unwrap();
        assert_eq!(
            state.highest_source_seq(),
            1,
            "a queued close command must not wait behind a fresh fsynced provider batch"
        );
        assert_eq!(executor.events.len(), 128);
        assert!(executor.acknowledgements.is_empty());
        let (result, lifecycle) =
            process_command(&mut state, &store, &config, &mut executor, &suspend).unwrap();
        persist_lifecycle_before_command_delivery(
            &mut state,
            &store,
            lifecycle.durable_state().unwrap(),
            &result,
        )
        .unwrap();
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(result.status, "completed");
        assert_eq!(reloaded.lifecycle, "suspended");
        assert!(reloaded.pending_terminal_delivery.is_some());
        assert_eq!(reloaded.acked_source_seq, 1);
        assert!(reloaded.outbox.is_empty());
        assert_eq!(
            executor.events.len(),
            128,
            "unadmitted provider tail remains with its durable owner"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn control_first_poll_keeps_cleanup_live_and_preserves_transport_failure() {
        struct ControlOnlyExecutor {
            maintenance_calls: usize,
        }
        impl CommandExecutor for ControlOnlyExecutor {
            fn execute(
                &mut self,
                _command: &Command,
            ) -> Result<CommandExecution, DurableRunnerError> {
                panic!("the poll gate cannot execute a control command")
            }
            fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
                panic!("control traffic cannot admit an ordinary provider tail")
            }
            fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
                self.maintenance_calls += 1;
                Ok(())
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-control-first-maintenance-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        store.save(&state).unwrap();
        let original = serde_json::to_value(&state).unwrap();
        let mut executor = ControlOnlyExecutor {
            maintenance_calls: 0,
        };
        for kind in ["ack", "ping", "command"] {
            let incoming = Ok(Some(json!({"kind":kind,"runId":"foreign-run"})));
            poll_executor_events_when_control_idle(
                &mut state,
                &store,
                &config,
                &mut executor,
                0,
                &incoming,
            )
            .unwrap();
            assert!(validate_control_identity(
                incoming.as_ref().unwrap().as_ref().unwrap(),
                &state,
                None
            )
            .is_err());
        }
        assert_eq!(executor.maintenance_calls, 3);
        let failed_read = Err(DurableRunnerError::invalid("original transport failure"));
        poll_executor_events_when_control_idle(
            &mut state,
            &store,
            &config,
            &mut executor,
            0,
            &failed_read,
        )
        .unwrap();
        assert!(failed_read
            .unwrap_err()
            .to_string()
            .contains("original transport failure"));
        assert_eq!(executor.maintenance_calls, 3);
        assert_eq!(serde_json::to_value(&state).unwrap(), original);
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert_eq!(serde_json::to_value(reloaded).unwrap(), original);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn idle_control_poll_admits_only_durable_provider_events_and_keeps_ack_debt_gate() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-control-idle-events-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let event = PolledEvent {
            executor_event_id: "retained-event".to_owned(),
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P1,
            payload: json!({"index":1}),
        };
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([event.clone()]),
            fail_acknowledgement: true,
            acknowledgements: Vec::new(),
        };
        let idle = Ok(None);
        let failure = poll_executor_events_when_control_idle(
            &mut state,
            &store,
            &config,
            &mut executor,
            0,
            &idle,
        )
        .unwrap_err();
        assert!(failure
            .to_string()
            .contains("simulated crash before provider acknowledgement"));
        let (mut recovered, _) = store.load_or_create(&config).unwrap();
        assert_eq!(recovered.outbox.len(), 1);
        assert_eq!(recovered.acked_source_seq, 0);
        assert_eq!(executor.events, VecDeque::from([event]));
        executor.fail_acknowledgement = false;
        poll_executor_events_when_control_idle(
            &mut recovered,
            &store,
            &config,
            &mut executor,
            1,
            &idle,
        )
        .unwrap();
        assert_eq!(
            executor.acknowledgements,
            vec![1],
            "controller ACK debt still defers provider replay"
        );
        recovered.apply_ack(1, 2).unwrap();
        store.save(&recovered).unwrap();
        poll_executor_events_when_control_idle(
            &mut recovered,
            &store,
            &config,
            &mut executor,
            1,
            &idle,
        )
        .unwrap();
        assert_eq!(executor.acknowledgements, vec![1, 1]);
        assert_eq!(
            recovered.highest_source_seq(),
            1,
            "replayed receipt must not allocate a duplicate source event"
        );
        assert!(executor.events.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn controller_ack_flow_control_preserves_replay_and_unsent_events() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-controller-ack-replay-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let event = PolledEvent {
            executor_event_id: "provider-replay-delta".to_owned(),
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P1,
            payload: json!({"index": 1}),
        };
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([event.clone()]),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };
        poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();
        // Reconnect resends the preserved outbox before admitting new provider
        // events. A provider ACK lost across the same crash replays exactly.
        let (mut recovered, _) = store.load_or_create(&config).unwrap();
        executor.events.push_back(event);
        poll_executor_events_after_controller_ack(
            &mut recovered,
            &store,
            &config,
            &mut executor,
            1,
        )
        .unwrap();
        assert_eq!(executor.events.len(), 1);
        recovered.apply_ack(1, 2).unwrap();
        store.save(&recovered).unwrap();
        poll_executor_events_after_controller_ack(
            &mut recovered,
            &store,
            &config,
            &mut executor,
            1,
        )
        .unwrap();
        assert_eq!(recovered.highest_source_seq(), 1);
        assert!(recovered.outbox.is_empty());
        assert_eq!(executor.acknowledgements, vec![1, 1]);
        // Command-generated, not-yet-sent output is not ACK debt. The normal
        // send_outbox call immediately following this helper delivers it.
        recovered
            .enqueue_event(&config, "run.attached", EventPriority::P0, json!({}))
            .unwrap();
        executor.events.push_back(PolledEvent {
            executor_event_id: "provider-next-delta".to_owned(),
            event_type: "item.delta".to_owned(),
            priority: EventPriority::P1,
            payload: json!({"index": 2}),
        });
        poll_executor_events_after_controller_ack(
            &mut recovered,
            &store,
            &config,
            &mut executor,
            1,
        )
        .unwrap();
        assert_eq!(recovered.highest_source_seq(), 3);
        assert_eq!(
            recovered
                .outbox
                .iter()
                .map(|event| event.source_seq)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(recovered.apply_ack(0, 2).is_err());
        assert!(recovered.apply_ack(4, 2).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn event_batch_acknowledges_only_bounded_durable_prefixes() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-bounded-event-prefix-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let mut config = config(directory.clone());
        config.max_outbox_bytes = 1024 * 1024;
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let mut executor = RetainingEventExecutor {
            events: (1..=131)
                .map(|index| PolledEvent {
                    executor_event_id: format!("provider-event-{index}"),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"index": index}),
                })
                .collect(),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };

        poll_executor_events(&mut state, &store, &config, &mut executor).unwrap();

        assert_eq!(executor.acknowledgements, vec![128, 3]);
        assert!(executor.events.is_empty());
        let (reloaded, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(reloaded.highest_source_seq(), 131);
        for index in 1..=131 {
            assert!(reloaded
                .has_executor_event_receipt(
                    &format!("provider-event-{index}"),
                    "provider.notice.recorded",
                    EventPriority::P1,
                    &json!({"index": index}),
                )
                .unwrap());
        }
        assert_eq!(reloaded.outbox.len(), 131);
        assert_eq!(
            reloaded
                .outbox
                .iter()
                .map(|event| event.source_seq)
                .collect::<Vec<_>>(),
            (1..=131).collect::<Vec<_>>()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn event_batch_never_acknowledges_a_failed_durable_save() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-event-save-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        let config = config(directory.clone());
        let store = DurableStateStore::new(&directory).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        // Force atomic replacement to fail without a production store hook.
        let original = directory.join("saved-runner-state.json");
        fs::rename(store.path(), &original).unwrap();
        fs::create_dir(store.path()).unwrap();
        let mut executor = RetainingEventExecutor {
            events: VecDeque::from([PolledEvent {
                executor_event_id: "provider-unsaved-event".to_owned(),
                event_type: "provider.notice.recorded".to_owned(),
                priority: EventPriority::P1,
                payload: json!({"message": "must remain with provider"}),
            }]),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("failed persistence cannot authorize a provider ACK");
        assert!(error
            .to_string()
            .contains("atomically replace durable state"));
        assert!(executor.acknowledgements.is_empty());
        assert_eq!(executor.events.len(), 1);
        fs::remove_dir(store.path()).unwrap();
        fs::rename(original, store.path()).unwrap();
        let (reloaded, _) = store.load_or_create(&config).unwrap();
        assert!(reloaded.outbox.is_empty());
        assert!(!reloaded
            .has_executor_event_receipt(
                "provider-unsaved-event",
                "provider.notice.recorded",
                EventPriority::P1,
                &json!({"message": "must remain with provider"}),
            )
            .unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn event_batch_preserves_original_error_when_prefix_ack_also_fails() {
        let directory = std::env::temp_dir().join(format!(
            "paperclip-runner-event-prefix-double-failure-{}",
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
                    executor_event_id: "provider-prefix".to_owned(),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "saved prefix"}),
                },
                PolledEvent {
                    executor_event_id: "provider-oversized-suffix".to_owned(),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "x".repeat(2048)}),
                },
            ]),
            fail_acknowledgement: true,
            acknowledgements: Vec::new(),
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("the rejected suffix remains the primary failure");
        assert!(error.to_string().contains("transport frame limit"));
        assert_eq!(executor.acknowledgements, vec![1]);
        assert_eq!(executor.events.len(), 2);
        let (mut recovered, _) = store.load_or_create(&config).unwrap();
        assert_eq!(recovered.outbox.len(), 1);
        executor.fail_acknowledgement = false;
        let error = poll_executor_events(&mut recovered, &store, &config, &mut executor)
            .expect_err("retry deduplicates only the durable prefix");
        assert!(error.to_string().contains("transport frame limit"));
        assert_eq!(executor.acknowledgements, vec![1, 1]);
        assert_eq!(executor.events.len(), 1);
        assert_eq!(recovered.highest_source_seq(), 1);
        assert_eq!(recovered.outbox.len(), 1);
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
                    payload: json!({"message": "second durable prefix event"}),
                },
                PolledEvent {
                    executor_event_id: "provider-event-3".to_owned(),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "x".repeat(2048)}),
                },
            ]),
            fail_acknowledgement: false,
            acknowledgements: Vec::new(),
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("the oversized suffix must fail closed");
        assert!(error.to_string().contains("transport frame limit"));
        assert_eq!(state.outbox.len(), 2);
        assert_eq!(executor.acknowledgements, vec![2]);
        assert_eq!(state.outbox[0].event_type, "provider.notice.recorded");
        assert_eq!(executor.events.len(), 1);
        assert_eq!(
            executor.events[0].payload["message"],
            Value::String("x".repeat(2048))
        );

        let (reloaded, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(reloaded.outbox.len(), 2);
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
            events: (1..=3)
                .map(|index| PolledEvent {
                    executor_event_id: format!("provider-event-before-ack-crash-{index}"),
                    event_type: "provider.notice.recorded".to_owned(),
                    priority: EventPriority::P1,
                    payload: json!({"message": "deliver exactly once"}),
                })
                .collect(),
            fail_acknowledgement: true,
            acknowledgements: Vec::new(),
        };

        let error = poll_executor_events(&mut state, &store, &config, &mut executor)
            .expect_err("simulate a crash after outbox persistence");
        assert!(error
            .to_string()
            .contains("before provider acknowledgement"));
        assert_eq!(state.outbox.len(), 3);
        assert_eq!(executor.acknowledgements, vec![3]);
        assert_eq!(executor.events.len(), 3);
        state
            .apply_ack(3, 2)
            .expect("controller ACK removes the durable outbox copy");
        store.save(&state).unwrap();

        let (mut recovered_state, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert!(recovered_state.outbox.is_empty());
        executor.fail_acknowledgement = false;
        executor.events[1].payload = json!({"message": "different data"});
        let mismatch = poll_executor_events(&mut recovered_state, &store, &config, &mut executor)
            .expect_err("a retained identity cannot name different event data");
        assert!(mismatch.to_string().contains("reused with different"));
        assert_eq!(executor.acknowledgements, vec![3, 1]);
        assert_eq!(executor.events.len(), 2);
        executor.events[0].payload = json!({"message": "deliver exactly once"});
        poll_executor_events(&mut recovered_state, &store, &config, &mut executor)
            .expect("recovery acknowledges the retained provider copy");
        assert!(executor.events.is_empty());
        assert!(recovered_state.outbox.is_empty());
        assert_eq!(executor.acknowledgements, vec![3, 1, 2]);
        assert_eq!(recovered_state.highest_source_seq(), 3);
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
