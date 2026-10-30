use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use crate::durable::{
    durable_semantics_changed_by_sanitization, sanitize_bounded_display_value, DurableRunnerError,
};

const DISPATCH_BYTES: usize = 480 * 1024;
pub(crate) const OUTCOME_BYTES: usize = 501_024;

fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
fn bounded(value: &Value, limit: usize) -> Result<(), DurableRunnerError> {
    if serde_json::to_vec(value)
        .map_err(|_| invalid("external transport is not serializable"))?
        .len()
        > limit
    {
        return Err(invalid(
            "external provider payload exceeds its lossless transport budget",
        ));
    }
    Ok(())
}

fn event_validator(event_type: &str) -> Result<&'static jsonschema::Validator, DurableRunnerError> {
    static DISPATCH: OnceLock<Result<jsonschema::Validator, &'static str>> = OnceLock::new();
    static SETTLED: OnceLock<Result<jsonschema::Validator, &'static str>> = OnceLock::new();
    let cache = match event_type {
        "external_provider.dispatch_requested" => &DISPATCH,
        "external_provider.operation_settled" => &SETTLED,
        _ => return Err(invalid("external event schema is unavailable")),
    };
    cache
        .get_or_init(|| {
            let schema: Value = serde_json::from_str(include_str!(
                "../../../../protocol/schemas/event-v3.schema.json"
            ))
            .map_err(|_| "external event schema is invalid")?;
            let payload = schema["allOf"]
                .as_array()
                .and_then(|clauses| {
                    clauses.iter().find(|clause| {
                        clause
                            .pointer("/if/properties/eventType/const")
                            .and_then(Value::as_str)
                            == Some(event_type)
                    })
                })
                .and_then(|clause| clause.pointer("/then/properties/payload"))
                .ok_or("external event schema is unavailable")?;
            jsonschema::validator_for(payload).map_err(|_| "external event schema is invalid")
        })
        .as_ref()
        .map_err(|message| invalid(message))
}

fn event_schema(event_type: &str, value: &Value) -> Result<(), DurableRunnerError> {
    let validator = event_validator(event_type)?;
    if !validator.is_valid(value) {
        return Err(invalid("external event does not match its closed contract"));
    }
    Ok(())
}

pub(crate) fn event_payload(
    event_type: &str,
    value: &Value,
) -> Result<Option<Value>, DurableRunnerError> {
    if !matches!(
        event_type,
        "external_provider.dispatch_requested" | "external_provider.operation_settled"
    ) {
        return Ok(None);
    }
    event_schema(event_type, value)?;
    let limit = if event_type == "external_provider.operation_settled" {
        OUTCOME_BYTES + 4096
    } else {
        DISPATCH_BYTES
    };
    bounded(value, limit)?;
    let mut safe = sanitize_bounded_display_value(value);
    if event_type == "external_provider.operation_settled" {
        safe["outcome"] = outcome(&value["outcome"], None)?;
    }
    if durable_semantics_changed_by_sanitization(value, &safe) {
        return Err(invalid("external transport identity or validation semantics contain credential-shaped material"));
    }
    bounded(&safe, limit)?;
    event_schema(event_type, &safe)?;
    Ok(Some(safe))
}

