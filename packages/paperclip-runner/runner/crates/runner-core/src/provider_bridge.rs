use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const TOOL_SET_SCHEMA: &str = "paperclip.runner.authorized-tools.v1";
pub const TOOL_CALL_SCHEMA: &str = "paperclip.prp.semantic_tool.v1";
pub const TOOL_RESULT_COMMAND: &str = "semantic_tool.result";
const MAX_AUTHORIZED_TOOLS: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;
const MAX_SCHEMA_BYTES: usize = 512 * 1024;
// Leave room for the authenticated PRP command or event envelope inside the
// default 1 MiB transport frame.
const MAX_TOOL_SET_BYTES: usize = 768 * 1024;
const MAX_TOOL_VALUE_BYTES: usize = 768 * 1024;
const MAX_ACCEPTED_TOOL_VALUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETAINED_TOOL_VALUE_BYTES: usize = 8 * 1024 * 1024;
// Exact settled receipts are authoritative for the durable run. Bound their
// complete encoded representation independently of the raw-value budget so a
// long sequence of tiny results cannot accumulate unbounded identity and JSON
// envelope overhead.
const MAX_SETTLED_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_PENDING_CALLS: usize = 4_096;
// Active-turn inputs and results are separately bounded. Settled identities
// remain exact for a complete provider-process epoch so a delayed request
// cannot replay an old call ID after crossing a turn boundary. At the bound,
// the backend must reap the idle process before it rotates this ledger.
const MAX_DURABLE_CALL_RECEIPTS: usize = 4_096;
const MAX_SETTLED_CALL_IDS: usize = 65_536;
// Retain the legacy serialized filter shape for recovery compatibility. New
// state never inserts probabilistic identities. A recovered non-empty filter
// makes the durable run fail closed until attach_run because its identities
// cannot safely be distinguished from fresh calls.
const REPLAY_FILTER_WORDS: usize = 32_768;
const ACTIVE_TURN_RECEIPT_LIMIT_MESSAGE: &str =
    "durable provider tool receipt limit reached for the active turn";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedTool {
    pub operation_id: String,
    pub version: u64,
    pub description: String,
    pub input_schema: Value,
    pub response_schema: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedToolSet {
    pub schema: String,
    pub schema_version: u64,
    pub catalog_digest: String,
    pub operations: Vec<AuthorizedTool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCall {
    pub call_id: String,
    pub operation_id: String,
    pub input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub call_id: String,
    pub operation_id: String,
    pub result: Value,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CompletedToolCall {
    call: PendingToolCall,
    result: ToolResult,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct SettledCallIds {
    order: VecDeque<String>,
    members: BTreeSet<String>,
}

// Preserve the existing on-disk array shape so durable state written before
// this bounded ordering was introduced remains readable. New state records IDs
// from oldest to newest, which makes pruning deterministic across recovery.
impl Serialize for SettledCallIds {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.order.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SettledCallIds {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let values = VecDeque::<String>::deserialize(deserializer)?;
        let mut settled = Self::default();
        for value in values {
            if settled.members.insert(value.clone()) {
                settled.order.push_back(value);
            }
        }
        Ok(settled)
    }
}

impl SettledCallIds {
    fn clear(&mut self) {
        self.order.clear();
        self.members.clear();
    }

    fn contains(&self, call_id: &str) -> bool {
        self.members.contains(call_id)
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    fn len(&self) -> usize {
        self.order.len()
    }

    fn iter(&self) -> impl Iterator<Item = &String> {
        self.order.iter()
    }

    fn extend_recent(
        &mut self,
        call_ids: impl IntoIterator<Item = String>,
        limit: usize,
    ) -> Vec<String> {
        for call_id in call_ids {
            if self.members.insert(call_id.clone()) {
                self.order.push_back(call_id);
            }
        }
        let mut evicted = Vec::new();
        while self.order.len() > limit {
            if let Some(call_id) = self.order.pop_front() {
                self.members.remove(&call_id);
                evicted.push(call_id);
            }
        }
        evicted
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct DurableReplayFilter {
    words: Vec<u64>,
}

impl DurableReplayFilter {
    pub(crate) fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    pub(crate) fn validate(&self) -> Result<(), ProviderBridgeError> {
        if self.words.is_empty() || self.words.len() == REPLAY_FILTER_WORDS {
            Ok(())
        } else {
            Err(ProviderBridgeError::invalid(
                "durable replay filter has an invalid size",
            ))
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToolBridge {
    authorized: BTreeMap<String, AuthorizedTool>,
    #[serde(default)]
    catalog_operations: Vec<AuthorizedTool>,
    catalog_digest: Option<String>,
    pending: BTreeMap<String, PendingToolCall>,
    #[serde(deserialize_with = "deserialize_retained_results")]
    completed: BTreeMap<String, CompletedToolCall>,
    // Keep authoritative result bodies through the provider's replay window;
    // prepare_turn releases them after settlement.
    #[serde(default, deserialize_with = "deserialize_retained_results")]
    settled_results: BTreeMap<String, CompletedToolCall>,
    // Derived from completed + settled results. It is intentionally omitted
    // from durable JSON and recomputed by attach_existing_run so old state and
    // tampered counters cannot bypass the byte envelope.
    #[serde(skip)]
    retained_result_bytes: usize,
    // Exact replay tombstones span every provider turn in the durable run.
    #[serde(default)]
    settled_call_ids: SettledCallIds,
    #[serde(default)]
    settled_call_filter: DurableReplayFilter,
    // Resource exhaustion stops the active turn. prepare_turn releases bulky
    // result payloads and recomputes this marker, but replay ambiguity remains
    // fail-closed until attach_run or a verified idle provider-process restart
    // establishes fresh replay authority.
    #[serde(
        default,
        alias = "settledHistoryResetPending",
        skip_serializing_if = "is_false"
    )]
    durable_run_receipt_limit_reached: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderBridgeError(String);

impl ProviderBridgeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    fn active_turn_receipt_limit() -> Self {
        Self::invalid(ACTIVE_TURN_RECEIPT_LIMIT_MESSAGE)
    }

    pub fn is_active_turn_receipt_limit(&self) -> bool {
        self.0 == ACTIVE_TURN_RECEIPT_LIMIT_MESSAGE
    }
}

impl Display for ProviderBridgeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ProviderBridgeError {}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ProviderToolBridge {
    pub fn prepare(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        self.prepare_internal(tool_set, false)
    }

    pub fn attach_run(&mut self, tool_set: AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot attach a new run while provider tool calls are pending",
            ));
        }
        self.prepare_internal(tool_set, true)?;
        self.completed.clear();
        self.settled_results.clear();
        self.retained_result_bytes = 0;
        self.settled_call_ids.clear();
        self.settled_call_filter = DurableReplayFilter::default();
        self.durable_run_receipt_limit_reached = false;
        Ok(())
    }

    pub fn attach_existing_run(&mut self) -> Result<(), ProviderBridgeError> {
        // Pending calls are durable run state. Re-attaching the same run must
        // preserve them so an interrupted dispatcher can resume or replay the
        // authoritative result. `attach_run` remains the boundary that rejects
        // carrying pending calls into a different run.
        self.validate_recovered()?;
        self.retained_result_bytes =
            retained_result_bytes(self.settled_results.iter().chain(self.completed.iter()))?;
        Ok(())
    }

    fn prepare_internal(
        &mut self,
        tool_set: AuthorizedToolSet,
        allow_catalog_change: bool,
    ) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot change authorized tools while provider calls are pending",
            ));
        }
        validate_authorized_tool_set(&tool_set)?;
        if !allow_catalog_change {
            if let Some(existing) = &self.catalog_digest {
                if existing != &tool_set.catalog_digest {
                    return Err(ProviderBridgeError::invalid(
                        "authorized tool set changed across a durable session",
                    ));
                }
            }
        }
        self.catalog_digest = Some(tool_set.catalog_digest);
        self.catalog_operations = tool_set.operations.clone();
        self.authorized = tool_set
            .operations
            .into_iter()
            .map(|tool| (tool.operation_id.clone(), tool))
            .collect();
        Ok(())
    }

    pub fn authorized_tools(&self) -> impl Iterator<Item = &AuthorizedTool> {
        self.catalog_operations.iter()
    }

    pub fn validate_recovered(&self) -> Result<(), ProviderBridgeError> {
        let Some(catalog_digest) = self.catalog_digest.clone() else {
            return if self.authorized.is_empty()
                && self.catalog_operations.is_empty()
                && self.pending.is_empty()
                && self.completed.is_empty()
                && self.settled_results.is_empty()
                && self.settled_call_ids.is_empty()
                && self.settled_call_filter.is_empty()
                && !self.durable_run_receipt_limit_reached
            {
                Ok(())
            } else {
                Err(ProviderBridgeError::invalid(
                    "recovered provider tool bridge omitted its catalog identity",
                ))
            };
        };
        let mut expected = ProviderToolBridge::default();
        expected.prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest,
            operations: self.catalog_operations.clone(),
        })?;
        if self.authorized != expected.authorized {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge changed its authorized catalog",
            ));
        }
        let retained_receipts = self.pending.len().saturating_add(self.completed.len());
        if self.pending.len() > MAX_PENDING_CALLS || retained_receipts > MAX_DURABLE_CALL_RECEIPTS {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge exceeds its call limit",
            ));
        }
        self.validate_retained_value_bytes()?;
        self.settled_call_filter.validate()?;
        if self.settled_call_ids.len() > MAX_SETTLED_CALL_IDS {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge exceeds its settled call identity limit",
            ));
        }
        if !self.settled_identity_capacity_allows(0) {
            return Err(ProviderBridgeError::invalid(
                "recovered provider tool bridge cannot settle its active call identities",
            ));
        }
        for call_id in self.settled_call_ids.iter() {
            validate_stable_id(call_id, "settled tool call id")?;
            if self.pending.contains_key(call_id) || self.completed.contains_key(call_id) {
                return Err(ProviderBridgeError::invalid(
                    "recovered settled provider tool call identity is inconsistent",
                ));
            }
        }
        let mut pending_validator = expected.clone();
        for (call_id, call) in &self.pending {
            if call_id != &call.call_id
                || self.completed.contains_key(call_id)
                || self.settled_results.contains_key(call_id)
                || self.has_settled_call_id(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered provider tool call identity is inconsistent",
                ));
            }
            pending_validator.begin_call(
                call.call_id.clone(),
                call.operation_id.clone(),
                call.input.clone(),
            )?;
        }
        for (call_id, completed) in &self.completed {
            if call_id != &completed.call.call_id
                || call_id != &completed.result.call_id
                || completed.call.operation_id != completed.result.operation_id
                || self.settled_results.contains_key(call_id)
                || self.has_settled_call_id(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered completed tool call identity is inconsistent",
                ));
            }
            let mut completed_validator = expected.clone();
            completed_validator.begin_call(
                completed.call.call_id.clone(),
                completed.call.operation_id.clone(),
                completed.call.input.clone(),
            )?;
            completed_validator.apply_result(completed.result.clone())?;
        }
        for (call_id, settled) in &self.settled_results {
            if call_id != &settled.call.call_id
                || call_id != &settled.result.call_id
                || settled.call.operation_id != settled.result.operation_id
                || !self.settled_call_ids.contains(call_id)
                || self.pending.contains_key(call_id)
                || self.completed.contains_key(call_id)
            {
                return Err(ProviderBridgeError::invalid(
                    "recovered settled tool result identity is inconsistent",
                ));
            }
            let mut settled_validator = expected.clone();
            settled_validator.begin_call(
                settled.call.call_id.clone(),
                settled.call.operation_id.clone(),
                settled.call.input.clone(),
            )?;
            settled_validator.apply_result(settled.result.clone())?;
        }
        let retained_bytes =
            retained_result_bytes(self.settled_results.iter().chain(self.completed.iter()))?;
        ensure_settled_result_capacity(retained_bytes, self.pending.values()).map_err(|_| {
            ProviderBridgeError::invalid(
                "recovered provider tool results exceed the durable byte limit",
            )
        })?;
        Ok(())
    }

    pub fn verify_tool_set(&self, tool_set: &AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
        let mut expected = ProviderToolBridge::default();
        expected.prepare(tool_set.clone())?;
        if self.catalog_digest != expected.catalog_digest
            || self.catalog_operations != expected.catalog_operations
            || self.authorized != expected.authorized
        {
            return Err(ProviderBridgeError::invalid(
                "authorized tool set changed across a durable session",
            ));
        }
        Ok(())
    }

    pub fn has_catalog(&self) -> bool {
        self.catalog_digest.is_some()
    }

    pub fn durable_run_receipt_limit_reached(&self) -> bool {
        self.durable_run_receipt_limit_reached
    }

    fn has_settled_call_id(&self, call_id: &str) -> bool {
        self.settled_call_ids.contains(call_id)
    }

    pub(crate) fn replay_history_blocks_admission(&self) -> bool {
        self.settled_call_ids.len() >= MAX_SETTLED_CALL_IDS || !self.settled_call_filter.is_empty()
    }

    pub(crate) fn has_active_receipts(&self) -> bool {
        !self.pending.is_empty() || !self.completed.is_empty()
    }

    /// Forget an exact replay epoch only after its provider process has been
    /// reaped and an idle replacement generation has been established. The
    /// process boundary is what prevents an old provider request from being
    /// admitted after its tombstone is released; callers must not use this as
    /// ordinary capacity eviction.
    pub(crate) fn rollover_replay_epoch_after_provider_restart(
        &mut self,
    ) -> Result<(), ProviderBridgeError> {
        if !self.replay_history_blocks_admission() {
            return Err(ProviderBridgeError::invalid(
                "cannot rotate provider tool replay authority before its exact capacity boundary",
            ));
        }
        if !self.pending.is_empty()
            || !self.completed.is_empty()
            || !self.settled_results.is_empty()
            || self.retained_result_bytes != 0
        {
            return Err(ProviderBridgeError::invalid(
                "cannot rotate provider tool replay authority while receipts are retained",
            ));
        }
        self.settled_call_ids.clear();
        self.settled_call_filter = DurableReplayFilter::default();
        self.durable_run_receipt_limit_reached = false;
        Ok(())
    }

    fn settled_identity_capacity_allows(&self, additional_calls: usize) -> bool {
        self.settled_call_ids
            .len()
            .checked_add(self.total_call_receipts())
            .and_then(|total| total.checked_add(additional_calls))
            .is_some_and(|total| total <= MAX_SETTLED_CALL_IDS)
    }

    pub fn prepare_turn(&mut self) -> Result<(), ProviderBridgeError> {
        if !self.pending.is_empty() || !self.completed.is_empty() {
            return Err(ProviderBridgeError::invalid(
                "cannot prepare the next provider turn while tool calls are active",
            ));
        }
        // The authoritative result bodies are needed only while the provider
        // can replay the just-settled turn. Release that bulky data at the
        // verified turn boundary, but retain every call-ID tombstone and any
        // recovered legacy filter until the owning provider process is reaped.
        self.settled_results.clear();
        self.retained_result_bytes = 0;
        self.durable_run_receipt_limit_reached = self.replay_history_blocks_admission();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn retained_result_bytes_for_test(&self) -> usize {
        self.retained_result_bytes
    }

    pub fn replay_result(
        &self,
        call_id: &str,
        operation_id: &str,
        input: &Value,
    ) -> Result<Option<ToolResult>, ProviderBridgeError> {
        if let Some(completed) = self
            .completed
            .get(call_id)
            .or_else(|| self.settled_results.get(call_id))
        {
            if completed.call.operation_id != operation_id || &completed.call.input != input {
                return Err(ProviderBridgeError::invalid(
                    "provider replayed a completed tool call with different input",
                ));
            }
            return Ok(Some(completed.result.clone()));
        }
        Ok(None)
    }

    pub fn has_completed_call(&self, call_id: &str) -> bool {
        self.completed.contains_key(call_id) || self.has_settled_call_id(call_id)
    }

    pub fn begin_call(
        &mut self,
        call_id: String,
        operation_id: String,
        input: Value,
    ) -> Result<PendingToolCall, ProviderBridgeError> {
        validate_stable_id(&call_id, "tool call id")?;
        validate_operation_id(&operation_id)?;
        let authorized = self.authorized.get(&operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid(format!(
                "provider requested unauthorized tool {operation_id}"
            ))
        })?;
        let validator = jsonschema::validator_for(&authorized.input_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {operation_id} has an invalid durable input JSON Schema"
            ))
        })?;
        if !validator.is_valid(&input) {
            return Err(ProviderBridgeError::invalid(format!(
                "provider arguments for {operation_id} failed JSON Schema validation"
            )));
        }
        bounded_json(&input, MAX_TOOL_VALUE_BYTES, "provider tool input")?;
        let call = PendingToolCall {
            call_id: call_id.clone(),
            operation_id,
            input,
        };
        validate_pending_tool_call(&self.authorized, &call)?;
        if let Some(existing) = self.pending.get(&call_id) {
            return if existing == &call {
                Ok(existing.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate provider tool call",
                ))
            };
        }
        if self.completed.contains_key(&call_id)
            || self.settled_results.contains_key(&call_id)
            || self.has_settled_call_id(&call_id)
        {
            return Err(ProviderBridgeError::invalid(
                "provider reused a completed tool call id",
            ));
        }
        // A durable receipt ledger may be exactly full or legacy state may
        // contain only a probabilistic summary of evicted identities. Neither
        // state can admit more work safely in this provider-process epoch. The
        // backend reaps an idle process before establishing a fresh epoch.
        if self.replay_history_blocks_admission() {
            self.durable_run_receipt_limit_reached = true;
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        if self.durable_run_receipt_limit_reached {
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        // Pending and completed calls become exact settled identities when the
        // turn terminates. Reserve that identity capacity before dispatch so
        // every admitted call can be settled without stranding active state.
        if !self.settled_identity_capacity_allows(1) {
            self.durable_run_receipt_limit_reached = true;
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        if self.pending.len() >= MAX_PENDING_CALLS {
            return Err(ProviderBridgeError::invalid(
                "concurrent provider tool call limit reached",
            ));
        }
        if self.total_call_receipts() >= MAX_DURABLE_CALL_RECEIPTS {
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        let input_bytes = json_size(&call.input, "provider tool input")?;
        let pending_bytes = self.pending_value_bytes()?;
        if pending_bytes
            .checked_add(input_bytes)
            .is_none_or(|total| total > MAX_ACCEPTED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 4 MiB acceptance limit",
            ));
        }
        let result_reserve = self
            .pending
            .len()
            .saturating_add(1)
            .checked_mul(MAX_TOOL_VALUE_BYTES)
            .ok_or_else(|| ProviderBridgeError::invalid("provider tool result reserve overflow"))?;
        let retained_value_bytes = self.retained_value_bytes()?;
        if retained_value_bytes
            .checked_add(input_bytes)
            .and_then(|total| total.checked_add(MAX_TOOL_VALUE_BYTES))
            .is_none_or(|total| total > MAX_RETAINED_TOOL_VALUE_BYTES)
        {
            self.durable_run_receipt_limit_reached = true;
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        if retained_value_bytes
            .checked_add(input_bytes)
            .and_then(|total| total.checked_add(result_reserve))
            .is_none_or(|total| total > MAX_RETAINED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        // Reserve the complete encoded receipt, including this exact input and
        // a maximum-sized result, before accepting work. An admitted call can
        // therefore always retain its authoritative result at settlement.
        if ensure_settled_result_capacity(self.retained_result_bytes, std::iter::once(&call))
            .is_err()
        {
            self.durable_run_receipt_limit_reached = true;
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        if self.ensure_settled_result_capacity(Some(&call)).is_err() {
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        self.pending.insert(call_id, call.clone());
        Ok(call)
    }

    pub fn apply_result(&mut self, result: ToolResult) -> Result<Value, ProviderBridgeError> {
        validate_stable_id(&result.call_id, "tool result call id")?;
        validate_operation_id(&result.operation_id)?;
        bounded_json(&result.result, MAX_TOOL_VALUE_BYTES, "provider tool result")?;
        if let Some(existing) = self.completed.get(&result.call_id) {
            return if existing.result == result {
                Ok(existing.result.result.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate tool result",
                ))
            };
        }
        if let Some(existing) = self.settled_results.get(&result.call_id) {
            return if existing.result == result {
                Ok(existing.result.result.clone())
            } else {
                Err(ProviderBridgeError::invalid(
                    "conflicting duplicate settled tool result",
                ))
            };
        }
        if self.has_settled_call_id(&result.call_id) {
            return Err(ProviderBridgeError::invalid(
                "legacy settled tool result cannot be replayed",
            ));
        }
        let pending = self.pending.get(&result.call_id).cloned().ok_or_else(|| {
            ProviderBridgeError::invalid("tool result does not match a pending provider call")
        })?;
        if pending.operation_id != result.operation_id {
            return Err(ProviderBridgeError::invalid(
                "tool result operation does not match its call",
            ));
        }
        let authorized = self.authorized.get(&result.operation_id).ok_or_else(|| {
            ProviderBridgeError::invalid("tool result operation is no longer authorized")
        })?;
        let validator = jsonschema::validator_for(&authorized.response_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {} has an invalid durable response JSON Schema",
                result.operation_id
            ))
        })?;
        let response = semantic_response_value(&result)?;
        if !result.is_error {
            // Paperclip semantic dispatchers return an authoritative envelope;
            // provider contracts describe the operation-specific value inside
            // `result`. Direct values remain valid for compatibility with v1
            // peers that do not wrap their semantic result.
            if let Some(response) = response {
                if !validator.is_valid(response) {
                    return Err(ProviderBridgeError::invalid(format!(
                        "tool result for {} failed JSON Schema validation",
                        result.operation_id
                    )));
                }
            }
        }
        let result_bytes = json_size(&result.result, "provider tool result")?;
        let retained_bytes = self.retained_value_bytes()?;
        if retained_bytes
            .checked_add(result_bytes)
            .is_none_or(|total| total > MAX_RETAINED_TOOL_VALUE_BYTES)
        {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 8 MiB aggregate limit",
            ));
        }
        let completed = CompletedToolCall {
            call: pending,
            result: result.clone(),
        };
        let receipt_bytes = retained_result_entry_bytes(&result.call_id, &completed)?;
        let next_retained_bytes = self
            .retained_result_bytes
            .checked_add(receipt_bytes)
            .ok_or_else(|| ProviderBridgeError::invalid("durable provider result size overflow"))?;
        ensure_settled_result_capacity(
            next_retained_bytes,
            self.pending
                .iter()
                .filter(|(call_id, _)| *call_id != &result.call_id)
                .map(|(_, call)| call),
        )?;
        self.pending.remove(&result.call_id);
        self.retained_result_bytes = next_retained_bytes;
        self.completed.insert(result.call_id.clone(), completed);
        Ok(result.result)
    }

    pub fn pending_calls(&self) -> impl Iterator<Item = &PendingToolCall> {
        self.pending.values()
    }

    pub fn cancel_pending_calls(
        &mut self,
        code: &str,
    ) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        let mut next = self.clone();
        let results = next.cancel_pending_calls_internal(code)?;
        *self = next;
        Ok(results)
    }

    pub fn settle_turn(&mut self, code: &str) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        validate_stable_id(code, "tool cancellation code")?;
        let results = self
            .pending
            .values()
            .map(|call| cancelled_tool_result(call, code))
            .collect::<Vec<_>>();
        let mut settled_entries = self.completed.clone();
        for (call_id, call) in &self.pending {
            settled_entries.insert(
                call_id.clone(),
                CompletedToolCall {
                    call: call.clone(),
                    result: cancelled_tool_result(call, code),
                },
            );
        }
        let next_retained_bytes =
            retained_result_bytes(self.settled_results.iter().chain(settled_entries.iter()))?;
        ensure_settled_result_capacity(next_retained_bytes, std::iter::empty())?;

        // Byte capacity was reserved at admission. Keep every identity exact
        // for the lifetime of this provider-process epoch; prepare_turn
        // releases only the bulky result bodies.
        let new_identity_count = settled_entries
            .keys()
            .filter(|call_id| !self.settled_call_ids.contains(call_id))
            .count();
        if self
            .settled_call_ids
            .len()
            .checked_add(new_identity_count)
            .is_none_or(|total| total > MAX_SETTLED_CALL_IDS)
        {
            return Err(ProviderBridgeError::active_turn_receipt_limit());
        }
        let evicted = self
            .settled_call_ids
            .extend_recent(settled_entries.keys().cloned(), MAX_SETTLED_CALL_IDS);
        debug_assert!(evicted.is_empty());
        self.pending.clear();
        self.completed.clear();
        self.settled_results.append(&mut settled_entries);
        self.retained_result_bytes = next_retained_bytes;
        Ok(results)
    }

    fn cancel_pending_calls_internal(
        &mut self,
        code: &str,
    ) -> Result<Vec<ToolResult>, ProviderBridgeError> {
        validate_stable_id(code, "tool cancellation code")?;
        let pending = self.pending.values().cloned().collect::<Vec<_>>();
        let mut results = Vec::with_capacity(pending.len());
        for call in pending {
            let result = cancelled_tool_result(&call, code);
            self.apply_result(result.clone())?;
            results.push(result);
        }
        Ok(results)
    }

    fn retained_value_bytes(&self) -> Result<usize, ProviderBridgeError> {
        let pending = self
            .pending
            .values()
            .map(|call| json_size(&call.input, "retained provider tool input"));
        let completed = self.completed.values().flat_map(|entry| {
            [
                json_size(&entry.call.input, "retained provider tool input"),
                json_size(&entry.result.result, "retained provider tool result"),
            ]
        });
        let settled = self.settled_results.values().flat_map(|entry| {
            [
                json_size(&entry.call.input, "retained provider tool input"),
                json_size(&entry.result.result, "retained provider tool result"),
            ]
        });
        pending
            .chain(completed)
            .chain(settled)
            .try_fold(0usize, |total, bytes| {
                total.checked_add(bytes?).ok_or_else(|| {
                    ProviderBridgeError::invalid("retained provider tool values overflow")
                })
            })
    }

    fn pending_value_bytes(&self) -> Result<usize, ProviderBridgeError> {
        self.pending.values().try_fold(0usize, |total, call| {
            total
                .checked_add(json_size(&call.input, "retained provider tool input")?)
                .ok_or_else(|| {
                    ProviderBridgeError::invalid("retained provider tool values overflow")
                })
        })
    }

    fn total_call_receipts(&self) -> usize {
        self.pending.len().saturating_add(self.completed.len())
    }

    fn validate_retained_value_bytes(&self) -> Result<(), ProviderBridgeError> {
        if self.retained_value_bytes()? > MAX_RETAINED_TOOL_VALUE_BYTES {
            return Err(ProviderBridgeError::invalid(
                "retained provider tool values exceed the 8 MiB aggregate limit",
            ));
        }
        Ok(())
    }

    fn ensure_settled_result_capacity(
        &self,
        additional_pending: Option<&PendingToolCall>,
    ) -> Result<(), ProviderBridgeError> {
        ensure_settled_result_capacity(
            self.retained_result_bytes,
            self.pending.values().chain(additional_pending.into_iter()),
        )
    }
}

