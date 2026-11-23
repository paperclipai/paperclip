use std::io::{self, BufRead};

use serde_json::Value;

const MAX_JSON_NESTING: usize = 128;
const MAX_STRING_TOKEN_BYTES: usize = 6;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BoundedJsonLine {
    Line(String),
    Rewritten {
        line: String,
        removed_bytes: usize,
        truncated_strings: usize,
    },
    TooLong,
    Eof,
}

#[derive(Debug)]
enum Container {
    Object {
        expecting_key: bool,
        last_key: Option<String>,
    },
    Array,
}

#[derive(Debug)]
struct StringState {
    is_key: bool,
    preserve: bool,
    retained_bytes: usize,
    removed_bytes: usize,
    raw_key: Vec<u8>,
    token: [u8; MAX_STRING_TOKEN_BYTES],
    token_len: usize,
    token_remaining: usize,
    pending_high_surrogate: Option<[u8; MAX_STRING_TOKEN_BYTES]>,
}

impl StringState {
    fn new(is_key: bool, preserve: bool) -> Self {
        Self {
            is_key,
            preserve,
            retained_bytes: 0,
            removed_bytes: 0,
            raw_key: Vec::new(),
            token: [0; MAX_STRING_TOKEN_BYTES],
            token_len: 0,
            token_remaining: 0,
            pending_high_surrogate: None,
        }
    }

    fn push_token_byte(&mut self, byte: u8) -> bool {
        if self.token_len == self.token.len() {
            return false;
        }
        self.token[self.token_len] = byte;
        self.token_len += 1;
        true
    }
}

struct JsonStringRewriter {
    output: Vec<u8>,
    max_bytes: usize,
    retained_string_bytes: usize,
    containers: Vec<Container>,
    string: Option<StringState>,
    overflowed: bool,
    rejected: bool,
    removed_bytes: usize,
    truncated_strings: usize,
}

impl JsonStringRewriter {
    fn new(max_bytes: usize, retained_string_bytes: usize) -> Self {
        Self {
            output: Vec::with_capacity(max_bytes.min(8 * 1024)),
            max_bytes,
            retained_string_bytes,
            containers: Vec::new(),
            string: None,
            overflowed: false,
            rejected: false,
            removed_bytes: 0,
            truncated_strings: 0,
        }
    }

    fn push_output(&mut self, bytes: &[u8]) {
        if self.overflowed {
            return;
        }
        if self.output.len().saturating_add(bytes.len()) > self.max_bytes {
            self.overflowed = true;
            return;
        }
        self.output.extend_from_slice(bytes);
    }

    fn current_string_is_key(&self) -> bool {
        matches!(
            self.containers.last(),
            Some(Container::Object {
                expecting_key: true,
                ..
            })
        )
    }

    fn current_string_is_preserved(&self) -> bool {
        if self.containers.len() != 1 {
            return false;
        }
        matches!(
            self.containers.last(),
            Some(Container::Object {
                expecting_key: false,
                last_key: Some(key),
            }) if key == "method" || key == "id"
        )
    }

    fn process(&mut self, byte: u8) {
        if self.overflowed || self.rejected {
            return;
        }
        if self.string.is_some() {
            self.process_string_byte(byte);
            return;
        }

        match byte {
            b'"' => {
                let is_key = self.current_string_is_key();
                let preserve = is_key || self.current_string_is_preserved();
                self.push_output(&[byte]);
                self.string = Some(StringState::new(is_key, preserve));
            }
            b'{' => {
                if self.containers.len() == MAX_JSON_NESTING {
                    self.rejected = true;
                    return;
                }
                self.push_output(&[byte]);
                self.containers.push(Container::Object {
                    expecting_key: true,
                    last_key: None,
                });
            }
            b'[' => {
                if self.containers.len() == MAX_JSON_NESTING {
                    self.rejected = true;
                    return;
                }
                self.push_output(&[byte]);
                self.containers.push(Container::Array);
            }
            b'}' | b']' => {
                self.push_output(&[byte]);
                self.containers.pop();
            }
            b',' => {
                self.push_output(&[byte]);
                if let Some(Container::Object {
                    expecting_key,
                    last_key,
                }) = self.containers.last_mut()
                {
                    *expecting_key = true;
                    *last_key = None;
                }
            }
            _ => self.push_output(&[byte]),
        }
    }

