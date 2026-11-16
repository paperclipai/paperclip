//! Reads the ACPX sidecar's prompt-dispatch journal.
//!
//! The sidecar's runtime port writes `received` for a turn before any provider
//! work and appends a synced `dispatched` immediately before the turn's first
//! `session/prompt` request reaches the provider (see the TypeScript
//! `turn-dispatch-journal.ts` and `turnDispatchJournalRecord` in the sidecar
//! schema). Callers read it only after they prove that the sidecar and the
//! provider are gone, so neither can still write or send.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;

use crate::durable::open_private_regular_file;
use crate::generated_acpx_sidecar_contract::{
    GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE, GENERATED_ACPX_TURN_DISPATCH_SCHEMA,
};

// Two records of one bounded turn ID fit easily; anything larger is not ours.
const MAX_JOURNAL_BYTES: u64 = 4 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TurnDispatchEvidence {
    /// The sidecar started this turn and never wrote its prompt to the provider.
    NotDispatched,
    /// The prompt may have reached the provider.
    Dispatched,
    /// No usable record for this turn: an older sidecar, another turn, or a
    /// damaged file. Recovery must not assume either outcome.
    Unknown,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: String,
    #[serde(rename = "turnId")]
    turn_id: String,
    phase: String,
}

pub(crate) fn read_turn_dispatch_journal(
    runtime_directory: &Path,
    turn_id: &str,
) -> TurnDispatchEvidence {
    let path = runtime_directory.join(GENERATED_ACPX_TURN_DISPATCH_JOURNAL_FILE);
    let Ok(file) = open_private_regular_file(&path) else {
        return TurnDispatchEvidence::Unknown;
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_JOURNAL_BYTES
    {
        return TurnDispatchEvidence::Unknown;
    }
    classify(&bytes, turn_id)
}

fn classify(bytes: &[u8], turn_id: &str) -> TurnDispatchEvidence {
    // Every record ends with a newline; a torn tail proves nothing.
    let Some(body) = bytes.strip_suffix(b"\n") else {
        return TurnDispatchEvidence::Unknown;
    };
    let mut phases = Vec::new();
    for line in body.split(|byte| *byte == b'\n') {
        let Ok(record) = serde_json::from_slice::<Record>(line) else {
            return TurnDispatchEvidence::Unknown;
        };
        if record.schema != GENERATED_ACPX_TURN_DISPATCH_SCHEMA || record.turn_id != turn_id {
            return TurnDispatchEvidence::Unknown;
        }
        phases.push(record.phase);
    }
    match phases.as_slice() {
        [received] if received == "received" => TurnDispatchEvidence::NotDispatched,
        [received, rest @ ..]
            if received == "received"
                && !rest.is_empty()
                && rest.iter().all(|phase| phase == "dispatched") =>
        {
            TurnDispatchEvidence::Dispatched
        }
        _ => TurnDispatchEvidence::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(turn: &str, phase: &str) -> String {
        format!(
            "{{\"schema\":\"{GENERATED_ACPX_TURN_DISPATCH_SCHEMA}\",\"turnId\":\"{turn}\",\"phase\":\"{phase}\"}}\n"
        )
    }

    #[test]
    fn only_a_lone_received_record_of_this_turn_proves_the_prompt_never_left() {
        let received = line("turn-1", "received");
        let dispatched = format!("{received}{}", line("turn-1", "dispatched"));
        assert_eq!(
            classify(received.as_bytes(), "turn-1"),
            TurnDispatchEvidence::NotDispatched
        );
        assert_eq!(
            classify(dispatched.as_bytes(), "turn-1"),
            TurnDispatchEvidence::Dispatched
        );
        for unknown in [
            String::new(),
            received.trim_end().to_owned(),
            line("turn-0", "received"),
            line("turn-1", "dispatched"),
            format!("{received}{}", line("turn-0", "dispatched")),
            format!("{received}{{\"schema\":"),
            format!("{received}{received}"),
            received.replace(
                "paperclip.acpx-turn-dispatch.v1",
                "paperclip.acpx-turn-dispatch.v0",
            ),
            received.replace("}\n", ",\"extra\":true}\n"),
        ] {
            assert_eq!(
                classify(unknown.as_bytes(), "turn-1"),
                TurnDispatchEvidence::Unknown,
                "{unknown:?}"
            );
        }
    }
}