fn validate_retained_result(entry: &CompletedToolCall) -> Result<(), ProviderBridgeError> {
    validate_stable_id(&entry.call.call_id, "retained tool call id")?;
    validate_stable_id(&entry.result.call_id, "retained tool result call id")?;
    validate_operation_id(&entry.call.operation_id)?;
    validate_operation_id(&entry.result.operation_id)?;
    if entry.call.call_id != entry.result.call_id
        || entry.call.operation_id != entry.result.operation_id
    {
        return Err(ProviderBridgeError::invalid(
            "retained provider tool receipt identity is inconsistent",
        ));
    }
    bounded_json(
        &entry.call.input,
        MAX_TOOL_VALUE_BYTES,
        "retained provider tool input",
    )?;
    bounded_json(
        &entry.result.result,
        MAX_TOOL_VALUE_BYTES,
        "retained provider tool result",
    )
}

fn validate_pending_tool_call(
    authorized: &BTreeMap<String, AuthorizedTool>,
    call: &PendingToolCall,
) -> Result<(), ProviderBridgeError> {
    validate_stable_id(&call.call_id, "tool call id")?;
    validate_operation_id(&call.operation_id)?;
    let tool = authorized.get(&call.operation_id).ok_or_else(|| {
        ProviderBridgeError::invalid(format!(
            "provider requested unauthorized tool {}",
            call.operation_id
        ))
    })?;
    let validator = jsonschema::validator_for(&tool.input_schema).map_err(|_| {
        ProviderBridgeError::invalid(format!(
            "tool {} has an invalid durable input JSON Schema",
            call.operation_id
        ))
    })?;
    if !validator.is_valid(&call.input) {
        return Err(ProviderBridgeError::invalid(format!(
            "provider arguments for {} failed JSON Schema validation",
            call.operation_id
        )));
    }
    bounded_json(&call.input, MAX_TOOL_VALUE_BYTES, "provider tool input")
}

