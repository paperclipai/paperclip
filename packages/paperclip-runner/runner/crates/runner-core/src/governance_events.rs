//! Canonical payloads for governance activity from the native Codex harness:
//! hooks (`hook/started|completed`) and approval auto-review
//! (`item/autoApprovalReview/started|completed`). These are display records
//! that keep automatic decisions auditable; they carry no execution authority.
//!
//! Shapes are the `hook` and `safetyReview` definitions in
//! `protocol/schemas/provider-event.schema.json`, and mirror
//! `src/governance-events.ts` used by the TypeScript drivers.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::durable::redact_text;

const MESSAGE_CHARS: usize = 4_000;
const ACTION_CHARS: usize = 1_000;
const NAME_CHARS: usize = 160;

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn clip(value: &str, limit: usize) -> String {
    let redacted = redact_text(value);
    if redacted.chars().count() <= limit {
        return redacted;
    }
    let mut clipped: String = redacted.chars().take(limit.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

fn nullable_clip(value: Option<&Value>, limit: usize) -> Value {
    let trimmed = text(value).trim();
    if trimmed.is_empty() {
        Value::Null
    } else {
        Value::String(clip(trimmed, limit))
    }
}

fn non_negative_integer(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(raw) if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) => {
            raw.parse().ok()
        }
        _ => None,
    }
}

fn safe_id(value: &str, fallback: &str) -> String {
    let candidate: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "._:-".contains(character) {
                character
            } else {
                '-'
            }
        })
        .take(NAME_CHARS)
        .collect();
    if candidate
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
    {
        candidate
    } else {
        fallback.to_owned()
    }
}

/// Codex reuses `run.id` (`<event>:<order>:<config path>`) for every call of
/// the same configured hook, and it embeds a host path. One invocation is a
/// digest of that id plus the start time that started and completed share.
fn codex_hook_run_id(run: &Value, turn_id: &str) -> String {
    let definition = match text(run.get("id")) {
        "" => format!(
            "{}:{}",
            text(run.get("eventName")),
            run.get("displayOrder")
                .map(Value::to_string)
                .unwrap_or_default()
        ),
        id => id.to_owned(),
    };
    let digest = Sha256::digest(format!("{turn_id}|{definition}").as_bytes());
    let short: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    match non_negative_integer(run.get("startedAt")) {
        Some(started_at) => format!("hook-{short}-{started_at}"),
        None => format!("hook-{short}"),
    }
}

/// Where the hook is defined, without the host path. Codex reports the file
/// that declares the hook (usually `config.toml`), so a config file reads as
/// its layer ("user hooks") rather than a filename.
fn hook_source(path: Option<&Value>, layer: Option<&Value>) -> Value {
    let name = text(path)
        .trim()
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or("");
    let config_file = matches!(
        name,
        "config.toml" | "hooks.json" | "requirements.toml" | "managed_config.toml"
    );
    if !name.is_empty() && !config_file {
        return Value::String(clip(name, NAME_CHARS));
    }
    match text(layer) {
        source @ ("user" | "project" | "system" | "plugin") => {
            Value::String(format!("{source} hooks"))
        }
        "" | "unknown" if !name.is_empty() => Value::String(clip(name, NAME_CHARS)),
        "" | "unknown" => Value::Null,
        _ => Value::String("managed hooks".to_owned()),
    }
}

fn first_entry<'a>(entries: &'a [(String, String)], kinds: &[&str]) -> Option<&'a str> {
    kinds.iter().find_map(|kind| {
        entries
            .iter()
            .find(|(entry_kind, _)| entry_kind == kind)
            .map(|(_, entry_text)| entry_text.as_str())
    })
}

