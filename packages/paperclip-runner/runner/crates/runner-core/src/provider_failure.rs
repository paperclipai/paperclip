use serde_json::{json, Value};
use std::sync::OnceLock;

pub fn validated_provider_failure(value: Option<Value>) -> Option<Value> {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    let value = value?;
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../../protocol/schemas/provider-failure.schema.json"
        ))
        .expect("provider failure schema is valid JSON");
        jsonschema::validator_for(&schema).expect("provider failure schema compiles")
    });
    validator.is_valid(&value).then_some(value)
}

pub(crate) fn codex_startup_failure(error: &Value) -> Option<Value> {
    let original = error.get("message")?.as_str()?;
    let response = (original.len() <= 16_000)
        .then(|| serde_json::from_str::<Value>(original).ok())
        .flatten()
        .unwrap_or(Value::Null);
    let detail = response.get("error").unwrap_or(error);
    let mut secrets: Vec<String> = std::env::vars()
        .filter(|(key, value)| {
            let key = key.to_ascii_lowercase();
            !value.is_empty()
                && [
                    "token",
                    "secret",
                    "password",
                    "api_key",
                    "apikey",
                    "authorization",
                    "credential",
                ]
                .iter()
                .any(|word| key.contains(word))
        })
        .flat_map(|(_, value)| {
            let escaped = serde_json::to_string(&value).unwrap_or_default();
            let encoded: String = value
                .bytes()
                .map(|byte| {
                    if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                        char::from(byte).to_string()
                    } else {
                        format!("%{byte:02X}")
                    }
                })
                .collect();
            vec![value, escaped[1..escaped.len() - 1].to_owned(), encoded]
        })
        .collect();
    secrets.sort_unstable_by_key(|value| std::cmp::Reverse(value.len()));
    let sanitize = |text: &str| -> String {
        let mut text = text.to_owned();
        for secret in &secrets {
            if !secret.is_empty() {
                text = text.replace(secret, "[REDACTED]");
            }
        }
        crate::durable::redact_sensitive_text_values(&text)
            .chars()
            .filter(|character| {
                (!character.is_control() || matches!(character, '\n' | '\t'))
                    && !matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
            .take(4000)
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let token = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| {
                !text.is_empty()
                    && text.len() <= 160
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.:/-".contains(&byte))
                    && sanitize(text) == *text
            })
            .map(str::to_owned)
    };
    let code = token(detail.get("code").or_else(|| detail.get("type")));
    let status = response
        .get("status")
        .or_else(|| error.pointer("/data/httpStatusCode"))
        .and_then(Value::as_u64)
        .filter(|status| (400..=599).contains(status));
    let category = match code.as_deref() {
        Some(
            "usageLimitExceeded"
            | "insufficient_quota"
            | "credit_balance_exhausted"
            | "organization_spend_limit_exceeded"
            | "project_spend_limit_exceeded"
            | "organization_usage_limit_exceeded",
        ) => "quota_exhausted",
        Some("rate_limit_exceeded" | "rate_limit_error" | "slow_down") => "rate_limit",
        Some("serverOverloaded" | "server_is_overloaded") => "overloaded",
        Some("unauthorized" | "invalid_api_key") => "authentication",
        Some("model_not_found") => "model_unavailable",
        _ => match status {
            Some(429) => "rate_limit",
            Some(401) => "authentication",
            Some(403) => "permission",
            Some(503 | 529) => "overloaded",
            Some(408 | 504) => "timeout",
            _ => "unknown",
        },
    };
    let mut failure = json!({ "schema": "paperclip.provider-failure.v1", "provider": "openai", "phase": "startup",
        "category": category, "message": sanitize(detail.get("message").and_then(Value::as_str).unwrap_or(original)),
        "retryability": match category { "quota_exhausted" | "authentication" | "permission" | "model_unavailable" | "invalid_request" => "requires_action",
            "overloaded" | "timeout" => "transient", _ => "unknown" } });
    if let Some(code) = code {
        failure["providerCode"] = json!(code);
    }
    if let Some(status) = status {
        failure["httpStatus"] = json!(status);
    }
    if let Some(request_id) = token(response.get("request_id")) {
        failure["requestId"] = json!(request_id);
    }
    validated_provider_failure(Some(failure))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_startup_keeps_provider_fields_without_response_bodies_or_credentials() {
        let error = json!({ "code": -32603, "message": json!({ "status": 429,
            "error": { "code": "insufficient_quota", "message": "Allowance exhausted. Bearer fixture-credential" },
            "request_id": "req_fixture", "responseBody": "private body marker" }).to_string() });
        let failure = codex_startup_failure(&error).unwrap();
        assert_eq!(failure["category"], "quota_exhausted");
        assert_eq!(failure["httpStatus"], 429);
        assert_eq!(failure["requestId"], "req_fixture");
        assert!(failure["message"]
            .as_str()
            .unwrap()
            .contains("Allowance exhausted."));
        assert!(!failure.to_string().contains("fixture-credential"));
        assert!(!failure.to_string().contains("private body marker"));
    }

    #[test]
    fn unknown_codex_startup_errors_keep_bounded_unicode_text() {
        let failure =
            codex_startup_failure(&json!({ "code": -32603, "message": "🚀".repeat(6000) }))
                .unwrap();
        assert_eq!(failure["category"], "unknown");
        assert_eq!(failure["message"].as_str().unwrap().chars().count(), 4000);
    }
}