    fn process_string_byte(&mut self, byte: u8) {
        let mut state = self.string.take().expect("string state is present");

        if state.token_remaining > 0 {
            if !state.push_token_byte(byte) {
                self.rejected = true;
                return;
            }
            state.token_remaining -= 1;
            if state.token_remaining == 0 {
                self.finish_token(&mut state);
            }
            self.string = Some(state);
            return;
        }

        match byte {
            b'"' => {
                if state.pending_high_surrogate.is_some() {
                    self.rejected = true;
                    return;
                }
                if state.removed_bytes > 0 {
                    let marker = format!(
                        "...[paperclip-runner truncated {} bytes]",
                        state.removed_bytes
                    );
                    self.push_output(marker.as_bytes());
                    self.removed_bytes = self.removed_bytes.saturating_add(state.removed_bytes);
                    self.truncated_strings = self.truncated_strings.saturating_add(1);
                }
                self.push_output(&[byte]);
                if state.is_key {
                    let key = decode_key(&state.raw_key);
                    if let Some(Container::Object {
                        expecting_key,
                        last_key,
                    }) = self.containers.last_mut()
                    {
                        *expecting_key = false;
                        *last_key = key;
                    }
                }
            }
            b'\\' => {
                state.push_token_byte(byte);
                state.token_remaining = 1;
                self.string = Some(state);
            }
            byte if byte.is_ascii() => {
                state.push_token_byte(byte);
                self.finish_token(&mut state);
                self.string = Some(state);
            }
            byte => {
                state.push_token_byte(byte);
                state.token_remaining = utf8_width(byte).saturating_sub(1);
                if state.token_remaining == 0 {
                    self.finish_token(&mut state);
                }
                self.string = Some(state);
            }
        }
    }

    fn finish_token(&mut self, state: &mut StringState) {
        if state.token_len == 2 && state.token[..2] == [b'\\', b'u'] {
            state.token_remaining = 4;
            return;
        }

        let token = state.token;
        let token_len = state.token_len;
        state.token_len = 0;
        let token = &token[..token_len];
        if !is_valid_string_token(token) {
            self.rejected = true;
            return;
        }
        if is_high_surrogate(token) {
            if state.pending_high_surrogate.is_some() {
                self.rejected = true;
            } else {
                state.pending_high_surrogate = Some(token.try_into().expect("surrogate token"));
            }
            return;
        }
        if let Some(high) = state.pending_high_surrogate.take() {
            if !is_low_surrogate(token) {
                self.rejected = true;
                return;
            }
            let mut combined = [0; MAX_STRING_TOKEN_BYTES * 2];
            combined[..MAX_STRING_TOKEN_BYTES].copy_from_slice(&high);
            combined[MAX_STRING_TOKEN_BYTES..].copy_from_slice(token);
            self.retain_or_remove_token(state, &combined);
            return;
        }
        if is_low_surrogate(token) {
            self.rejected = true;
            return;
        }
        self.retain_or_remove_token(state, token);
    }

    fn retain_or_remove_token(&mut self, state: &mut StringState, token: &[u8]) {
        if state.is_key && state.raw_key.len() < 256 {
            let remaining = 256 - state.raw_key.len();
            state
                .raw_key
                .extend_from_slice(&token[..token.len().min(remaining)]);
        }

        if state.preserve
            || (state.removed_bytes == 0
                && state.retained_bytes.saturating_add(token.len()) <= self.retained_string_bytes)
        {
            self.push_output(token);
            state.retained_bytes = state.retained_bytes.saturating_add(token.len());
        } else {
            state.removed_bytes = state.removed_bytes.saturating_add(token.len());
        }
    }

    fn finish(mut self) -> Option<(String, usize, usize)> {
        if self.string.is_some() || self.overflowed || self.rejected || self.truncated_strings == 0
        {
            return None;
        }
        if self.output.last() == Some(&b'\r') {
            self.output.pop();
        }
        let line = String::from_utf8(self.output).ok()?;
        let value = serde_json::from_str::<Value>(&line).ok()?;
        let object = value.as_object()?;
        if object.contains_key("method") && object.contains_key("id") {
            return None;
        }
        Some((line, self.removed_bytes, self.truncated_strings))
    }
}

