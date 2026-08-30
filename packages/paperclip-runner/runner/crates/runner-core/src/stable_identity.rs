pub(crate) const SHORT_STABLE_ID_CHARS: usize = 160;
pub(crate) const DURABLE_STABLE_ID_CHARS: usize = 240;

pub(crate) fn is_stable_id(value: &str, max_chars: usize) -> bool {
    let mut characters = value.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric())
        && characters
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
        && value.len() <= max_chars
}