fn validate_tool_result_contract(
    authorized: &BTreeMap<String, AuthorizedTool>,
    result: &ToolResult,
) -> Result<(), ProviderBridgeError> {
    let tool = authorized.get(&result.operation_id).ok_or_else(|| {
        ProviderBridgeError::invalid("tool result operation is no longer authorized")
    })?;
    let validator = jsonschema::validator_for(&tool.response_schema).map_err(|_| {
        ProviderBridgeError::invalid(format!(
            "tool {} has an invalid durable response JSON Schema",
            result.operation_id
        ))
    })?;
    let response = semantic_response_value(result)?;
    if !result.is_error {
        // Paperclip semantic dispatchers return an authoritative envelope;
        // provider contracts describe the operation-specific value inside
        // `result`. Direct values remain valid for compatibility with v1
        // peers that do not wrap their semantic result.
        if let Some(response) = response {
            if !validator.is_valid(response) {
                return Err(ProviderBridgeError::invalid(format!(
                    "tool result for {} failed JSON Schema validation",
                    result.operation_id
                )));
            }
        }
    }
    Ok(())
}

fn validate_authorized_tool_set(tool_set: &AuthorizedToolSet) -> Result<(), ProviderBridgeError> {
    if tool_set.schema != TOOL_SET_SCHEMA || tool_set.schema_version != 1 {
        return Err(ProviderBridgeError::invalid(
            "unsupported authorized tool-set contract",
        ));
    }
    if !is_sha256_digest(&tool_set.catalog_digest) {
        return Err(ProviderBridgeError::invalid(
            "authorized tool set requires a canonical sha256 catalog digest",
        ));
    }
    if tool_set.operations.len() > MAX_AUTHORIZED_TOOLS {
        return Err(ProviderBridgeError::invalid(
            "authorized tool set exceeds the operation limit",
        ));
    }
    bounded_json(tool_set, MAX_TOOL_SET_BYTES, "authorized tool set")?;
    let mut names = BTreeSet::new();
    for tool in &tool_set.operations {
        validate_operation_id(&tool.operation_id)?;
        if tool.version != 1 {
            return Err(ProviderBridgeError::invalid(format!(
                "unsupported tool version for {}",
                tool.operation_id
            )));
        }
        if tool.description.trim().is_empty()
            || tool.description.len() > MAX_DESCRIPTION_BYTES
            || tool.description.contains('\0')
            || !tool.input_schema.is_object()
            || !tool.response_schema.is_object()
        {
            return Err(ProviderBridgeError::invalid(format!(
                "tool {} has an incomplete provider contract",
                tool.operation_id
            )));
        }
        bounded_json(
            &tool.input_schema,
            MAX_SCHEMA_BYTES,
            "tool input JSON Schema",
        )?;
        bounded_json(
            &tool.response_schema,
            MAX_SCHEMA_BYTES,
            "tool response JSON Schema",
        )?;
        jsonschema::validator_for(&tool.input_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {} has an invalid input JSON Schema",
                tool.operation_id
            ))
        })?;
        jsonschema::validator_for(&tool.response_schema).map_err(|_| {
            ProviderBridgeError::invalid(format!(
                "tool {} has an invalid response JSON Schema",
                tool.operation_id
            ))
        })?;
        if !names.insert(tool.operation_id.clone()) {
            return Err(ProviderBridgeError::invalid(
                "authorized tool names must be unique",
            ));
        }
    }
    let computed_digest = authorized_tool_catalog_digest(&tool_set.operations)?;
    if tool_set.catalog_digest != computed_digest {
        return Err(ProviderBridgeError::invalid(
            "authorized tool catalog digest does not match its operations",
        ));
    }
    Ok(())
}

