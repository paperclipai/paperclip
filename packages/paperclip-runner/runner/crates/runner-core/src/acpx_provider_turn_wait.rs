use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{AcpxCommandExecutor, AcpxDurableState};
use crate::durable::{CommandExecution, DurableRunnerError, EventPriority};
use crate::provider_events::NormalizedProviderEvent;
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AcpxProviderTurnWait {
    pub(super) turn_id: String,
    pub(super) held_run_terminal: Value,
}

impl AcpxProviderTurnWait {
    pub(super) fn is_consistent(&self, state: &AcpxDurableState) -> bool {
        is_stable_id(&self.turn_id, DURABLE_STABLE_ID_CHARS)
            && self.held_run_terminal.is_object()
            && state.lifecycle == "session_open"
            && state.active_turn_id.is_none()
            && state.identity.is_some()
    }

    pub(super) fn into_run_terminal(self) -> NormalizedProviderEvent {
        run_terminal_event(self.held_run_terminal)
    }
}

fn run_terminal_event(payload: Value) -> NormalizedProviderEvent {
    NormalizedProviderEvent {
        event_type: "run.terminal".to_owned(),
        priority: EventPriority::P0,
        payload,
    }
}

impl AcpxDurableState {
    pub(super) fn leave_finished_provider_turn_wait(&mut self) -> Result<(), DurableRunnerError> {
        if self
            .provider_turn_wait
            .as_ref()
            .is_none_or(|wait| wait.is_consistent(self))
        {
            return Ok(());
        }
        let wait = self
            .provider_turn_wait
            .take()
            .expect("checked provider turn wait");
        if matches!(self.lifecycle.as_str(), "turn_starting" | "turn_active") {
            return Ok(());
        }
        self.push(wait.into_run_terminal())
    }
}

impl AcpxCommandExecutor {
    pub(super) fn awaiting_provider_turn(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|state| state.provider_turn_wait.is_some())
    }

    pub(super) fn settle_turn_events(
        &mut self,
        events: Vec<NormalizedProviderEvent>,
        turn_ended: bool,
        run_terminal: Option<Value>,
    ) -> Result<(), DurableRunnerError> {
        let offer = turn_ended
            .then(|| {
                self.session
                    .as_mut()
                    .and_then(|session| session.take_provider_turn_offer())
            })
            .flatten();
        let wait = match (offer, run_terminal) {
            (Some(turn_id), Some(held_run_terminal))
                if self.turn_accepts_provider_turns
                    && self
                        .session
                        .as_mut()
                        .is_some_and(|session| session.arm_provider_turn(&turn_id)) =>
            {
                Ok(AcpxProviderTurnWait {
                    turn_id,
                    held_run_terminal,
                })
            }
            (_, run_terminal) => Err(run_terminal),
        };
        let state = self
            .state
            .as_mut()
            .expect("ACPX state remains available while polling");
        for mut event in events {
            if wait.is_ok() && event.event_type == "turn.completed" {
                event.payload["awaitingProviderTurn"] = json!(true);
            }
            state.push(event)?;
        }
        match wait {
            Ok(wait) => state.provider_turn_wait = Some(wait),
            Err(Some(payload)) => state.push(run_terminal_event(payload))?,
            Err(None) => {}
        }
        Ok(())
    }

    pub(super) fn end_provider_turn_wait(
        &mut self,
        publish: bool,
    ) -> Result<(), DurableRunnerError> {
        let Some(wait) = self
            .state
            .as_mut()
            .and_then(|state| state.provider_turn_wait.take())
        else {
            return Ok(());
        };
        if let Some(session) = self.session.as_mut() {
            session.disarm_provider_turn(&wait.turn_id);
        }
        if publish {
            self.state
                .as_mut()
                .expect("ACPX state exists with a provider turn wait")
                .push(wait.into_run_terminal())?;
        }
        Ok(())
    }

    pub(super) fn settled_without_turn(
        &mut self,
        reason: &str,
    ) -> Result<CommandExecution, DurableRunnerError> {
        if self.awaiting_provider_turn() {
            self.end_provider_turn_wait(true)?;
            self.save_state()?;
        }
        Ok(CommandExecution {
            result: json!({"status": "already_settled", "reason": reason}),
            events: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::tests::descriptor;
    use super::super::AcpxDurableState;
    use super::AcpxProviderTurnWait;
    use crate::provider_bridge::{authorized_tool_catalog_digest, AuthorizedToolSet};

    fn state() -> AcpxDurableState {
        let operations = Vec::new();
        AcpxDurableState::new(
            serde_json::from_value(descriptor("claude")).unwrap(),
            AuthorizedToolSet {
                schema: "paperclip.runner.authorized-tools.v1".into(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
                operations,
            },
            "test".into(),
        )
    }

    fn wait() -> AcpxProviderTurnWait {
        AcpxProviderTurnWait {
            turn_id: "turn-1".into(),
            held_run_terminal: json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"completed"}),
        }
    }

    #[test]
    fn state_outside_a_wait_keeps_the_previous_release_shape_in_both_directions() {
        let saved = serde_json::to_value(state()).unwrap();
        assert!(saved.get("providerTurnWait").is_none());
        let resumed: AcpxDurableState = serde_json::from_value(saved).unwrap();
        assert_eq!(resumed.provider_turn_wait, None);
    }

    #[test]
    fn a_wait_round_trips_and_an_unknown_field_is_refused_like_a_previous_release_refuses_it() {
        let mut waiting = state();
        waiting.provider_turn_wait = Some(wait());
        let saved = serde_json::to_value(&waiting).unwrap();
        assert_eq!(saved["providerTurnWait"]["turnId"], json!("turn-1"));
        let resumed: AcpxDurableState = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(resumed.provider_turn_wait, Some(wait()));
        let mut future = saved;
        future["providerTurnWaitFromAFutureRelease"] = json!({});
        let refused = serde_json::from_value::<AcpxDurableState>(future).unwrap_err();
        assert!(refused.to_string().contains("unknown field"), "{refused}");
    }

    #[test]
    fn leaving_the_open_idle_session_ends_the_wait_by_the_next_lifecycle() {
        for (lifecycle, active, published) in [
            ("closed", None, true),
            ("suspended", None, true),
            ("prepared", None, true),
            ("turn_starting", Some("turn-2"), false),
            ("turn_active", Some("provider-1"), false),
        ] {
            let mut left = state();
            left.provider_turn_wait = Some(wait());
            left.lifecycle = lifecycle.into();
            left.active_turn_id = active.map(str::to_owned);
            left.leave_finished_provider_turn_wait().unwrap();
            assert_eq!(left.provider_turn_wait, None, "{lifecycle}");
            let terminals = left
                .pending_events
                .iter()
                .filter(|event| event.event_type == "run.terminal")
                .count();
            assert_eq!(terminals, usize::from(published), "{lifecycle}");
        }
    }
}
