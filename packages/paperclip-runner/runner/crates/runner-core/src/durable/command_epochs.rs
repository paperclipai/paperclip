use serde::{Deserialize, Serialize};

use super::DurableRunnerError;

pub(crate) const CAPABILITY: &str = "transport.command_epochs.v1";

pub(crate) fn valid_epoch(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122
            && id.to_string() == value
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommandEpochTransition {
    pub schema: String,
    pub run_id: String,
    pub transition_id: String,
    pub from_epoch: Option<String>,
    pub next_epoch: String,
    pub final_ordinal: u64,
}

impl CommandEpochTransition {
    pub fn validate(&self, run_id: &str) -> Result<(), DurableRunnerError> {
        if self.schema != "paperclip.prp.command-epoch.v1"
            || self.run_id != run_id
            || !valid_epoch(&self.transition_id)
            || !valid_epoch(&self.next_epoch)
            || self
                .from_epoch
                .as_deref()
                .is_some_and(|id| !valid_epoch(id))
            || self.from_epoch.as_ref() == Some(&self.next_epoch)
            || self.final_ordinal == 0
            || self.final_ordinal > 9_007_199_254_740_991
        {
            return Err(DurableRunnerError::invalid(
                "invalid command epoch transition",
            ));
        }
        Ok(())
    }
}
