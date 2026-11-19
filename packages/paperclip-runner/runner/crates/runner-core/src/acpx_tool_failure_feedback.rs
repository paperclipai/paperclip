//! Provider-facing feedback for a refused ACPX semantic tool call.
//!
//! A failed result can hold dispatcher payloads, request echoes and server
//! diagnostics, so it never crosses the sidecar boundary as is. Only these
//! parts are copied, each checked against a fixed shape:
//!
//! - a stable error code, such as `paperclip_runner_tool_input_invalid`;
//! - for a validation refusal, each failing field path with its rule and
//!   numeric limit, such as `payload.prompt: too_big, string max 1000`.
//!
//! Free-text messages, the value the agent sent and every part of a server
//! error (status 5xx) stay behind. Anything else gets the generic message.

use serde_json::Value;

pub(crate) const GENERIC_SEMANTIC_FAILURE: &str = "Paperclip semantic operation failed";

const MAX_ISSUES: usize = 5;
const MAX_PATH_SEGMENTS: usize = 8;
const MAX_SEGMENT_CHARS: usize = 64;
const MAX_CODE_CHARS: usize = 96;
const MAX_RULE_CHARS: usize = 48;
const MAX_SEARCH_DEPTH: usize = 4;
const MAX_LIMIT: f64 = 1e15;
// Keys that wrap a refusal in the dispatcher, runner API and HTTP error shapes.
const NESTED_KEYS: [&str; 5] = ["error", "data", "details", "issues", "result"];
const TYPE_NAMES: [&str; 9] = [
    "string", "array", "number", "int", "bigint", "set", "file", "date", "object",
];

pub(crate) fn semantic_failure_feedback(result: &Value) -> String {
    let result = parsed_text_envelope(result).unwrap_or_else(|| result.clone());
    if reports_server_error(&result, 0) {
        return GENERIC_SEMANTIC_FAILURE.to_owned();
    }
    let code = find_code(&result, 0);
    let issues = find_issues(&result, 0).unwrap_or_default();
    let mut parts = Vec::new();
    if let Some(code) = code {
        parts.push(code);
    }
    if !issues.is_empty() {
        let mut rendered = issues
            .iter()
            .take(MAX_ISSUES)
            .map(render_issue)
            .collect::<Vec<_>>()
            .join("; ");
        if issues.len() > MAX_ISSUES {
            rendered.push_str(&format!("; {} more", issues.len() - MAX_ISSUES));
        }
        parts.push(format!("invalid input: {rendered}"));
    }
    if parts.is_empty() {
        GENERIC_SEMANTIC_FAILURE.to_owned()
    } else {
        format!("{GENERIC_SEMANTIC_FAILURE}: {}", parts.join("; "))
    }
}

/// A thrown error reaches runnerd as `{success:false, contentItems:[text]}`.
/// Its text is either JSON (a zod issue list) or a message that may start
/// with a stable code (`code: explanation`).
fn parsed_text_envelope(result: &Value) -> Option<Value> {
    let text = envelope_text(result)?;
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if parsed.is_object() || parsed.is_array() {
            return Some(parsed);
        }
    }
    let prefix = text.split(':').next().unwrap_or_default().trim();
    is_code(prefix).then(|| serde_json::json!({ "error": prefix }))
}

fn envelope_text(result: &Value) -> Option<&str> {
    result
        .get("contentItems")?
        .as_array()?
        .first()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("inputText"))?
        .get("text")?
        .as_str()
}

fn nested(value: &Value) -> impl Iterator<Item = &Value> {
    NESTED_KEYS.iter().filter_map(|key| value.get(*key))
}

fn reports_server_error(value: &Value, depth: usize) -> bool {
    if depth > MAX_SEARCH_DEPTH || !value.is_object() {
        return false;
    }
    let status = value.get("status").and_then(Value::as_u64);
    status.is_some_and(|status| status >= 500)
        || nested(value).any(|child| reports_server_error(child, depth + 1))
}

fn find_code(value: &Value, depth: usize) -> Option<String> {
    if depth > MAX_SEARCH_DEPTH || !value.is_object() {
        return None;
    }
    for key in ["code", "error"] {
        if let Some(code) = value
            .get(key)
            .and_then(Value::as_str)
            .filter(|code| is_code(code))
        {
            return Some(code.to_owned());
        }
    }
    nested(value).find_map(|child| find_code(child, depth + 1))
}