fn retained_result_entry_bytes(
    call_id: &str,
    result: &CompletedToolCall,
) -> Result<usize, ProviderBridgeError> {
    // A two-item tuple has the same delimiter cost as a one-entry JSON map.
    // Summing tuples therefore equals one entry exactly and conservatively
    // overcounts a multi-entry map by one byte per additional receipt.
    json_size(&(call_id, result), "retained provider tool result")
}

fn retained_result_bytes<'a>(
    results: impl IntoIterator<Item = (&'a String, &'a CompletedToolCall)>,
) -> Result<usize, ProviderBridgeError> {
    results
        .into_iter()
        .try_fold(0usize, |total, (call_id, result)| {
            total
                .checked_add(retained_result_entry_bytes(call_id, result)?)
                .ok_or_else(|| {
                    ProviderBridgeError::invalid("durable provider result size overflow")
                })
        })
}

fn pending_result_reserve_bytes(call: &PendingToolCall) -> Result<usize, ProviderBridgeError> {
    let placeholder = CompletedToolCall {
        call: call.clone(),
        result: ToolResult {
            call_id: call.call_id.clone(),
            operation_id: call.operation_id.clone(),
            result: Value::Null,
            is_error: false,
        },
    };
    retained_result_entry_bytes(&call.call_id, &placeholder)?
        .checked_sub(json_size(&Value::Null, "provider tool result reserve")?)
        .and_then(|bytes| bytes.checked_add(MAX_TOOL_VALUE_BYTES))
        .ok_or_else(|| ProviderBridgeError::invalid("durable provider result size overflow"))
}

