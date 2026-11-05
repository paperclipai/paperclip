//! Provider rate-limit windows normalized into one account-scoped snapshot and
//! carried as a `provider.notice.recorded` event (category
//! `provider.rate_limits`). The control plane keeps the latest snapshot per
//! agent; transcripts treat the notice as run-log only. Mirrors
//! `src/drivers/provider-rate-limits.ts` and `@paperclipai/shared`
//! `provider-rate-limits.ts` (schema `paperclip.provider.rate_limits.v1`).

use serde_json::{json, Map, Value};

use crate::durable::EventPriority;
use crate::provider_events::NormalizedProviderEvent;

pub const PROVIDER_RATE_LIMITS_CATEGORY: &str = "provider.rate_limits";
pub const PROVIDER_RATE_LIMITS_SCHEMA: &str = "paperclip.provider.rate_limits.v1";
const MAX_WINDOWS: usize = 8;
const MAX_DETAIL_CHARS: usize = 4_000;

fn bounded(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(max).collect())
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite())
}

fn percent(value: Option<f64>) -> Value {
    match value {
        Some(value) => json!((value.clamp(0.0, 1000.0) * 10.0).round() / 10.0),
        None => Value::Null,
    }
}

fn epoch_seconds_iso(value: Option<&Value>) -> Value {
    use aws_smithy_types::{date_time::Format, DateTime};
    let Some(seconds) = finite(value).filter(|seconds| *seconds > 0.0) else {
        return Value::Null;
    };
    DateTime::from_secs(seconds as i64)
        .fmt(Format::DateTime)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

pub fn now_iso() -> String {
    use aws_smithy_types::{date_time::Format, DateTime};
    DateTime::from(std::time::SystemTime::now())
        .fmt(Format::DateTime)
        .unwrap_or_default()
}

fn window_labels(minutes: Option<i64>) -> (String, String) {
    match minutes {
        None => ("Usage window".to_owned(), "Usage".to_owned()),
        Some(minutes) if minutes % 10_080 == 0 => {
            let weeks = minutes / 10_080;
            if weeks == 1 {
                ("Weekly".to_owned(), "7d".to_owned())
            } else {
                (format!("{weeks}-week window"), format!("{}d", weeks * 7))
            }
        }
        Some(minutes) if minutes % 1_440 == 0 => {
            let days = minutes / 1_440;
            let label = if days == 1 { "Daily".to_owned() } else { format!("{days}-day window") };
            (label, format!("{days}d"))
        }
        Some(minutes) if minutes % 60 == 0 => {
            let hours = minutes / 60;
            (format!("{hours}-hour window"), format!("{hours}h"))
        }
        Some(minutes) => (format!("{minutes}-minute window"), format!("{minutes}m")),
    }
}

fn codex_window(limit_id: Option<&str>, limit_name: Option<&str>, slot: &str, raw: &Value) -> Option<Value> {
    let window = raw.as_object()?;
    let minutes = finite(window.get("windowDurationMins"))
        .filter(|minutes| *minutes > 0.0)
        .map(|minutes| minutes.round() as i64);
    let (label, short) = window_labels(minutes);
    let scoped = limit_id.filter(|id| *id != "codex");
    let scope = scoped.map(|id| limit_name.unwrap_or(id));
    Some(json!({
        "id": format!("{}.{slot}", scoped.unwrap_or("codex")),
        "label": scope.map_or(label.clone(), |scope| format!("{label} ({scope})")),
        "shortLabel": scope.map_or(short.clone(), |scope| format!("{short} {scope}")),
        "windowMinutes": minutes,
        "usedPercent": percent(finite(window.get("usedPercent"))),
        "resetsAt": epoch_seconds_iso(window.get("resetsAt")),
        "status": Value::Null,
    }))
}

fn used(window: &Value) -> f64 {
    window.get("usedPercent").and_then(Value::as_f64).unwrap_or(-1.0)
}

/// Merge a sparse update: windows by id; null fields never clear a known value.
fn merge(previous: Option<&Value>, mut next: Value) -> Value {
    let Some(previous) = previous.filter(|previous| previous["provider"] == next["provider"]) else {
        return next;
    };
    let mut windows: Vec<Value> = previous["windows"].as_array().cloned().unwrap_or_default();
    for window in next["windows"].as_array().cloned().unwrap_or_default() {
        if let Some(prior) = windows.iter_mut().find(|prior| prior["id"] == window["id"]) {
            let mut merged = window.clone();
            for key in ["usedPercent", "resetsAt", "windowMinutes", "status"] {
                if merged[key].is_null() {
                    merged[key] = prior[key].clone();
                }
            }
            *prior = merged;
        } else {
            windows.push(window);
        }
    }
    windows.truncate(MAX_WINDOWS);
    next["windows"] = Value::Array(windows);
    if next["credits"].is_null() {
        next["credits"] = previous["credits"].clone();
    }
    next
}

/// Normalize Codex `account/rateLimits/updated`, merged into the previous snapshot.
pub fn codex_rate_limit_snapshot(params: &Value, previous: Option<&Value>, observed_at: &str) -> Option<Value> {
    let snapshot = params.get("rateLimits")?.as_object()?;
    let limit_id = bounded(snapshot.get("limitId"), 160);
    let limit_name = bounded(snapshot.get("limitName"), 160);
    let windows: Vec<Value> = ["primary", "secondary"]
        .iter()
        .filter_map(|slot| {
            codex_window(limit_id.as_deref(), limit_name.as_deref(), slot, snapshot.get(*slot)?)
        })
        .collect();
    let credits = snapshot.get("credits").and_then(Value::as_object).map(|credits| {
        json!({
            "hasCredits": credits.get("hasCredits").and_then(Value::as_bool),
            "unlimited": credits.get("unlimited").and_then(Value::as_bool),
            "balance": bounded(credits.get("balance"), 40),
        })
    });
    let reason = bounded(snapshot.get("rateLimitReachedType"), 160);
    let mut merged = merge(
        previous,
        json!({
            "schema": PROVIDER_RATE_LIMITS_SCHEMA,
            "provider": "openai",
            "windows": windows,
            "credits": credits,
            "limitReached": Value::Null,
            "observedAt": observed_at,
        }),
    );
    let windows = merged["windows"].as_array().cloned().unwrap_or_default();
    if windows.is_empty() && merged["credits"].is_null() && reason.is_none() {
        return None;
    }
    let fullest = windows.iter().max_by(|a, b| used(a).total_cmp(&used(b))).cloned();
    let exhausted = windows.iter().find(|window| used(window) >= 100.0).cloned();
    let reached = if reason.is_some() { fullest } else { exhausted.clone() };
    if reason.is_some() || exhausted.is_some() {
        merged["limitReached"] = json!({
            "windowId": reached.as_ref().map(|window| window["id"].clone()),
            "reason": reason.unwrap_or_else(|| "rate_limit_reached".to_owned()),
            "resetsAt": reached.as_ref().map_or(Value::Null, |window| window["resetsAt"].clone()),
        });
    }
    Some(merged)
}

/// Normalize Claude's sanitized `_claude/rateLimit` (SDK rate_limit_info).
/// Claude reports one window per event; the control plane merges by window.
pub fn claude_rate_limit_snapshot(info: &Value, observed_at: &str) -> Option<Value> {
    let info = info.as_object()?;
    let kind = bounded(info.get("rateLimitType"), 64).unwrap_or_else(|| "five_hour".to_owned());
    let (label, short, minutes): (String, String, Option<i64>) = match kind.as_str() {
        "five_hour" => ("5-hour window".into(), "5h".into(), Some(300)),
        "seven_day" => ("Weekly".into(), "7d".into(), Some(10_080)),
        "seven_day_opus" => ("Weekly (Opus)".into(), "7d Opus".into(), Some(10_080)),
        "seven_day_sonnet" => ("Weekly (Sonnet)".into(), "7d Sonnet".into(), Some(10_080)),
        "seven_day_overage_included" => ("Weekly (with extra usage)".into(), "7d".into(), Some(10_080)),
        "overage" => ("Extra usage".into(), "Extra".into(), None),
        other => (other.replace('_', " "), other.to_owned(), None),
    };
    let status = match info.get("status").and_then(Value::as_str) {
        Some("allowed") => Some("allowed"),
        Some("allowed_warning") => Some("warning"),
        Some("rejected") => Some("rejected"),
        _ => None,
    };
    let utilization = finite(info.get("utilization"));
    let used_percent = match (status, utilization) {
        (Some("rejected"), None) => json!(100.0),
        (_, value) => percent(value.map(|value| value * 100.0)),
    };
    let id = format!("claude.{kind}");
    let resets_at = epoch_seconds_iso(info.get("resetsAt"));
    let limit_reached = if status == Some("rejected") {
        json!({"windowId": id, "reason": "rate_limit_reached", "resetsAt": resets_at})
    } else {
        Value::Null
    };
    Some(json!({
        "schema": PROVIDER_RATE_LIMITS_SCHEMA,
        "provider": "anthropic",
        "windows": [{
            "id": id, "label": label, "shortLabel": short, "windowMinutes": minutes,
            "usedPercent": used_percent, "resetsAt": resets_at, "status": status,
        }],
        "credits": Value::Null,
        "limitReached": limit_reached,
        "observedAt": observed_at,
    }))
}

/// True when the content differs, ignoring the observation time.
pub fn rate_limit_snapshot_changed(previous: Option<&Value>, next: &Value) -> bool {
    let strip = |value: &Value| {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() {
            object.remove("observedAt");
        }
        value
    };
    previous.is_none_or(|previous| strip(previous) != strip(next))
}

fn summary(snapshot: &Value) -> String {
    let harness = if snapshot["provider"] == "openai" { "Codex" } else { "Claude" };
    let windows = snapshot["windows"].as_array().cloned().unwrap_or_default();
    if let Some(reached) = snapshot["limitReached"].as_object() {
        let label = windows
            .iter()
            .find(|window| Some(&window["id"]) == reached.get("windowId"))
            .and_then(|window| window["label"].as_str())
            .map(|label| format!(" ({label})"))
            .unwrap_or_default();
        let reset = reached
            .get("resetsAt")
            .and_then(Value::as_str)
            .map(|at| format!("; resets {at}"))
            .unwrap_or_default();
        return format!("{harness} rate limit reached{label}{reset}");
    }
    let parts: Vec<String> = windows
        .iter()
        .filter_map(|window| Some(format!("{} {}%", window["label"].as_str()?, window["usedPercent"].as_f64()?)))
        .collect();
    if parts.is_empty() {
        format!("{harness} rate limits updated")
    } else {
        format!("{harness} rate limits: {}", parts.join(", "))
    }
}

/// The notice event carrying `snapshot` as one JSON detail (kept whole under the cap).
pub fn rate_limit_notice(snapshot: &Value, notice_id: &str) -> NormalizedProviderEvent {
    let mut bounded_snapshot = snapshot.clone();
    let mut serialized = bounded_snapshot.to_string();
    while serialized.chars().count() > MAX_DETAIL_CHARS {
        let Some(windows) = bounded_snapshot["windows"].as_array_mut().filter(|w| !w.is_empty()) else {
            break;
        };
        windows.pop();
        serialized = bounded_snapshot.to_string();
    }
    let mut payload = Map::new();
    payload.insert("schema".into(), json!("paperclip.provider.notice.v1"));
    payload.insert("noticeId".into(), json!(notice_id));
    payload.insert(
        "severity".into(),
        json!(if snapshot["limitReached"].is_null() { "info" } else { "warning" }),
    );
    payload.insert("category".into(), json!(PROVIDER_RATE_LIMITS_CATEGORY));
    payload.insert("scope".into(), json!("account"));
    payload.insert("recoverable".into(), json!(true));
    payload.insert("userActionable".into(), json!(false));
    payload.insert("summary".into(), json!(summary(snapshot).chars().take(4_000).collect::<String>()));
    payload.insert("details".into(), json!([{"name": "rateLimits", "value": serialized}]));
    NormalizedProviderEvent {
        event_type: "provider.notice.recorded".to_owned(),
        priority: EventPriority::P1,
        payload: Value::Object(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: &str = "2026-11-05T15:00:00Z";
    const RESETS: i64 = 1_793_893_200; // 2026-11-05T15:40:00Z

    #[test]
    fn codex_snapshot_merges_sparse_updates_and_marks_reached() {
        let first = codex_rate_limit_snapshot(
            &json!({"rateLimits": {"limitId": "codex",
                "primary": {"usedPercent": 78, "windowDurationMins": 300, "resetsAt": RESETS},
                "secondary": {"usedPercent": 41, "windowDurationMins": 10080, "resetsAt": RESETS + 86_400},
                "credits": {"hasCredits": true, "unlimited": false, "balance": "12.40"}}}),
            None,
            T0,
        )
        .unwrap();
        assert_eq!(first["windows"][0]["label"], "5-hour window");
        assert_eq!(first["windows"][0]["resetsAt"], "2026-11-05T15:40:00Z");
        assert_eq!(first["windows"][1]["shortLabel"], "7d");
        assert!(first["limitReached"].is_null());

        let second = codex_rate_limit_snapshot(
            &json!({"rateLimits": {"limitId": "codex",
                "primary": {"usedPercent": 100, "windowDurationMins": null, "resetsAt": null},
                "rateLimitReachedType": "rate_limit_reached"}}),
            Some(&first),
            T0,
        )
        .unwrap();
        assert_eq!(second["windows"][0]["usedPercent"], 100.0);
        assert_eq!(second["windows"][0]["windowMinutes"], 300);
        assert_eq!(second["windows"][1]["usedPercent"], 41.0);
        assert_eq!(second["credits"]["balance"], "12.40");
        assert_eq!(second["limitReached"]["windowId"], "codex.primary");
        assert_eq!(second["limitReached"]["resetsAt"], "2026-11-05T15:40:00Z");
        assert!(rate_limit_snapshot_changed(Some(&first), &second));
        let mut same = second.clone();
        same["observedAt"] = json!("2026-11-05T16:00:00Z");
        assert!(!rate_limit_snapshot_changed(Some(&second), &same));
    }

    #[test]
    fn codex_empty_update_is_ignored() {
        assert!(codex_rate_limit_snapshot(&json!({"rateLimits": {"primary": null}}), None, T0).is_none());
        assert!(codex_rate_limit_snapshot(&json!({}), None, T0).is_none());
    }

    #[test]
    fn claude_snapshot_maps_utilization_and_rejection() {
        let warn = claude_rate_limit_snapshot(
            &json!({"status": "allowed_warning", "rateLimitType": "five_hour", "utilization": 0.86, "resetsAt": RESETS}),
            T0,
        )
        .unwrap();
        assert_eq!(warn["windows"][0]["usedPercent"], 86.0);
        assert_eq!(warn["windows"][0]["status"], "warning");
        assert!(warn["limitReached"].is_null());
        let rejected = claude_rate_limit_snapshot(&json!({"status": "rejected", "rateLimitType": "seven_day"}), T0).unwrap();
        assert_eq!(rejected["windows"][0]["usedPercent"], 100.0);
        assert_eq!(rejected["limitReached"]["windowId"], "claude.seven_day");
    }

    #[test]
    fn notice_carries_snapshot_as_json_detail() {
        let snapshot = claude_rate_limit_snapshot(&json!({"status": "allowed", "utilization": 0.5}), T0).unwrap();
        let event = rate_limit_notice(&snapshot, "turn-1:rate-limits");
        assert_eq!(event.event_type, "provider.notice.recorded");
        assert_eq!(event.payload["category"], PROVIDER_RATE_LIMITS_CATEGORY);
        assert_eq!(event.payload["scope"], "account");
        assert_eq!(event.payload["summary"], "Claude rate limits: 5-hour window 50%");
        let detail: Value = serde_json::from_str(event.payload["details"][0]["value"].as_str().unwrap()).unwrap();
        assert_eq!(detail, snapshot);
    }
}
