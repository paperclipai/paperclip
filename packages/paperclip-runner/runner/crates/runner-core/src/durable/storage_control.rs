//! Capacity recovery retains the synchronous command/effect stack, while the
//! authenticated control lane remains live. Deferred messages are bounded and
//! replayed in order only after the original storage operation is durable.
use super::runner::{apply_lease_renewal, control_envelope, lease_renewal_deadline};
use super::transport::{
    current_unix_ms, validate_control_identity, AuthenticatedTransport, ConnectionMetadata,
    LeaseCredential,
};
use super::{Command, DurableRunnerError, DurableState};
use serde_json::json;
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

pub(super) type Lane = (
    AuthenticatedTransport,
    ConnectionMetadata,
    Option<LeaseCredential>,
    u64,
);
pub(super) fn run<T>(
    lane: Lane,
    identity: DurableState,
    renew: bool,
    deadline: Option<Instant>,
    operation: impl FnOnce() -> Result<T, DurableRunnerError>,
) -> (Result<T, DurableRunnerError>, Lane) {
    let context = Rc::new(RefCell::new(Some(lane)));
    let callback_context = context.clone();
    let mut ack_cursor = identity.acked_source_seq;
    let mut disconnected = false;
    let result = crate::storage_capacity::with_wait(
        move || {
            let mut context = callback_context.borrow_mut();
            let (transport, connection, lease, next_renewal) =
                context.as_mut().expect("live pressure control lane");
            let now = current_unix_ms()?;
            if deadline.is_some_and(|deadline| Instant::now() >= deadline)
                || now >= connection.expires_at_unix_ms
            {
                return Err(DurableRunnerError::invalid(
                    "execution or authenticated lease expired during storage pressure",
                ));
            }
            let started = Instant::now();
            let polled = if disconnected {
                Ok(())
            } else {
                (|| {
                    if renew && now >= *next_renewal {
                        let credential = lease.as_mut().ok_or_else(|| {
                            DurableRunnerError::invalid("storage wait requires live lease")
                        })?;
                        credential.renewal_requested = true;
                        transport.send_json(&control_envelope(
                            &identity,
                            connection,
                            "lease_renew",
                            json!({
                                "connectionLeaseExpiresAtUnixMs": connection.expires_at_unix_ms,
                                "connectionLeaseRevocationEpoch": connection.revocation_epoch,
                            }),
                        ))?;
                        *next_renewal = now.saturating_add(
                            5_000.min(
                                connection
                                    .expires_at_unix_ms
                                    .saturating_sub(now)
                                    .saturating_div(2)
                                    .max(1),
                            ),
                        );
                    }
                    if let Some(message) = transport.receive_control_during_storage_wait()? {
                        validate_control_identity(&message, &identity, Some(connection))?;
                        match message.get("kind").and_then(serde_json::Value::as_str) {
                Some("lease_renewed") => {
                    apply_lease_renewal(&message, connection, lease.as_mut().ok_or_else(|| DurableRunnerError::invalid("lease renewal requires live credential"))?)?;
                    *next_renewal = lease_renewal_deadline(current_unix_ms()?, connection.expires_at_unix_ms);
                }
                Some("ping") => transport.send_json(&control_envelope(&identity, connection, "pong", json!({
                    "lifecycle": identity.lifecycle, "ackedSourceSeq": identity.acked_source_seq,
                    "storagePressure": true,
                })))?,
                Some("revoke") => {
                    if message.pointer("/payload/revocationEpoch").and_then(serde_json::Value::as_u64).is_none_or(|epoch| epoch <= connection.revocation_epoch) {
                        return Err(DurableRunnerError::invalid("invalid revocation during storage pressure"));
                    }
                    return Err(DurableRunnerError::invalid("authenticated capability revoked during storage pressure"));
                }
                Some("command") => {
                    let command: Command = serde_json::from_value(message.get("payload").cloned().unwrap_or_default()).map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
                    command.validate()?;
                    if fresh_stop(&command, identity.controller_epoch.as_deref(), identity.last_controller_command_seq) {
                        // This is an authenticated request to stop, not evidence
                        // that the command committed. Unwind to physical owned
                        // cleanup; never send a successful terminal receipt.
                        return Err(DurableRunnerError::invalid("authenticated stop requested during storage pressure"));
                    }
                    transport.defer_control(message)?;
                }
                Some("command_epoch_rotate") => {
                    // Rotation is durable work. Keep it behind the current
                    // storage operation; the normal loop validates capability
                    // and the exact current namespace before committing it.
                    let transition: super::command_epochs::CommandEpochTransition = serde_json::from_value(message.get("payload").cloned().unwrap_or_default()).map_err(|e| DurableRunnerError::invalid(e.to_string()))?;
                    transition.validate(&identity.run_id)?;
                    transport.defer_control(message)?;
                }
                Some("event_epoch_committed") => {
                    let transition: super::event_epochs::EventEpochTransition = serde_json::from_value(message.get("payload").cloned().unwrap_or_default()).map_err(|e| DurableRunnerError::invalid(e.to_string()))?;
                    transition.validate(&identity.run_id)?;
                    transport.defer_control(message)?;
                }
                Some("ack") => {
                    if !identity.ack_is_current(message.get("payload").unwrap_or(&serde_json::Value::Null))? { return Ok(()); }
                    let acked = message.pointer("/payload/ackedSourceSeq").and_then(serde_json::Value::as_u64).ok_or_else(|| DurableRunnerError::invalid("ACK cursor is required"))?;
                    if acked < ack_cursor || acked > identity.highest_source_seq() {
                        return Err(DurableRunnerError::invalid("cumulative ACK is outside the durable pressure snapshot"));
                    }
                    ack_cursor = acked;
                    transport.defer_control(message)?;
                }
                _ => return Err(DurableRunnerError::invalid("unexpected control during storage pressure")),
            }
                    }
                    Ok(())
                })()
            };
            match polled {
                // Keep the exact write/effect stack while its existing lease is
                // valid. After capacity returns, the ordinary runner loop
                // reconnects and replays its durable result. A lost socket does
                // not renew authority, suppress revocation, or admit new work.
                Err(error) if error.is_transport_unavailable() => disconnected = true,
                Err(error) => return Err(error),
                Ok(()) => {}
            }
            // Busy ping/ACK traffic cannot turn failed writes into a spin loop.
            std::thread::sleep(Duration::from_millis(25).saturating_sub(started.elapsed()));
            Ok(())
        },
        operation,
    );
    let lane = context
        .borrow_mut()
        .take()
        .expect("pressure control lane restored");
    (result, lane)
}