fn find_issues(value: &Value, depth: usize) -> Option<Vec<&Value>> {
    if depth > MAX_SEARCH_DEPTH {
        return None;
    }
    if let Some(items) = value.as_array() {
        let issues = items
            .iter()
            .filter(|item| is_issue(item))
            .collect::<Vec<_>>();
        return (!issues.is_empty() && issues.len() == items.len()).then_some(issues);
    }
    if !value.is_object() {
        return None;
    }
    nested(value).find_map(|child| find_issues(child, depth + 1))
}

fn is_issue(value: &Value) -> bool {
    value.get("path").is_some_and(Value::is_array)
        && value.get("code").and_then(Value::as_str).is_some()
}

fn render_issue(issue: &&Value) -> String {
    let path = render_path(issue.get("path").and_then(Value::as_array));
    let rule = issue
        .get("code")
        .and_then(Value::as_str)
        .filter(|rule| is_rule(rule))
        .unwrap_or("invalid");
    let origin = ["origin", "type"]
        .iter()
        .filter_map(|key| issue.get(*key).and_then(Value::as_str))
        .find(|name| TYPE_NAMES.contains(name));
    let limit = [("maximum", "max"), ("minimum", "min")]
        .iter()
        .find_map(|(key, label)| render_limit(issue.get(*key)?).map(|limit| (*label, limit)));
    let mut rendered = format!("{path}: {rule}");
    match (origin, limit) {
        (Some(origin), Some((label, limit))) => {
            rendered.push_str(&format!(", {origin} {label} {limit}"))
        }
        (None, Some((label, limit))) => rendered.push_str(&format!(", {label} {limit}")),
        _ => {}
    }
    if rule == "invalid_type" {
        if let Some(expected) = issue
            .get("expected")
            .and_then(Value::as_str)
            .filter(|expected| is_rule(expected))
        {
            rendered.push_str(&format!(", expected {expected}"));
        }
    }
    rendered
}

fn render_path(path: Option<&Vec<Value>>) -> String {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return "(input)".to_owned();
    };
    let mut rendered = String::new();
    for segment in path.iter().take(MAX_PATH_SEGMENTS) {
        match segment {
            Value::Number(index) if index.as_u64().is_some() => {
                rendered.push_str(&format!("[{}]", index.as_u64().unwrap_or_default()));
            }
            Value::String(key) if is_path_key(key) => {
                if !rendered.is_empty() {
                    rendered.push('.');
                }
                rendered.push_str(key);
            }
            _ => {
                if !rendered.is_empty() {
                    rendered.push('.');
                }
                rendered.push('*');
            }
        }
    }
    if path.len() > MAX_PATH_SEGMENTS {
        rendered.push_str(".…");
    }
    rendered
}

fn render_limit(value: &Value) -> Option<String> {
    let limit = value
        .as_f64()
        .filter(|limit| limit.is_finite() && limit.abs() <= MAX_LIMIT)?;
    Some(if limit.fract() == 0.0 {
        format!("{}", limit as i64)
    } else {
        format!("{limit}")
    })
}

fn is_path_key(key: &str) -> bool {
    let mut chars = key.chars();
    key.chars().count() <= MAX_SEGMENT_CHARS
        && chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|char| char.is_ascii_alphanumeric() || char == '_' || char == '-')
}

/// A lowercase rule name, such as `too_big` or `invalid_type`.
fn is_rule(rule: &str) -> bool {
    let mut chars = rule.chars();
    rule.len() <= MAX_RULE_CHARS
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '_')
}