fn ensure_settled_result_capacity<'a>(
    retained_bytes: usize,
    pending: impl IntoIterator<Item = &'a PendingToolCall>,
) -> Result<(), ProviderBridgeError> {
    let reserved_bytes = pending
        .into_iter()
        .try_fold(retained_bytes, |total, call| {
            total
                .checked_add(pending_result_reserve_bytes(call)?)
                .ok_or_else(|| {
                    ProviderBridgeError::invalid("durable provider result size overflow")
                })
        })?;
    if reserved_bytes > MAX_SETTLED_RESULT_BYTES {
        return Err(ProviderBridgeError::invalid(
            "durable provider tool result byte limit reached",
        ));
    }
    Ok(())
}

fn deserialize_retained_results<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, CompletedToolCall>, D::Error>
where
    D: Deserializer<'de>,
{
    struct RetainedResultsVisitor;

    impl<'de> Visitor<'de> for RetainedResultsVisitor {
        type Value = BTreeMap<String, CompletedToolCall>;

        fn expecting(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
            formatter.write_str("a bounded map of retained provider tool results")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            if map
                .size_hint()
                .is_some_and(|entries| entries > MAX_SETTLED_CALL_IDS)
            {
                return Err(de::Error::custom(
                    "retained provider tool result count exceeds the durable limit",
                ));
            }
            let mut results = BTreeMap::new();
            let mut retained_bytes = 0usize;
            while let Some((call_id, result)) = map.next_entry::<String, CompletedToolCall>()? {
                if results.len() >= MAX_SETTLED_CALL_IDS {
                    return Err(de::Error::custom(
                        "retained provider tool result count exceeds the durable limit",
                    ));
                }
                validate_retained_result(&result).map_err(de::Error::custom)?;
                if call_id != result.call.call_id || call_id != result.result.call_id {
                    return Err(de::Error::custom(
                        "retained provider tool result identity is inconsistent",
                    ));
                }
                retained_bytes = retained_bytes
                    .checked_add(
                        retained_result_entry_bytes(&call_id, &result)
                            .map_err(de::Error::custom)?,
                    )
                    .ok_or_else(|| de::Error::custom("durable provider result size overflow"))?;
                if retained_bytes > MAX_SETTLED_RESULT_BYTES {
                    return Err(de::Error::custom(
                        "retained provider tool results exceed the durable byte limit",
                    ));
                }
                if results.insert(call_id, result).is_some() {
                    return Err(de::Error::custom(
                        "retained provider tool result identities must be unique",
                    ));
                }
            }
            Ok(results)
        }
    }

    deserializer.deserialize_map(RetainedResultsVisitor)
}