pub(super) fn fresh_stop(command: &Command, epoch: Option<&str>, ordinal: u64) -> bool {
    command.controller_epoch.as_deref() == epoch
        && command.controller_seq > ordinal
        && matches!(
            command.command_type.as_str(),
            "turn.stop"
                | "turn.interrupt"
                | "run.cancel"
                | "session.close"
                | "session.destroy"
                | "runner.shutdown"
                | "runner.suspend"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn storage_pressure_stop_cannot_cross_a_command_epoch() {
        let epoch = uuid::Uuid::new_v4().to_string();
        for kind in [
            "turn.stop",
            "turn.interrupt",
            "run.cancel",
            "session.close",
            "session.destroy",
            "runner.shutdown",
            "runner.suspend",
        ] {
            let mut command: Command = serde_json::from_value(json!({"schema":"paperclip.prp.command.v1", "commandId":"old-stop", "controllerSeq":9007199254740990_u64, "type":kind, "issuedAt":"2026-09-29T00:00:00Z", "payload":{}})).unwrap();
            assert!(!fresh_stop(&command, Some(&epoch), 1));
            command.controller_epoch = Some(epoch.clone());
            command.controller_seq = 2;
            assert!(fresh_stop(&command, Some(&epoch), 1));
            assert!(!fresh_stop(&command, Some(&epoch), 2));
            command.controller_epoch = Some(uuid::Uuid::new_v4().to_string());
            assert!(!fresh_stop(&command, Some(&epoch), 1));
        }
    }
}