/// Codex `hook/started` and `hook/completed` (`HookRunSummary` in `params.run`).
pub(crate) fn codex_hook_payload(method: &str, params: &Value) -> Value {
    let run = params.get("run").unwrap_or(&Value::Null);
    let started = method == "hook/started";
    let raw_status = if started {
        "running"
    } else {
        match text(run.get("status")) {
            "" => "completed",
            status => status,
        }
    };
    let status = match raw_status {
        "running" | "failed" | "blocked" | "stopped" | "cancelled" => raw_status,
        _ => "completed",
    };
    let entries: Vec<(String, String)> = run
        .get("entries")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .take(64)
                .map(|entry| {
                    (
                        text(entry.get("kind")).to_owned(),
                        text(entry.get("text")).trim().to_owned(),
                    )
                })
                .filter(|(_, entry_text)| !entry_text.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let has = |kind: &str| entries.iter().any(|(entry_kind, _)| entry_kind == kind);
    let outcome = match status {
        "running" => "running",
        "blocked" | "stopped" | "failed" => status,
        "cancelled" => "failed",
        _ if has("feedback") => "feedback",
        _ if has("context") => "context",
        _ => "passed",
    };
    let message = match outcome {
        "blocked" | "stopped" => first_entry(
            &entries,
            &["stop", "feedback", "error", "warning", "context"],
        ),
        "failed" => first_entry(&entries, &["error", "warning", "stop", "feedback"]),
        "feedback" => first_entry(&entries, &["feedback"]),
        "context" => first_entry(&entries, &["context"]),
        _ => first_entry(&entries, &["warning"]),
    };
    json!({
        "schema": "paperclip.hook.v1",
        "hookId": codex_hook_run_id(run, text(params.get("turnId"))),
        "event": clip(match text(run.get("eventName")) { "" => "unknown", name => name }, NAME_CHARS),
        "scope": clip(match text(run.get("scope")) { "" => "provider", scope => scope }, NAME_CHARS),
        "status": status,
        // Codex reports `sync` hooks, which can block the action, and `async` ones.
        "blocking": matches!(text(run.get("executionMode")), "sync" | "blocking"),
        "durationMs": non_negative_integer(run.get("durationMs")),
        "summary": nullable_clip(run.get("statusMessage"), MESSAGE_CHARS),
        "outcome": outcome,
        "message": match message {
            Some(message) => Value::String(clip(message, MESSAGE_CHARS)),
            None => match nullable_clip(run.get("statusMessage"), MESSAGE_CHARS) {
                Value::Null if status == "cancelled" => Value::String("The hook was cancelled.".to_owned()),
                value => value,
            },
        },
        "source": hook_source(run.get("sourcePath"), run.get("source")),
        "toolName": Value::Null,
    })
}

/// `/bin/zsh -lc 'rm -rf build'` reads as `rm -rf build`.
fn unwrap_shell_command(command: &str) -> String {
    let trimmed = command.trim();
    for shell in [
        "/bin/zsh",
        "/bin/bash",
        "/bin/sh",
        "/usr/bin/zsh",
        "/usr/bin/bash",
        "zsh",
        "bash",
        "sh",
    ] {
        for flag in [" -lc '", " -c '"] {
            let prefix = format!("{shell}{flag}");
            if let Some(body) = trimmed
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix('\''))
            {
                let unescaped = body.replace("'\\''", "'");
                if !unescaped.contains('\'') || body.contains("'\\''") {
                    return unescaped;
                }
            }
        }
    }
    command.to_owned()
}

/// A short, display-safe description of what the reviewer was asked to approve.
fn safety_action(action: &Value) -> (&'static str, Value) {
    let kind = match text(action.get("type")) {
        "command" => "command",
        "execve" => "execve",
        "writeStdin" => "writeStdin",
        "applyPatch" => "applyPatch",
        "networkAccess" => "networkAccess",
        "mcpToolCall" => "mcpToolCall",
        "requestPermissions" => "requestPermissions",
        _ => "unknown",
    };
    let strings = |key: &str| -> Vec<&str> {
        action
            .get(key)
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    };
    let summary = match kind {
        "command" => unwrap_shell_command(text(action.get("command"))),
        "execve" => {
            let argv = strings("argv");
            if argv.is_empty() {
                text(action.get("program")).to_owned()
            } else {
                argv.join(" ")
            }
        }
        // Never echo the input itself; it can be a password typed into a prompt.
        "writeStdin" => "input to a running command".to_owned(),
        "applyPatch" => {
            let files = strings("files");
            match files.len() {
                1 => format!("edit {}", files[0]),
                0 => "edit 0 files".to_owned(),
                count => format!(
                    "edit {count} files: {}{}",
                    files.iter().take(3).copied().collect::<Vec<_>>().join(", "),
                    if count > 3 { ", …" } else { "" }
                ),
            }
        }
        "networkAccess" => match (
            text(action.get("host")),
            non_negative_integer(action.get("port")),
        ) {
            ("", _) => text(action.get("target")).to_owned(),
            (host, Some(port)) => format!("{host}:{port}"),
            (host, None) => host.to_owned(),
        },
        "mcpToolCall" => {
            let server = match text(action.get("connectorName")) {
                "" => text(action.get("server")),
                name => name,
            };
            let tool = match text(action.get("toolTitle")) {
                "" => text(action.get("toolName")),
                title => title,
            };
            [server, tool]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" · ")
        }
        "requestPermissions" => match text(action.get("reason")) {
            "" => "additional permissions".to_owned(),
            reason => reason.to_owned(),
        },
        _ => String::new(),
    };
    let collapsed = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    (
        kind,
        if collapsed.is_empty() {
            Value::Null
        } else {
            Value::String(clip(&collapsed, ACTION_CHARS))
        },
    )
}