pub(crate) fn read_bounded_json_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
    retained_string_bytes: usize,
) -> io::Result<BoundedJsonLine> {
    let max_bytes = max_bytes.max(1);
    let retained_string_bytes = retained_string_bytes.max(1).min(max_bytes);
    let mut original = Some(Vec::with_capacity(max_bytes.min(8 * 1024)));
    let mut rewriter = JsonStringRewriter::new(max_bytes, retained_string_bytes);
    let mut input_bytes = 0usize;
    let mut reached_eof = false;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            reached_eof = true;
            break;
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(buffer.len());
        for &byte in &buffer[..content_len] {
            input_bytes = input_bytes.saturating_add(1);
            if let Some(bytes) = original.as_mut() {
                if input_bytes <= max_bytes {
                    bytes.push(byte);
                } else {
                    original = None;
                }
            }
            rewriter.process(byte);
        }
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            break;
        }
    }

    if input_bytes == 0 && reached_eof {
        return Ok(BoundedJsonLine::Eof);
    }

    if let Some(mut bytes) = original {
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        return String::from_utf8(bytes)
            .map(BoundedJsonLine::Line)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
    }

    Ok(match rewriter.finish() {
        Some((line, removed_bytes, truncated_strings)) => BoundedJsonLine::Rewritten {
            line,
            removed_bytes,
            truncated_strings,
        },
        None => BoundedJsonLine::TooLong,
    })
}

fn decode_key(raw_key: &[u8]) -> Option<String> {
    if raw_key.len() >= 256 {
        return None;
    }
    let mut quoted = Vec::with_capacity(raw_key.len() + 2);
    quoted.push(b'"');
    quoted.extend_from_slice(raw_key);
    quoted.push(b'"');
    serde_json::from_slice(&quoted).ok()
}

fn utf8_width(byte: u8) -> usize {
    match byte {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 1,
    }
}

fn is_high_surrogate(token: &[u8]) -> bool {
    unicode_escape_value(token).is_some_and(|value| (0xD800..=0xDBFF).contains(&value))
}

fn is_low_surrogate(token: &[u8]) -> bool {
    unicode_escape_value(token).is_some_and(|value| (0xDC00..=0xDFFF).contains(&value))
}

fn unicode_escape_value(token: &[u8]) -> Option<u16> {
    if token.len() != MAX_STRING_TOKEN_BYTES || token[..2] != [b'\\', b'u'] {
        return None;
    }
    std::str::from_utf8(&token[2..])
        .ok()
        .and_then(|digits| u16::from_str_radix(digits, 16).ok())
}