pub(crate) fn outcome(
    value: &Value,
    command_tool: Option<&str>,
) -> Result<Value, DurableRunnerError> {
    bounded(value, OUTCOME_BYTES)?;
    let mut safe = sanitize_bounded_display_value(value);
    if value.get("operationId").and_then(Value::as_str) == Some("read_task_attachment") {
        if command_tool.is_some_and(|name| name != "read_task_attachment") {
            return Err(invalid(
                "attachment outcome does not match the admitted operation",
            ));
        }
        if value["status"] != "completed" || value["isError"] != false {
            return Err(invalid("attachment outcome is not a successful read"));
        }
        validate_attachment(&value["result"], None)?;
        safe["result"]["content"] = value["result"]["content"].clone();
    }
    if durable_semantics_changed_by_sanitization(value, &safe) {
        return Err(invalid(
            "external outcome identity or validation semantics contain credential-shaped material",
        ));
    }
    bounded(&safe, OUTCOME_BYTES)?;
    Ok(safe)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentPage {
    attachment_id: String,
    source_comment_id: Option<String>,
    filename: Option<String>,
    content_type: String,
    byte_size: u64,
    sha256: String,
    encoding: String,
    content: String,
    offset: u64,
    returned_bytes: u64,
    next_offset: Option<u64>,
    content_trust: String,
}

pub(crate) fn validate_attachment(
    value: &Value,
    input: Option<&Value>,
) -> Result<(), DurableRunnerError> {
    bounded(value, OUTCOME_BYTES)?;
    if value.as_object().is_none_or(|object| object.len() != 12) {
        return Err(invalid(
            "attachment result must include all pagination metadata",
        ));
    }
    let page: AttachmentPage = serde_json::from_value(value.clone())
        .map_err(|_| invalid("attachment result does not match its closed contract"))?;
    let bytes = match page.encoding.as_str() {
        "base64" => STANDARD
            .decode(&page.content)
            .map_err(|_| invalid("attachment result contains invalid base64"))?,
        "utf8" => page.content.as_bytes().to_vec(),
        _ => return Err(invalid("attachment result encoding is invalid")),
    };
    let end = page
        .offset
        .checked_add(page.returned_bytes)
        .ok_or_else(|| invalid("attachment offset overflow"))?;
    if uuid::Uuid::parse_str(&page.attachment_id).is_err()
        || page
            .source_comment_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        || page.filename.as_ref().is_some_and(|name| name.len() > 4096)
        || page.content_type.is_empty()
        || page.content_type.len() > 1024
        || page.byte_size > 16 * 1024 * 1024
        || page.sha256.len() != 64
        || !page.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || page.content_trust != "untrusted_attachment"
        || page.returned_bytes > 12000
        || bytes.len() as u64 != page.returned_bytes
        || end > page.byte_size
        || (page.returned_bytes == 0 && end != page.byte_size)
        || page.next_offset
            != if end < page.byte_size {
                Some(end)
            } else {
                None
            }
        || (page.encoding == "base64" && STANDARD.encode(&bytes) != page.content)
        || (page.offset == 0
            && end == page.byte_size
            && !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(&page.sha256))
    {
        return Err(invalid(
            "attachment result integrity or pagination is invalid",
        ));
    }
    if let Some(input) = input {
        if input["attachmentId"] != page.attachment_id
            || input.get("offset").and_then(Value::as_u64).unwrap_or(0) != page.offset
            || input
                .get("encoding")
                .and_then(Value::as_str)
                .unwrap_or("utf8")
                != page.encoding
            || input
                .get("expectedSha256")
                .and_then(Value::as_str)
                .is_some_and(|hash| !hash.eq_ignore_ascii_case(&page.sha256))
        {
            return Err(invalid(
                "attachment result does not match the admitted read",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn external_event_validators_are_reused_across_threads_and_reject_unknown_types() {
        let dispatch = event_validator("external_provider.dispatch_requested").unwrap();
        let settled = event_validator("external_provider.operation_settled").unwrap();
        assert!(!std::ptr::eq(dispatch, settled));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for (event_type, expected) in [
                        ("external_provider.dispatch_requested", dispatch),
                        ("external_provider.operation_settled", settled),
                    ] {
                        assert!(std::ptr::eq(event_validator(event_type).unwrap(), expected));
                        assert!(event_schema(event_type, &json!({})).is_err());
                    }
                });
            }
        });
        assert!(event_validator("external_provider.unknown").is_err());
    }

    pub(super) fn page(bytes: &[u8], offset: usize, total: &[u8]) -> Value {
        let end = offset + bytes.len();
        json!({"attachmentId":"11111111-1111-4111-8111-111111111111", "sourceCommentId":null,
            "filename":"fixture.bin","contentType":"application/octet-stream","byteSize":total.len(),
            "sha256":format!("{:x}",Sha256::digest(total)),"encoding":"base64","content":STANDARD.encode(bytes),
            "offset":offset,"returnedBytes":bytes.len(),"nextOffset":if end < total.len() {Some(end)} else {None},
            "contentTrust":"untrusted_attachment"})
    }
    fn wrapped(page: Value) -> Value {
        json!({"status":"completed","isError":false,"operationId":"read_task_attachment","result":page})
    }
    #[test]
    fn external_attachment_pages_reconstruct_exact_binary_and_hash() {
        let bytes: Vec<u8> = (0..64379)
            .map(|n| ((n * 73 + n / 251) % 256) as u8)
            .collect();
        let mut recovered = Vec::new();
        let mut counts = Vec::new();
        for (index, chunk) in bytes.chunks(12000).enumerate() {
            let original = wrapped(page(chunk, index * 12000, &bytes));
            let safe = outcome(&original, Some("read_task_attachment")).unwrap();
            assert_eq!(safe, original);
            let serialized = serde_json::to_vec(&safe).unwrap();
            let replay: Value = serde_json::from_slice(&serialized).unwrap();
            let decoded = STANDARD
                .decode(replay["result"]["content"].as_str().unwrap())
                .unwrap();
            counts.push(decoded.len());
            recovered.extend(decoded);
        }
        assert_eq!(counts, [12000, 12000, 12000, 12000, 12000, 4379]);
        assert_eq!(Sha256::digest(&recovered), Sha256::digest(&bytes));
        assert_eq!(recovered, bytes);
    }
    #[test]
    fn external_base64_secret_like_bytes_remain_exact() {
        let encoded = "AKIAABCDEFGHIJKLMNOP";
        let bytes = STANDARD.decode(encoded).unwrap();
        let p = page(&bytes, 0, &bytes);
        assert_eq!(p["content"], encoded);
        assert_eq!(
            outcome(&wrapped(p), Some("read_task_attachment")).unwrap()["result"]["content"],
            encoded
        );
    }

    #[test]
    fn external_attachment_rejects_malformed_pages_and_wrong_tool() {
        let original = wrapped(page(&[1, 2, 3], 0, &[1, 2, 3]));
        for (field, value) in [
            ("content", json!("AA…[truncated]")),
            ("returnedBytes", json!(2)),
            ("nextOffset", json!(3)),
            ("offset", json!(u64::MAX)),
            ("byteSize", json!(17 * 1024 * 1024)),
            ("extra", json!("unexpected")),
            ("encoding", json!("hex")),
            ("sha256", json!("bad")),
        ] {
            let mut bad = original.clone();
            bad["result"][field] = value;
            assert!(
                outcome(&bad, Some("read_task_attachment")).is_err(),
                "{field}"
            );
        }
        assert!(outcome(&original, Some("unrelated_tool")).is_err());
        assert!(
            validate_attachment(&original["result"], Some(&json!({"attachmentId":"other"})))
                .is_err()
        );
    }
    #[test]
    fn external_content_exception_is_not_a_generic_content_key_bypass() {
        let mut p = page(b"token=synthetic-secret", 0, b"token=synthetic-secret");
        p["encoding"] = json!("utf8");
        p["content"] = json!("token=synthetic-secret");
        let safe = outcome(&wrapped(p.clone()), Some("read_task_attachment")).unwrap();
        assert_eq!(safe["result"]["content"], p["content"]);
        let ordinary = outcome(
            &json!({"status":"completed","result":p,"apiKey":"synthetic-secret"}),
            Some("other"),
        )
        .unwrap();
        assert_eq!(ordinary["apiKey"], "[REDACTED]");
        assert!(!ordinary["result"]["content"]
            .as_str()
            .unwrap()
            .contains("synthetic-secret"));
    }
    #[test]
    fn external_outcome_preserves_long_json_and_enforces_encoded_budget() {
        let text = serde_json::to_string(&json!({"message":"é\\\"".repeat(10000)})).unwrap();
        let original = json!({"status":"completed","result":{"text":text}});
        assert_eq!(outcome(&original, None).unwrap(), original);
        serde_json::from_str::<Value>(
            outcome(&original, None).unwrap()["result"]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert!(outcome(&json!({"result":"a".repeat(OUTCOME_BYTES)}), None).is_err());
        assert!(outcome(&json!({"result":"\"".repeat(OUTCOME_BYTES/2)}), None).is_err());
        let page = json!({"status":"completed","result":{"data":"x".repeat(499000)}});
        assert_eq!(outcome(&page, None).unwrap(), page);
    }
}
