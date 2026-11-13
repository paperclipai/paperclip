use sha2::{Digest, Sha256};

pub(crate) const SHORT_STABLE_ID_CHARS: usize = 160;
pub(crate) const DURABLE_STABLE_ID_CHARS: usize = 240;

const ACPX_RUNTIME_REQUEST_DOMAIN: &[u8] = b"paperclip.acpx.runtime-request.v1\0";
const ACPX_RUNTIME_REQUEST_PREFIX: &str = "acpx-request-";

pub(crate) fn is_stable_id(value: &str, max_chars: usize) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && characters
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        && value.len() <= max_chars
}

/// Preserves already-canonical runtime request IDs and deterministically
/// projects other bounded ACPX IDs into the stricter PRP request namespace.
/// The upstream ID remains authoritative for the sidecar resolution command.
pub(crate) fn project_acpx_runtime_request_id(value: &str) -> Option<String> {
    if value.is_empty()
        || value.chars().count() > DURABLE_STABLE_ID_CHARS
        || value.chars().any(char::is_control)
    {
        return None;
    }
    if is_stable_id(value, SHORT_STABLE_ID_CHARS) {
        return Some(value.to_owned());
    }
    let mut digest = Sha256::new();
    digest.update(ACPX_RUNTIME_REQUEST_DOMAIN);
    digest.update(value.as_bytes());
    Some(format!(
        "{ACPX_RUNTIME_REQUEST_PREFIX}{:x}",
        digest.finalize()
    ))
}