fn is_valid_string_token(token: &[u8]) -> bool {
    match token {
        [byte] => *byte >= 0x20 && byte.is_ascii(),
        [b'\\', escaped] => matches!(
            escaped,
            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't'
        ),
        [b'\\', b'u', _, _, _, _] => unicode_escape_value(token).is_some(),
        _ => std::str::from_utf8(token).is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn rewrites_an_oversized_notification_and_reads_the_next_frame() {
        let large = "x".repeat(512);
        let first = format!(r#"{{"method":"item/completed","params":{{"diff":"{large}"}}}}"#);
        let second = r#"{"method":"turn/completed","params":{}}"#;
        let mut reader = Cursor::new(format!("{first}\n{second}\n"));

        let rewritten = read_bounded_json_line(&mut reader, 256, 16).unwrap();
        let BoundedJsonLine::Rewritten {
            line,
            removed_bytes,
            truncated_strings,
        } = rewritten
        else {
            panic!("expected a rewritten frame");
        };
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["method"], "item/completed");
        assert_eq!(removed_bytes, 496);
        assert_eq!(truncated_strings, 1);
        assert_eq!(
            value["params"]["diff"],
            format!(
                "{}...[paperclip-runner truncated 496 bytes]",
                "x".repeat(16)
            )
        );
        assert!(line.len() <= 256);
        assert_eq!(
            read_bounded_json_line(&mut reader, 256, 16).unwrap(),
            BoundedJsonLine::Line(second.to_owned())
        );
    }

    #[test]
    fn keeps_a_sub_limit_frame_unchanged() {
        let line = format!(
            r#"{{"method":"event","params":{{"text":"{}"}}}}"#,
            "x".repeat(96)
        );
        let mut reader = Cursor::new(format!("{line}\n"));

        assert_eq!(
            read_bounded_json_line(&mut reader, 512, 8).unwrap(),
            BoundedJsonLine::Line(line)
        );
    }

    #[test]
    fn rejects_an_oversized_request_without_losing_the_next_frame() {
        let request = format!(
            r#"{{"id":7,"method":"item/tool/call","params":{{"arguments":"{}"}}}}"#,
            "x".repeat(512)
        );
        let next = r#"{"method":"turn/completed","params":{}}"#;
        let mut reader = Cursor::new(format!("{request}\n{next}\n"));

        assert_eq!(
            read_bounded_json_line(&mut reader, 256, 16).unwrap(),
            BoundedJsonLine::TooLong
        );
        assert_eq!(
            read_bounded_json_line(&mut reader, 256, 16).unwrap(),
            BoundedJsonLine::Line(next.to_owned())
        );
    }

    #[test]
    fn rewrites_an_oversized_response_and_preserves_its_id() {
        let response = format!(
            r#"{{"id":"response-1","result":{{"content":"{}"}}}}"#,
            "x".repeat(512)
        );
        let mut reader = Cursor::new(format!("{response}\n"));

        let BoundedJsonLine::Rewritten { line, .. } =
            read_bounded_json_line(&mut reader, 256, 16).unwrap()
        else {
            panic!("expected a rewritten frame");
        };
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["id"], "response-1");
    }

    #[test]
    fn cuts_only_at_utf8_and_escape_boundaries() {
        let escaped_pair = r#"\uD83D\uDE00"#;
        let line = format!(
            r#"{{"method":"event","params":{{"text":"ab{escaped_pair}{}"}}}}"#,
            "é".repeat(256)
        );
        let mut reader = Cursor::new(format!("{line}\n"));

        let BoundedJsonLine::Rewritten { line, .. } =
            read_bounded_json_line(&mut reader, 256, 10).unwrap()
        else {
            panic!("expected a rewritten frame");
        };
        let value: Value = serde_json::from_str(&line).unwrap();
        assert!(value["params"]["text"]
            .as_str()
            .unwrap()
            .contains("[paperclip-runner truncated "));
    }

    #[test]
    fn keeps_a_contiguous_prefix_at_a_multibyte_boundary() {
        let text = format!("abébc{}", "x".repeat(512));
        let line = format!(r#"{{"method":"event","params":{{"text":"{text}"}}}}"#);
        let mut reader = Cursor::new(format!("{line}\n"));

        let BoundedJsonLine::Rewritten { line, .. } =
            read_bounded_json_line(&mut reader, 256, 3).unwrap()
        else {
            panic!("expected a rewritten frame");
        };
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            value["params"]["text"],
            "ab...[paperclip-runner truncated 516 bytes]"
        );
    }

    #[test]
    fn rejects_an_oversized_non_object() {
        let line = format!(r#"["{}"]"#, "x".repeat(512));
        let mut reader = Cursor::new(format!("{line}\n"));

        assert_eq!(
            read_bounded_json_line(&mut reader, 256, 16).unwrap(),
            BoundedJsonLine::TooLong
        );
    }

    #[test]
    fn rejects_invalid_string_tokens_after_the_retained_prefix() {
        for suffix in [vec![b'\\', b'z'], vec![b'\t'], vec![0xff]] {
            let mut line = format!(
                r#"{{"method":"event","params":{{"text":"{}"#,
                "x".repeat(512)
            )
            .into_bytes();
            line.extend_from_slice(&suffix);
            line.extend_from_slice(br#""}}}"#);
            line.push(b'\n');
            let mut reader = Cursor::new(line);

            assert_eq!(
                read_bounded_json_line(&mut reader, 256, 16).unwrap(),
                BoundedJsonLine::TooLong
            );
        }
    }

    #[test]
    fn bounds_parser_state_for_unusable_nesting() {
        let mut rewriter = JsonStringRewriter::new(64, 16);
        for _ in 0..1_000_000 {
            rewriter.process(b'[');
        }

        assert!(rewriter.overflowed || rewriter.rejected);
        assert!(rewriter.containers.len() <= MAX_JSON_NESTING);
        assert!(rewriter.output.len() <= 64);
    }
}