fn cancelled_tool_result(call: &PendingToolCall, code: &str) -> ToolResult {
    ToolResult {
        call_id: call.call_id.clone(),
        operation_id: call.operation_id.clone(),
        result: serde_json::json!({
            "error": {
                "code": code,
                "message": "The provider turn stopped before this semantic tool completed",
                "retryable": false,
            },
        }),
        is_error: true,
    }
}

pub fn authorized_tool_catalog_digest(
    operations: &[AuthorizedTool],
) -> Result<String, ProviderBridgeError> {
    // Catalog identity is independent of projection order. Durable bridge
    // state stores tools in a BTreeMap, so hashing operation-id order here
    // keeps an accepted catalog byte-stable when it is serialized and
    // recovered.
    let mut canonical_operations = operations.iter().collect::<Vec<_>>();
    canonical_operations.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
    let value = serde_json::to_value(canonical_operations)
        .map_err(|_| ProviderBridgeError::invalid("authorized tool catalog is not serializable"))?;
    let canonical = canonical_json(&value);
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!("sha256:{digest:x}"))
}

pub fn semantic_value_digest(value: &Value) -> String {
    let digest = Sha256::digest(canonical_json(value).as_bytes());
    format!("sha256:{digest:x}")
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => canonical_json_number(value),
        Value::String(value) => {
            serde_json::to_string(value).expect("serializing an in-memory JSON string cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key)
                            .expect("serializing an in-memory JSON key cannot fail"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_json_number(value: &serde_json::Number) -> String {
    if value.is_i64() || value.is_u64() {
        return value.to_string();
    }
    let Some(float) = value.as_f64() else {
        return value.to_string();
    };
    if float == 0.0 {
        return "0".to_owned();
    }

    // serde_json preserves valid lexical spellings such as `1.0`, whereas
    // JSON.stringify canonicalizes JavaScript numbers. Normalize the shortest
    // serde representation to the ECMAScript decimal/exponent thresholds so
    // the server and runner hash the same schema value.
    let encoded = value.to_string().to_ascii_lowercase();
    let (negative, unsigned) = encoded
        .strip_prefix('-')
        .map_or((false, encoded.as_str()), |rest| (true, rest));
    let (coefficient, explicit_exponent) = unsigned
        .split_once('e')
        .map_or((unsigned, 0_i32), |(coefficient, exponent)| {
            (coefficient, exponent.parse::<i32>().unwrap_or(0))
        });
    let fraction_digits = coefficient
        .split_once('.')
        .map_or(0_i32, |(_, fraction)| fraction.len() as i32);
    let mut digits = coefficient
        .bytes()
        .filter(|byte| *byte != b'.')
        .map(char::from)
        .collect::<String>();
    let mut decimal_position = digits.len() as i32 + explicit_exponent - fraction_digits;

    let leading_zeros = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading_zeros);
    decimal_position -= leading_zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }
    if digits.is_empty() {
        return "0".to_owned();
    }

    let magnitude = float.abs();
    // The lower ECMAScript threshold is inclusive: JSON.stringify(1e-6)
    // produces decimal notation, while values below it use an exponent.
    // Spell both comparisons out so that the wire-digest boundary is explicit.
    let uses_decimal_notation = magnitude >= 1e-6 && magnitude < 1e21;
    let body = if uses_decimal_notation {
        if decimal_position <= 0 {
            format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
        } else if decimal_position >= digits.len() as i32 {
            format!(
                "{}{}",
                digits,
                "0".repeat((decimal_position - digits.len() as i32) as usize)
            )
        } else {
            let split = decimal_position as usize;
            format!("{}.{}", &digits[..split], &digits[split..])
        }
    } else {
        let exponent = decimal_position - 1;
        let coefficient = if digits.len() == 1 {
            digits
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!(
            "{coefficient}e{}{exponent}",
            if exponent >= 0 { "+" } else { "" }
        )
    };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

fn semantic_response_value(result: &ToolResult) -> Result<Option<&Value>, ProviderBridgeError> {
    let Some(envelope) = result.result.as_object() else {
        return Ok(Some(&result.result));
    };
    let Some(ok) = envelope.get("ok").and_then(Value::as_bool) else {
        return Ok(Some(&result.result));
    };
    if !envelope.contains_key("operationId") && !envelope.contains_key("callId") {
        return Ok(Some(&result.result));
    }
    if envelope.get("operationId").and_then(Value::as_str) != Some(&result.operation_id)
        || envelope.get("callId").and_then(Value::as_str) != Some(&result.call_id)
    {
        return Err(ProviderBridgeError::invalid(
            "semantic result envelope does not match its provider call",
        ));
    }
    if ok {
        envelope
            .get("result")
            .or_else(|| envelope.get("value"))
            .map(Some)
            .ok_or_else(|| ProviderBridgeError::invalid("successful semantic result omitted value"))
    } else if envelope.get("denial").is_some() || envelope.get("error").is_some() {
        Ok(None)
    } else {
        Err(ProviderBridgeError::invalid(
            "failed semantic result omitted denial or error",
        ))
    }
}

fn validate_operation_id(value: &str) -> Result<(), ProviderBridgeError> {
    validate_stable_id(value, "tool operation id")
}

fn validate_stable_id(value: &str, label: &str) -> Result<(), ProviderBridgeError> {
    let mut chars = value.chars();
    let first = chars
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let rest = chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    });
    if first && rest && value.len() <= 160 {
        Ok(())
    } else {
        Err(ProviderBridgeError::invalid(format!("{label} is invalid")))
    }
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_json(
    value: &impl Serialize,
    max_bytes: usize,
    label: &str,
) -> Result<(), ProviderBridgeError> {
    let bytes = json_size(value, label)?;
    if bytes > max_bytes {
        return Err(ProviderBridgeError::invalid(format!(
            "{label} exceeds the {max_bytes} byte limit"
        )));
    }
    Ok(())
}

fn json_size(value: &impl Serialize, label: &str) -> Result<usize, ProviderBridgeError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|_| ProviderBridgeError::invalid(format!("{label} is not serializable")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_number_uses_decimal_notation_at_javascript_lower_boundary() {
        for encoded in ["1e-6", "0.000001"] {
            let value: Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(canonical_json(&value), "0.000001");
        }

        for encoded in ["-1e-6", "-0.000001"] {
            let value: Value = serde_json::from_str(encoded).unwrap();
            assert_eq!(canonical_json(&value), "-0.000001");
        }

        let below_boundary: Value = serde_json::from_str("9.99999e-7").unwrap();
        assert_eq!(canonical_json(&below_boundary), "9.99999e-7");
    }

    #[test]
    fn worst_case_result_identity_overhead_fits_the_admission_reserve() {
        let call_id = "x".repeat(160);
        let call = PendingToolCall {
            call_id: call_id.clone(),
            operation_id: "x".repeat(160),
            input: Value::String("x".repeat(MAX_TOOL_VALUE_BYTES - 2)),
        };
        let completed = CompletedToolCall {
            call: call.clone(),
            result: ToolResult {
                call_id: call_id.clone(),
                operation_id: call.operation_id.clone(),
                result: Value::String("x".repeat(MAX_TOOL_VALUE_BYTES - 2)),
                is_error: false,
            },
        };

        assert_eq!(
            json_size(&completed.result.result, "test result").unwrap(),
            MAX_TOOL_VALUE_BYTES
        );
        assert!(
            retained_result_entry_bytes(&call_id, &completed).unwrap()
                <= pending_result_reserve_bytes(&call).unwrap()
        );
    }

    #[test]
    fn exact_completed_results_are_bounded_without_changing_replay() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation.clone()],
            })
            .unwrap();
        bridge
            .begin_call(
                "call-0".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("begin the first exact call");
        bridge
            .apply_result(ToolResult {
                call_id: "call-0".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .expect("complete the first exact call");
        assert_eq!(
            bridge
                .replay_result("call-0", "get_task_context", &json!({}))
                .unwrap()
                .unwrap()
                .result,
            json!({"ok": true})
        );
        for index in 1..MAX_DURABLE_CALL_RECEIPTS {
            let call_id = format!("call-{index}");
            bridge.completed.insert(
                call_id.clone(),
                CompletedToolCall {
                    call: PendingToolCall {
                        call_id: call_id.clone(),
                        operation_id: "get_task_context".to_owned(),
                        input: json!({}),
                    },
                    result: ToolResult {
                        call_id,
                        operation_id: "get_task_context".to_owned(),
                        result: json!({"ok": true}),
                        is_error: false,
                    },
                },
            );
        }
        let error = bridge
            .begin_call(
                "call-new".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("the exact receipt limit must stop active-turn growth");
        assert!(error.is_active_turn_receipt_limit());

        assert_eq!(
            bridge
                .replay_result("call-0", "get_task_context", &json!({}))
                .unwrap()
                .unwrap()
                .result,
            json!({"ok": true})
        );
        assert!(bridge
            .apply_result(ToolResult {
                call_id: "call-0".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": false}),
                is_error: false,
            })
            .is_err());
        bridge.validate_retained_value_bytes().unwrap();
        assert!(serde_json::to_vec_pretty(&bridge).unwrap().len() < 4 * 1024 * 1024);
        let recovered: ProviderToolBridge =
            serde_json::from_str(&serde_json::to_string(&bridge).unwrap()).unwrap();
        recovered.validate_recovered().unwrap();
        assert_eq!(
            recovered
                .replay_result("call-0", "get_task_context", &json!({}))
                .unwrap()
                .unwrap()
                .result,
            json!({"ok": true})
        );

        bridge.settle_turn("provider_turn_terminated").unwrap();
        assert!(bridge
            .begin_call(
                "call-0".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .is_err());
        bridge.prepare_turn().unwrap();
        assert!(bridge
            .replay_result("call-0", "get_task_context", &json!({}))
            .unwrap()
            .is_none());
        assert!(bridge
            .begin_call(
                "call-0".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .is_err());
        bridge
            .begin_call(
                "next-turn-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("a new identity remains admissible after bulky results are released");

        let recovered: ProviderToolBridge =
            serde_json::from_str(&serde_json::to_string(&bridge).unwrap()).unwrap();
        recovered.validate_recovered().unwrap();
        assert!(recovered.has_completed_call("call-0"));
    }

    #[test]
    fn admission_reserves_exact_identity_capacity_for_settlement() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation.clone()],
            })
            .unwrap();
        for index in 0..MAX_SETTLED_CALL_IDS - 1 {
            let call_id = format!("settled-call-{index}");
            bridge.settled_call_ids.order.push_back(call_id.clone());
            bridge.settled_call_ids.members.insert(call_id);
        }

        bridge
            .begin_call(
                "final-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("the final exact identity slot remains usable");
        let mut pending_at_capacity = bridge.clone();
        let error = pending_at_capacity
            .begin_call(
                "rejected-while-pending".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a pending call must reserve its eventual settled identity");
        assert!(error.is_active_turn_receipt_limit());
        assert!(pending_at_capacity.durable_run_receipt_limit_reached);
        assert_eq!(pending_at_capacity.pending.len(), 1);
        assert!(pending_at_capacity.pending.contains_key("final-call"));
        assert!(!pending_at_capacity
            .pending
            .contains_key("rejected-while-pending"));
        pending_at_capacity
            .begin_call(
                "final-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("an idempotent retry remains valid at capacity");
        let cancelled = pending_at_capacity
            .settle_turn("semantic_tool_turn_receipt_limit")
            .unwrap();
        assert_eq!(cancelled.len(), 1);
        assert_eq!(
            pending_at_capacity.settled_call_ids.len(),
            MAX_SETTLED_CALL_IDS
        );

        bridge
            .apply_result(ToolResult {
                call_id: "final-call".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .expect("complete the call admitted into the final identity slot");

        let mut overcommitted = bridge.clone();
        overcommitted.pending.insert(
            "unsettleable-call".to_owned(),
            PendingToolCall {
                call_id: "unsettleable-call".to_owned(),
                operation_id: "get_task_context".to_owned(),
                input: json!({}),
            },
        );
        assert_eq!(
            overcommitted.validate_recovered().unwrap_err().to_string(),
            "recovered provider tool bridge cannot settle its active call identities"
        );
        let overcommitted_snapshot = overcommitted.clone();
        let error = overcommitted
            .settle_turn("semantic_tool_turn_receipt_limit")
            .expect_err("defensive settlement must reject an overcommitted recovered state");
        assert!(error.is_active_turn_receipt_limit());
        assert_eq!(overcommitted, overcommitted_snapshot);

        let error = bridge
            .begin_call(
                "rejected-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("admission must reserve space for every active identity");
        assert!(error.is_active_turn_receipt_limit());
        assert!(bridge.durable_run_receipt_limit_reached);
        assert!(!bridge.pending.contains_key("rejected-call"));
        assert!(bridge.completed.contains_key("final-call"));

        assert!(bridge
            .settle_turn("semantic_tool_turn_receipt_limit")
            .unwrap()
            .is_empty());
        assert!(bridge.pending.is_empty());
        assert!(bridge.completed.is_empty());
        assert_eq!(bridge.settled_call_ids.len(), MAX_SETTLED_CALL_IDS);
        assert!(bridge.settled_results.contains_key("final-call"));

        bridge.prepare_turn().unwrap();
        assert_eq!(bridge.settled_call_ids.len(), MAX_SETTLED_CALL_IDS);
        assert!(bridge.settled_results.is_empty());
        assert!(bridge.durable_run_receipt_limit_reached);
        let error = bridge
            .begin_call(
                "next-turn-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a turn boundary must not reopen a saturated durable run");
        assert!(error.is_active_turn_receipt_limit());

        let encoded = serde_json::to_string(&bridge).unwrap();
        let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
        recovered.attach_existing_run().unwrap();
        assert_eq!(recovered.settled_call_ids.len(), MAX_SETTLED_CALL_IDS);
        assert!(recovered.durable_run_receipt_limit_reached);
        let error = recovered
            .begin_call(
                "recovered-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("recovery must preserve saturated replay authority");
        assert!(error.is_active_turn_receipt_limit());

        recovered
            .attach_run(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation.clone()],
            })
            .unwrap();
        assert!(recovered.settled_call_ids.is_empty());
        assert!(!recovered.durable_run_receipt_limit_reached);
        recovered
            .begin_call(
                "settled-call-0".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("a new durable run receives fresh replay authority");
    }

    #[test]
    fn legacy_replay_filter_quarantines_the_durable_run() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation.clone()],
            })
            .unwrap();
        bridge.settled_call_filter.words = vec![0; REPLAY_FILTER_WORDS];
        bridge.settled_call_filter.words[0] = 1;

        let error = bridge
            .begin_call(
                "legacy-evicted-or-fresh".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a legacy probabilistic epoch cannot dispatch more work");
        assert!(error.is_active_turn_receipt_limit());
        assert!(bridge.pending.is_empty());
        assert!(bridge.durable_run_receipt_limit_reached);

        bridge.prepare_turn().unwrap();
        assert!(!bridge.settled_call_filter.is_empty());
        assert!(bridge.durable_run_receipt_limit_reached);
        let error = bridge
            .begin_call(
                "legacy-evicted-or-fresh".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a turn boundary cannot make legacy ambiguity safe");
        assert!(error.is_active_turn_receipt_limit());

        let encoded = serde_json::to_string(&bridge).unwrap();
        let mut recovered: ProviderToolBridge = serde_json::from_str(&encoded).unwrap();
        recovered.attach_existing_run().unwrap();
        assert!(!recovered.settled_call_filter.is_empty());
        assert!(recovered.durable_run_receipt_limit_reached);

        recovered
            .attach_run(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        assert!(recovered.settled_call_filter.is_empty());
        assert!(!recovered.durable_run_receipt_limit_reached);
        recovered
            .begin_call(
                "legacy-evicted-or-fresh".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("a new durable run starts a fresh exact receipt ledger");
    }

    #[test]
    fn legacy_full_exact_receipt_epoch_is_quarantined_before_dispatch() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation.clone()],
            })
            .unwrap();
        for index in 0..MAX_SETTLED_CALL_IDS {
            let call_id = format!("legacy-call-{index}");
            bridge.settled_call_ids.order.push_back(call_id.clone());
            bridge.settled_call_ids.members.insert(call_id);
        }

        let error = bridge
            .begin_call(
                "fresh-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a full legacy exact epoch cannot dispatch more work");
        assert!(error.is_active_turn_receipt_limit());
        assert!(bridge.pending.is_empty());

        bridge.prepare_turn().unwrap();
        let error = bridge
            .begin_call(
                "fresh-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect_err("a turn boundary must preserve the full durable ledger");
        assert!(error.is_active_turn_receipt_limit());

        bridge
            .attach_run(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        bridge
            .begin_call(
                "fresh-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("a new durable run resets the full legacy ledger");
    }

    #[test]
    fn provider_restart_rotates_only_an_idle_replay_epoch() {
        let operation = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the active task context.".to_owned(),
            input_schema: json!({"type": "object"}),
            response_schema: json!({"type": "object"}),
        };
        let mut bridge = ProviderToolBridge::default();
        bridge
            .prepare(AuthorizedToolSet {
                schema: TOOL_SET_SCHEMA.to_owned(),
                schema_version: 1,
                catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                    .unwrap(),
                operations: vec![operation],
            })
            .unwrap();
        bridge
            .begin_call(
                "old-epoch-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id: "old-epoch-call".to_owned(),
                operation_id: "get_task_context".to_owned(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap();
        bridge.settle_turn("provider_turn_terminated").unwrap();
        bridge.settled_call_filter.words = vec![0; REPLAY_FILTER_WORDS];
        bridge.settled_call_filter.words[0] = 1;

        let error = bridge
            .rollover_replay_epoch_after_provider_restart()
            .expect_err("retained replay results keep the current epoch authoritative");
        assert!(error.to_string().contains("receipts are retained"));
        assert!(bridge
            .begin_call(
                "old-epoch-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .is_err());

        bridge.prepare_turn().unwrap();
        bridge
            .rollover_replay_epoch_after_provider_restart()
            .expect("an idle replacement process establishes fresh replay authority");
        bridge
            .begin_call(
                "old-epoch-call".to_owned(),
                "get_task_context".to_owned(),
                json!({}),
            )
            .expect("the fresh process generation remains live after bounded rotation");
    }
}