/// A stable machine code: lowercase words joined by `_`, `.` or `-`. A single
/// word is refused, so a free-text message such as `Forbidden` never passes.
fn is_code(code: &str) -> bool {
    let separated = code.contains(['_', '.', '-']);
    let mut chars = code.chars();
    separated
        && code.len() <= MAX_CODE_CHARS
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|char| {
            char.is_ascii_lowercase() || char.is_ascii_digit() || matches!(char, '_' | '.' | '-')
        })
        && !code.ends_with(['_', '.', '-'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_each_failing_field_and_rule_from_a_zod_issue_list() {
        let feedback = semantic_failure_feedback(&json!([
            {"origin":"string","code":"too_big","maximum":1000,"inclusive":true,
             "path":["payload","prompt"],"message":"Too big: secret-value-1"},
            {"code":"invalid_type","expected":"string","path":["title"],
             "message":"Invalid input: expected string, received secret-value-2"},
            {"code":"too_small","origin":"array","minimum":1,"path":["payload","questions",0,"options"]},
        ]));
        assert_eq!(
            feedback,
            "Paperclip semantic operation failed: invalid input: \
             payload.prompt: too_big, string max 1000; title: invalid_type, expected string; \
             payload.questions[0].options: too_small, array min 1"
        );
        assert!(!feedback.contains("secret-value"));
    }

    #[test]
    fn reads_a_zod_issue_list_left_as_envelope_text() {
        let text = json!([{"code":"too_big","maximum":240,"path":["idempotencyKey"]}]).to_string();
        let feedback = semantic_failure_feedback(&json!({
            "success":false,"contentItems":[{"type":"inputText","text":text}],
        }));
        assert_eq!(
            feedback,
            "Paperclip semantic operation failed: invalid input: idempotencyKey: too_big, max 240"
        );
    }

    #[test]
    fn keeps_only_the_stable_code_of_a_refusal_message() {
        let feedback = semantic_failure_feedback(&json!({
            "success":false,
            "contentItems":[{"type":"inputText",
                "text":"paperclip_runner_agent_not_found: no agent has id \"secret-value\"."}],
        }));
        assert_eq!(
            feedback,
            "Paperclip semantic operation failed: paperclip_runner_agent_not_found"
        );
    }

    #[test]
    fn reports_dispatcher_and_runner_api_codes() {
        assert_eq!(
            semantic_failure_feedback(&json!({
                "ok":false,"operationId":"get_task_history","callId":"call-1",
                "error":{"code":"input_invalid","message":"The requested semantic action was not executed.","retryable":false},
            })),
            "Paperclip semantic operation failed: input_invalid"
        );
        assert_eq!(
            semantic_failure_feedback(&json!({
                "ok":false,"status":422,"error":"api_redirect_not_followed",
                "data":{"error":"Validation error","details":[{"code":"too_big","maximum":5,"path":["limit"]}]},
            })),
            "Paperclip semantic operation failed: api_redirect_not_followed; invalid input: limit: too_big, max 5"
        );
    }

    #[test]
    fn hides_server_errors_and_free_text() {
        for result in [
            json!({"ok":false,"status":500,"error":"database_unavailable",
                "data":{"details":[{"code":"too_big","maximum":5,"path":["limit"]}]}}),
            json!({"ok":false,"error":{"status":503,"code":"upstream_failed"}}),
            json!({"success":false,"contentItems":[{"type":"inputText","text":"Forbidden for secret-value"}]}),
            json!({"diagnostic":"violet-internal-diagnostic-4821","request":{"private":"value"}}),
            json!("plain string"),
            json!([{"path":["a"],"code":"too_big"}, "secret-value"]),
        ] {
            assert_eq!(
                semantic_failure_feedback(&result),
                GENERIC_SEMANTIC_FAILURE,
                "{result}"
            );
        }
    }

    #[test]
    fn masks_path_keys_and_rules_that_do_not_look_like_names() {
        let long_key = "k".repeat(MAX_SEGMENT_CHARS + 1);
        let feedback = semantic_failure_feedback(&json!([
            {"code":"Custom message with secret-value","path":["metadata","has space", long_key, 2]},
        ]));
        assert_eq!(
            feedback,
            "Paperclip semantic operation failed: invalid input: metadata.*.*[2]: invalid"
        );
    }

    #[test]
    fn bounds_the_issue_count_and_path_depth() {
        let issues = (0..7)
            .map(|index| json!({"code":"invalid_type","path":[format!("f{index}")]}))
            .collect::<Vec<_>>();
        let feedback = semantic_failure_feedback(&Value::Array(issues));
        assert!(feedback.ends_with("f4: invalid_type; 2 more"), "{feedback}");

        let deep = json!([{"code":"invalid_type","path":["a","b","c","d","e","f","g","h","i"]}]);
        assert_eq!(
            semantic_failure_feedback(&deep),
            "Paperclip semantic operation failed: invalid input: a.b.c.d.e.f.g.h.…: invalid_type"
        );
    }
}