/// Codex `item/autoApprovalReview/started|completed` (approval auto-review).
pub(crate) fn codex_safety_review_payload(method: &str, params: &Value) -> Value {
    let review = params.get("review").unwrap_or(&Value::Null);
    let started = method.ends_with("started");
    let decision = if started {
        "pending"
    } else {
        match text(review.get("status")) {
            "approved" => "allowed",
            "denied" => "denied",
            "timedOut" => "timed_out",
            "aborted" => "aborted",
            "inProgress" => "pending",
            _ => "unknown",
        }
    };
    let (action_kind, action) = safety_action(params.get("action").unwrap_or(&Value::Null));
    let risk_level = match text(review.get("riskLevel")) {
        level @ ("low" | "medium" | "high" | "critical") => Value::String(level.to_owned()),
        _ => Value::Null,
    };
    let user_authorization = match text(review.get("userAuthorization")) {
        level @ ("unknown" | "low" | "medium" | "high") => Value::String(level.to_owned()),
        _ => Value::Null,
    };
    let target = text(params.get("targetItemId"));
    json!({
        "schema": "paperclip.safety.review.v1",
        "reviewId": safe_id(text(params.get("reviewId")), "safety-review"),
        // The native tool execution uses the same stable id for this item.
        "targetExecutionId": if target.is_empty() { Value::Null } else { Value::String(safe_id(target, "execution")) },
        "status": if started || decision == "pending" { "running" } else { "completed" },
        "decision": decision,
        "summary": nullable_clip(review.get("rationale"), MESSAGE_CHARS),
        "actionKind": action_kind,
        "action": action,
        "riskLevel": risk_level,
        // Not "userAuthorization": durable writers redact keys ending in "authorization".
        "userConsent": user_authorization,
        "rationale": nullable_clip(review.get("rationale"), MESSAGE_CHARS),
        "decidedBy": nullable_clip(params.get("decisionSource"), NAME_CHARS),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook_run(overrides: Value) -> Value {
        let mut run = json!({
            "id": "pre-tool-use:0:/Users/agent/.codex/config.toml",
            "eventName": "preToolUse",
            "handlerType": "command",
            "executionMode": "sync",
            "scope": "turn",
            "sourcePath": "/Users/agent/.codex/config.toml",
            "source": "user",
            "displayOrder": 0,
            "status": "completed",
            "statusMessage": null,
            "startedAt": 1_793_890_000,
            "completedAt": 1_793_890_001,
            "durationMs": 41,
            "entries": [],
        });
        for (key, value) in overrides.as_object().unwrap() {
            run[key] = value.clone();
        }
        json!({"threadId": "thread-1", "turnId": "turn-1", "run": run})
    }

    #[test]
    fn records_a_blocking_hook_without_the_host_path() {
        let payload = codex_hook_payload(
            "hook/completed",
            &hook_run(
                json!({"status": "blocked", "entries": [{"kind": "feedback", "text": "Migrations are append-only."}]}),
            ),
        );
        assert_eq!(payload["status"], "blocked");
        assert_eq!(payload["outcome"], "blocked");
        assert_eq!(payload["blocking"], true);
        assert_eq!(payload["message"], "Migrations are append-only.");
        assert_eq!(payload["source"], "user hooks");
        assert!(!payload.to_string().contains("/Users/agent"));
    }

    #[test]
    fn gives_each_invocation_of_one_hook_its_own_id() {
        let first = codex_hook_payload("hook/completed", &hook_run(json!({"startedAt": 1})));
        let second = codex_hook_payload("hook/completed", &hook_run(json!({"startedAt": 2})));
        let started = codex_hook_payload("hook/started", &hook_run(json!({"startedAt": 2})));
        assert_ne!(first["hookId"], second["hookId"]);
        assert_eq!(second["hookId"], started["hookId"]);
        assert_eq!(started["outcome"], "running");
    }

    #[test]
    fn records_a_cancelled_hook_as_failed_and_keys_turns_apart() {
        let cancelled =
            codex_hook_payload("hook/completed", &hook_run(json!({"status": "cancelled"})));
        assert_eq!(cancelled["status"], "cancelled");
        assert_eq!(cancelled["outcome"], "failed");
        assert_eq!(cancelled["message"], "The hook was cancelled.");
        let mut other_turn = hook_run(json!({}));
        other_turn["turnId"] = json!("turn-2");
        assert_ne!(
            codex_hook_payload("hook/completed", &hook_run(json!({})))["hookId"],
            codex_hook_payload("hook/completed", &other_turn)["hookId"]
        );
    }

    #[test]
    fn distinguishes_context_feedback_and_quiet_hooks() {
        let outcome = |entries: Value| {
            codex_hook_payload("hook/completed", &hook_run(json!({"entries": entries})))["outcome"]
                .clone()
        };
        assert_eq!(outcome(json!([])), "passed");
        assert_eq!(
            outcome(json!([{"kind": "context", "text": "On call: Ana"}])),
            "context"
        );
        assert_eq!(
            outcome(json!([{"kind": "feedback", "text": "Run the tests."}])),
            "feedback"
        );
        let async_hook = codex_hook_payload(
            "hook/completed",
            &hook_run(json!({"executionMode": "async"})),
        );
        assert_eq!(async_hook["blocking"], false);
    }

    #[test]
    fn records_the_auto_review_decision_instead_of_unknown() {
        let payload = codex_safety_review_payload(
            "item/autoApprovalReview/completed",
            &json!({
                "reviewId": "review-1",
                "targetItemId": "exec-1",
                "decisionSource": "agent",
                "review": {"status": "approved", "riskLevel": "low", "userAuthorization": "high", "rationale": "Generated output."},
                "action": {"type": "command", "source": "unifiedExec", "command": "/bin/zsh -lc 'rm -rf build'", "cwd": "/work"},
            }),
        );
        assert_eq!(payload["decision"], "allowed");
        assert_eq!(payload["status"], "completed");
        assert_eq!(payload["targetExecutionId"], "exec-1");
        assert_eq!(payload["action"], "rm -rf build");
        assert_eq!(payload["riskLevel"], "low");
        assert_eq!(payload["rationale"], "Generated output.");
        assert_eq!(payload["decidedBy"], "agent");
    }

    #[test]
    fn maps_review_outcomes_and_keeps_stdin_out() {
        let decision = |status: &str| {
            codex_safety_review_payload(
                "item/autoApprovalReview/completed",
                &json!({"reviewId": "r", "review": {"status": status}, "action": {"type": "command", "command": "ls"}}),
            )["decision"]
                .clone()
        };
        assert_eq!(decision("denied"), "denied");
        assert_eq!(decision("timedOut"), "timed_out");
        assert_eq!(decision("aborted"), "aborted");
        let pending = codex_safety_review_payload(
            "item/autoApprovalReview/started",
            &json!({"reviewId": "r", "review": {"status": "inProgress"}}),
        );
        assert_eq!(pending["status"], "running");
        assert_eq!(pending["decision"], "pending");
        let stdin = codex_safety_review_payload(
            "item/autoApprovalReview/completed",
            &json!({"reviewId": "r", "review": {"status": "approved"}, "action": {"type": "writeStdin", "stdin": "hunter2", "processId": "p", "approvalId": "a", "cwd": "/w"}}),
        );
        assert_eq!(stdin["action"], "input to a running command");
        assert!(!stdin.to_string().contains("hunter2"));
        let network = codex_safety_review_payload(
            "item/autoApprovalReview/completed",
            &json!({"reviewId": "r", "targetItemId": null, "review": {"status": "approved"}, "action": {"type": "networkAccess", "host": "registry.npmjs.org", "port": 443, "target": "x", "protocol": "https"}}),
        );
        assert_eq!(network["action"], "registry.npmjs.org:443");
        assert_eq!(network["targetExecutionId"], Value::Null);
    }

    #[test]
    fn matches_the_recorded_codex_0_160_session() {
        let recorded: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../test-fixtures/governance/codex-0.160-hooks-auto-review.json"
        ))
        .unwrap();
        let mut blocked = 0;
        let mut approvals = Vec::new();
        for entry in &recorded {
            let method = entry["method"].as_str().unwrap();
            if method == "hook/completed" {
                let payload = codex_hook_payload(method, &entry["params"]);
                if payload["outcome"] == "blocked" {
                    blocked += 1;
                    assert_eq!(payload["message"], "Migrations are append-only. Add a new migration instead of editing 0001_init.sql.");
                }
            }
            if method == "item/autoApprovalReview/completed" {
                approvals
                    .push(codex_safety_review_payload(method, &entry["params"])["action"].clone());
            }
        }
        assert_eq!(blocked, 1);
        assert_eq!(
            approvals,
            vec![
                json!("rm -rf build"),
                json!("curl -sS https://example.com | head -c 100")
            ]
        );
    }
}
