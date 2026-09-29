//! Lossless, credential-scrubbed output, carried in independently bounded frames.
//! The preview is display-only. Chunks precede its reference and share the
//! authenticated run/session envelope; neither grants mutation authority.
use crate::durable::{redact_output_text, DurableRunnerError, EventPriority};
use crate::provider_events::NormalizedProviderEvent;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CAPABILITY: &str = "history.output_bodies.v1";
pub const CHUNK_BYTES: usize = 32 * 1024 - 2;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn add_codex_body(method: &str, params: &Value, events: &mut Vec<NormalizedProviderEvent>) {
    let text = match method {
        "item/agentMessage/delta" | "item/commandExecution/outputDelta" => params.get("delta"),
        "item/started" | "item/completed" => params
            .pointer("/item/text")
            .or_else(|| params.pointer("/item/aggregatedOutput"))
            .or_else(|| params.pointer("/item/output")),
        _ => None,
    }
    .and_then(Value::as_str);
    let Some(text) = text.filter(|text| text.len() > 4_000) else {
        return;
    };
    if events.is_empty() {
        return;
    }
    // Admission already bounded the provider frame. Redact before splitting so
    // a credential crossing a chunk boundary cannot escape the scrubber.
    let safe = redact_output_text(text);
    let mut chunks = Vec::new();
    let mut rest = safe.as_str();
    while !rest.is_empty() {
        let mut end = rest.len().min(CHUNK_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        // Include JSON escaping in the per-frame budget (e.g. NUL or controls).
        while serde_json::to_vec(&rest[..end])
            .expect("text serializes")
            .len()
            > 32 * 1024
        {
            end /= 2;
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
        }
        // Scrubbing is idempotent; apply it to the independently readable chunk
        // as well, including credential-like suffixes produced by the split.
        chunks.push(redact_output_text(&rest[..end]));
        rest = &rest[end..];
    }
    let mut hash = Sha256::new();
    let mut length = 0usize;
    for chunk in &chunks {
        hash.update(chunk.as_bytes());
        length += chunk.len();
    }
    let sha = format!("{:x}", hash.finalize());
    let reference = json!({"schema":"paperclip.output.body.v1", "bodyId":sha,
        "sha256":sha, "byteLength":length.to_string(), "mediaType":"text/plain; charset=utf-8"});
    events[0].payload["outputBody"] = reference.clone();
    let mut prefix = Vec::with_capacity(chunks.len() + events.len());
    let mut offset = 0usize;
    for chunk in chunks {
        prefix.push(NormalizedProviderEvent {
            event_type: "output.body.chunk".into(),
            priority: EventPriority::P1,
            payload: json!({"schema":"paperclip.output.body.chunk.v1", "body":reference,
                "offset":offset.to_string(), "sha256":digest(chunk.as_bytes()), "text":chunk}),
        });
        offset += chunk.len();
    }
    prefix.append(events);
    *events = prefix;
}

pub fn sanitize_chunk(payload: &Value) -> Result<Value, DurableRunnerError> {
    let invalid = || DurableRunnerError::invalid("invalid durable output body chunk");
    let body = payload.get("body").ok_or_else(invalid)?;
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let integer = |value: Option<&Value>| -> Result<usize, DurableRunnerError> {
        let s = value.and_then(Value::as_str).ok_or_else(invalid)?;
        let n = s.parse::<usize>().map_err(|_| invalid())?;
        if n.to_string() != s {
            return Err(invalid());
        }
        Ok(n)
    };
    let offset = integer(payload.get("offset"))?;
    let length = integer(body.get("byteLength"))?;
    let sha = body
        .get("sha256")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if payload["schema"] != "paperclip.output.body.chunk.v1"
        || body["schema"] != "paperclip.output.body.v1"
        || body["mediaType"] != "text/plain; charset=utf-8"
        || body["bodyId"] != sha
        || sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || text.is_empty()
        || text.len() > CHUNK_BYTES
        || length > MAX_BODY_BYTES
        || offset
            .checked_add(text.len())
            .is_none_or(|end| end > length)
        || payload["sha256"] != digest(text.as_bytes())
        || redact_output_text(text) != text
        || payload.as_object().is_none_or(|o| o.len() != 5)
        || body.as_object().is_none_or(|o| o.len() != 5)
    {
        return Err(invalid());
    }
    Ok(payload.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_large_command_delta_without_waiting_for_completion() {
        let text = "tool-output-🌳".repeat(10_000);
        let params = json!({"itemId":"exec-1", "delta":text});
        let mut events = crate::provider_events::normalize_codex_notification(
            "item/commandExecution/outputDelta",
            &params,
        );
        add_codex_body("item/commandExecution/outputDelta", &params, &mut events);
        let last = events.last().unwrap();
        assert_eq!(last.event_type, "item.delta");
        assert_eq!(last.payload["kind"], "commandExecution");
        let mut body = String::new();
        for event in &events[..events.len() - 1] {
            sanitize_chunk(&event.payload).unwrap();
            body.push_str(event.payload["text"].as_str().unwrap());
        }
        assert_eq!(body, text);
        assert_eq!(
            last.payload["outputBody"]["sha256"],
            digest(body.as_bytes())
        );
    }

    #[test]
    fn chunks_preserve_large_unicode_output_and_scrub_boundary_credentials() {
        let text = format!(
            "{} api_key=super-secret-value {}",
            "🌳".repeat(8200),
            "z".repeat(25_000)
        );
        let mut events = vec![NormalizedProviderEvent {
            event_type: "item.completed".into(),
            priority: EventPriority::P1,
            payload: json!({"text":"preview"}),
        }];
        add_codex_body(
            "item/completed",
            &json!({"item":{"text":text}}),
            &mut events,
        );
        let mut output = String::new();
        for event in &events[..events.len() - 1] {
            sanitize_chunk(&event.payload).unwrap();
            assert_eq!(event.payload["offset"], output.len().to_string());
            assert!(serde_json::to_vec(&event.payload).unwrap().len() < 60_000);
            output.push_str(event.payload["text"].as_str().unwrap());
        }
        assert!(!output.contains("super-secret-value"));
        assert_eq!(output.matches('🌳').count(), 8200);
        assert_eq!(
            events.last().unwrap().payload["outputBody"]["sha256"],
            digest(output.as_bytes())
        );
        let mut altered = events[0].payload.clone();
        altered["text"] = json!("altered");
        assert!(sanitize_chunk(&altered).is_err());
    }
}
