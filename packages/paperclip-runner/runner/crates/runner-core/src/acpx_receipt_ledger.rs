//! Bounded ACPX current state, durable delivery intent and exact tool receipts.
//! The session publishes candidates only after the receipt transaction commits.
use crate::indexed_revision::Revision;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::acpx_provider_session::{AcpxProviderSessionConfig, AcpxProviderSessionIdentity};
use crate::acpx_provider_state::{AcpxProviderState, AcpxProviderStateEvent};
use crate::indexed_store::{ExactReceipt, IndexedStore};
use crate::local_runner::LocalRunnerError;
use crate::provider_bridge::{ProviderToolBridge, ToolResult};

const SCHEMA: &str = "paperclip.runner.acpx-receipts.v1";
const STATE_KEY: &str = "acpx-session";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    schema: String,
    run_id: String,
    identity: AcpxProviderSessionIdentity,
    state: AcpxProviderState,
    dynamic: ProviderToolBridge,
    reserved: ProviderToolBridge,
    events: Vec<AcpxProviderStateEvent>,
    delivery: Option<ToolResult>,
}

pub(crate) struct AcpxReceiptLedger {
    store: IndexedStore,
    generation: Revision,
    run_id: String,
    previous: Option<Checkpoint>,
}

fn invalid(error: impl std::fmt::Display) -> LocalRunnerError {
    LocalRunnerError::invalid(format!("ACPX receipt storage: {error}"))
}

impl AcpxReceiptLedger {
    /// Called before spawning. An interrupted active lifetime must pass the
    /// executor's recovery admission; opening receipts cannot grant it a new
    /// provider process or silently discard unfinished delivery.
    pub(crate) fn open(
        path: &Path,
        config: &AcpxProviderSessionConfig,
    ) -> Result<Self, LocalRunnerError> {
        let binding = format!("acpx/{}", config.normalized_session_id);
        let store = IndexedStore::open(path, &binding, config.expected_identity.is_none())
            .map_err(invalid)?;
        let current = store.read_state(STATE_KEY).map_err(invalid)?;
        if current.is_none() && config.expected_identity.is_some() {
            return Err(invalid("retained current receipt authority is missing"));
        }
        let previous: Option<Checkpoint> = current
            .as_ref()
            .map(|value| serde_json::from_slice(&value.bytes).map_err(invalid))
            .transpose()?;
        if let Some(previous) = &previous {
            if previous.schema != SCHEMA
                || previous.identity.normalized_session_id != config.normalized_session_id
                || previous.state.run_id() != previous.run_id
                || previous.state.active_turn_id().is_some()
                || previous.state.has_pending_requests()
                || previous.dynamic.pending_calls().next().is_some()
                || previous.reserved.pending_calls().next().is_some()
                || !previous.events.is_empty()
                || previous.delivery.is_some()
            {
                return Err(invalid(
                    "prior session requires reconciliation before restart",
                ));
            }
            if config.expected_identity.as_ref() != Some(&previous.identity) {
                return Err(invalid("retained session identity was not admitted"));
            }
        }
        Ok(Self {
            store,
            generation: current.map_or(Revision::Absent, |value| value.generation),
            run_id: config.run_id.clone(),
            previous,
        })
    }

    pub(crate) fn validate_turn(&self, turn_id: &str) -> Result<(), LocalRunnerError> {
        if self
            .store
            .receipt(&format!("acpx-turns/{}", self.run_id), turn_id)
            .map_err(invalid)?
            .is_some()
        {
            return Err(invalid("reused a settled turn identity"));
        }
        Ok(())
    }

    pub(crate) fn bind(
        &self,
        turn_id: &str,
        dynamic: &mut ProviderToolBridge,
        reserved: &mut ProviderToolBridge,
    ) -> Result<(), LocalRunnerError> {
        let namespace = format!("acpx/{}/{turn_id}", self.run_id);
        dynamic
            .bind_indexed_receipts(self.store.clone(), format!("{namespace}/dynamic"))
            .map_err(invalid)?;
        reserved
            .bind_indexed_receipts(self.store.clone(), format!("{namespace}/reserved"))
            .map_err(invalid)
    }

    pub(crate) fn events(&self) -> Option<&[AcpxProviderStateEvent]> {
        self.previous
            .as_ref()
            .filter(|value| !value.events.is_empty())
            .map(|value| value.events.as_slice())
    }

    pub(crate) fn pending_batch(&self) -> Option<String> {
        self.events().map(|_| self.generation.to_string())
    }

    pub(crate) fn acknowledge(&mut self) -> Result<(), LocalRunnerError> {
        let Some(mut next) = self.previous.clone() else {
            return Ok(());
        };
        if next.events.is_empty() {
            return Ok(());
        }
        next.events.clear();
        self.commit(next, vec![])
    }

    pub(crate) fn checkpoint(
        &mut self,
        identity: &AcpxProviderSessionIdentity,
        state: &AcpxProviderState,
        dynamic: &mut ProviderToolBridge,
        reserved: &mut ProviderToolBridge,
        events: Vec<AcpxProviderStateEvent>,
        delivery: Option<ToolResult>,
    ) -> Result<(), LocalRunnerError> {
        if self.events().is_some() {
            return Err(invalid(
                "previous event batch has not been durably acknowledged",
            ));
        }
        let mut receipts = dynamic.checkpoint_indexed_receipts().map_err(invalid)?;
        receipts.extend(reserved.checkpoint_indexed_receipts().map_err(invalid)?);
        if let Some(previous) = &self.previous {
            if let Some(turn) = previous
                .state
                .active_turn_id()
                .filter(|_| state.active_turn_id().is_none())
            {
                receipts.push(ExactReceipt {
                    namespace: format!("acpx-turns/{}", previous.run_id),
                    key: turn.to_owned(),
                    bytes: b"settled".to_vec(),
                });
            }
        }
        let next = Checkpoint {
            schema: SCHEMA.to_owned(),
            run_id: self.run_id.clone(),
            identity: identity.clone(),
            state: state.clone(),
            dynamic: dynamic.clone(),
            reserved: reserved.clone(),
            events,
            delivery,
        };
        self.commit(next, receipts)
    }

    fn commit(
        &mut self,
        next: Checkpoint,
        receipts: Vec<ExactReceipt>,
    ) -> Result<(), LocalRunnerError> {
        let bytes = serde_json::to_vec(&next).map_err(invalid)?;
        self.generation = match self
            .store
            .commit(STATE_KEY, self.generation, bytes, receipts)
        {
            Ok(generation) => generation,
            Err(error) => {
                // A response can be lost after durable commit. This writer may
                // neither retry with a stale candidate nor release a result.
                self.generation = Revision::Fenced;
                return Err(invalid(error));
            }
        };
        self.previous = Some(next);
        Ok(())
    }
}
