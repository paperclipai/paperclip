use std::collections::BTreeSet;

use num_bigint::BigUint;
use num_traits::ToPrimitive;
use serde_json::{json, Value};

use crate::local_runner::LocalRunnerError;

const MAX_QUESTION_RESPONSE_BYTES: usize = 768 * 1024;
const MAX_QUESTION_ANSWER_CODE_UNITS: usize = 100_000;

/// Validates a provider-neutral response against the exact persisted question
/// set that produced it. The JSON Schema owns the wire shape; this function
/// adds cross-document identifiers, modes, required answers, and constraints.
pub fn validate_question_response(
    question_set: &Value,
    response: &Value,
) -> Result<(), LocalRunnerError> {
    let bytes = serde_json::to_vec(response).map_err(|error| {
        LocalRunnerError::invalid(format!("question response is not serializable: {error}"))
    })?;
    if bytes.len() > MAX_QUESTION_RESPONSE_BYTES {
        return Err(LocalRunnerError::invalid(
            "question response exceeds its bounded transport contract",
        ));
    }
    let question_set_schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-set schema is invalid"))?;
    let question_set_validator = jsonschema::validator_for(&question_set_schema)
        .map_err(|_| LocalRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !question_set_validator.is_valid(question_set) {
        return Err(LocalRunnerError::invalid(
            "persisted question set failed the Paperclip question-set schema",
        ));
    }
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-response.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-response schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema).map_err(|_| {
        LocalRunnerError::invalid("embedded question-response schema cannot compile")
    })?;
    if !validator.is_valid(response) {
        return Err(LocalRunnerError::invalid(
            "response failed the Paperclip question-response schema",
        ));
    }

    let questions = question_set
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalRunnerError::invalid("persisted question set is malformed"))?;
    let answers = response
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| LocalRunnerError::invalid("question response answers are malformed"))?;
    let question_ids = questions
        .iter()
        .filter_map(|question| question.get("id").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    if question_ids.len() != questions.len() {
        return Err(LocalRunnerError::invalid(
            "persisted question set has invalid or duplicate ids",
        ));
    }
    for question in questions {
        validate_persisted_question(question)?;
    }
    if answers.keys().any(|id| !question_ids.contains(id.as_str())) {
        return Err(LocalRunnerError::invalid(
            "question response contains an unknown question id",
        ));
    }

    for question in questions {
        let question_id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| LocalRunnerError::invalid("persisted question id is malformed"))?;
        validate_answer(question, answers.get(question_id))?;
    }
    Ok(())
}

fn validate_answer(question: &Value, answer: Option<&Value>) -> Result<(), LocalRunnerError> {
    let question_id = question
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("persisted question id is malformed"))?;
    let required = question
        .get("required")
        .and_then(Value::as_bool)
        .ok_or_else(|| LocalRunnerError::invalid("persisted question requirement is malformed"))?;
    let Some(answer) = answer else {
        return if required {
            Err(LocalRunnerError::invalid(format!(
                "question response is missing required answer {question_id}"
            )))
        } else {
            Ok(())
        };
    };
    let answer = answer
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("question response answer is malformed"))?;
    let selected = answer
        .get("selectedOptionIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value.as_str().ok_or_else(|| {
                        LocalRunnerError::invalid("question response option id is malformed")
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let text = answer.get("text").and_then(Value::as_str);
    let custom = answer.get("customText").and_then(Value::as_str);
    if [text, custom]
        .into_iter()
        .flatten()
        .any(|value| javascript_string_length(value) > MAX_QUESTION_ANSWER_CODE_UNITS)
    {
        return Err(LocalRunnerError::invalid(format!(
            "question response answer {question_id} exceeds its text bound"
        )));
    }
    let has_value = selected.as_ref().is_some_and(|values| !values.is_empty())
        || text.is_some_and(|value| !value.trim_matches(is_ecmascript_whitespace).is_empty())
        || custom.is_some_and(|value| !value.trim_matches(is_ecmascript_whitespace).is_empty());
    if !has_value {
        return Err(LocalRunnerError::invalid(format!(
            "question response answer {question_id} is {}",
            if required { "required" } else { "empty" }
        )));
    }

    match question.get("answerMode").and_then(Value::as_str) {
        Some("text") => {
            if selected.as_ref().is_some_and(|values| !values.is_empty()) || custom.is_some() {
                return Err(LocalRunnerError::invalid(format!(
                    "text answer {question_id} cannot contain selection fields"
                )));
            }
            if let Some(text) = text {
                validate_text_constraints(question_id, question, text)?;
            }
        }
        Some("single_select" | "multi_select") => {
            if text.is_some() {
                return Err(LocalRunnerError::invalid(format!(
                    "select answer {question_id} cannot contain text"
                )));
            }
            let allowed = question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| option.get("id").and_then(Value::as_str))
                .collect::<BTreeSet<_>>();
            if selected
                .iter()
                .flatten()
                .any(|option_id| !allowed.contains(option_id))
            {
                return Err(LocalRunnerError::invalid(format!(
                    "select answer {question_id} contains an unknown option"
                )));
            }
            if question.get("answerMode").and_then(Value::as_str) == Some("single_select")
                && selected.as_ref().is_some_and(|values| values.len() > 1)
            {
                return Err(LocalRunnerError::invalid(format!(
                    "single-select answer {question_id} chose multiple options"
                )));
            }
            if custom.is_some()
                && question
                    .pointer("/customAnswer/enabled")
                    .and_then(Value::as_bool)
                    != Some(true)
            {
                return Err(LocalRunnerError::invalid(format!(
                    "select answer {question_id} does not allow custom text"
                )));
            }
            if question.get("answerMode").and_then(Value::as_str) == Some("single_select")
                && selected.as_ref().is_some_and(|values| !values.is_empty())
                && custom
                    .is_some_and(|value| !value.trim_matches(is_ecmascript_whitespace).is_empty())
            {
                return Err(LocalRunnerError::invalid(format!(
                    "single-select answer {question_id} cannot combine an option and custom text"
                )));
            }
            if let Some(custom) = custom {
                validate_text_constraints(question_id, question, custom)?;
            }
        }
        _ => {
            return Err(LocalRunnerError::invalid(
                "persisted question answer mode is malformed",
            ))
        }
    }
    Ok(())
}

fn validate_text_constraints(
    question_id: &str,
    question: &Value,
    text: &str,
) -> Result<(), LocalRunnerError> {
    let Some(validation) = question.get("textValidation") else {
        return Ok(());
    };
    let length = javascript_string_length(text) as u64;
    if validation
        .get("minLength")
        .and_then(Value::as_u64)
        .is_some_and(|minimum| length < minimum)
        || validation
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| length > maximum)
    {
        return Err(LocalRunnerError::invalid(format!(
            "answer {question_id} violates its text length constraint"
        )));
    }
    if let Some(pattern) = validation.get("pattern").and_then(Value::as_str) {
        let pattern_schema = json!({"type":"string","pattern":pattern});
        let validator = jsonschema::validator_for(&pattern_schema)
            .map_err(|_| LocalRunnerError::invalid("persisted question pattern cannot compile"))?;
        if !validator.is_valid(&Value::String(text.to_owned())) {
            return Err(LocalRunnerError::invalid(format!(
                "answer {question_id} does not match its required pattern"
            )));
        }
    }
    if matches!(
        validation.get("inputType").and_then(Value::as_str),
        Some("number" | "integer")
    ) {
        let number = parse_javascript_number(text).ok_or_else(|| {
            LocalRunnerError::invalid(format!("answer {question_id} must be numeric"))
        })?;
        if !number.is_finite()
            || (validation.get("inputType").and_then(Value::as_str) == Some("integer")
                && number.fract() != 0.0)
            || validation
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|minimum| number < minimum)
            || validation
                .get("maximum")
                .and_then(Value::as_f64)
                .is_some_and(|maximum| number > maximum)
        {
            return Err(LocalRunnerError::invalid(format!(
                "answer {question_id} violates its numeric constraint"
            )));
        }
    }
    Ok(())
}

fn validate_persisted_question(question: &Value) -> Result<(), LocalRunnerError> {
    let question_id = question
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| LocalRunnerError::invalid("persisted question id is malformed"))?;
    if let Some(options) = question.get("options").and_then(Value::as_array) {
        let option_ids = options
            .iter()
            .filter_map(|option| option.get("id").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        if option_ids.len() != options.len() {
            return Err(LocalRunnerError::invalid(format!(
                "persisted question {question_id} has invalid or duplicate option ids"
            )));
        }
    }
    let Some(validation) = question.get("textValidation") else {
        return Ok(());
    };
    if validation
        .get("minLength")
        .and_then(Value::as_u64)
        .zip(validation.get("maxLength").and_then(Value::as_u64))
        .is_some_and(|(minimum, maximum)| minimum > maximum)
    {
        return Err(LocalRunnerError::invalid(format!(
            "persisted question {question_id} has inverted text length bounds"
        )));
    }
    if validation
        .get("minimum")
        .and_then(Value::as_f64)
        .zip(validation.get("maximum").and_then(Value::as_f64))
        .is_some_and(|(minimum, maximum)| minimum > maximum)
    {
        return Err(LocalRunnerError::invalid(format!(
            "persisted question {question_id} has inverted numeric bounds"
        )));
    }
    if let Some(pattern) = validation.get("pattern").and_then(Value::as_str) {
        let pattern_schema = json!({"type":"string","pattern":pattern});
        jsonschema::validator_for(&pattern_schema).map_err(|_| {
            LocalRunnerError::invalid(format!(
                "persisted question {question_id} has an invalid text pattern"
            ))
        })?;
    }
    Ok(())
}

fn javascript_string_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn parse_javascript_number(value: &str) -> Option<f64> {
    let value = value.trim_matches(is_ecmascript_whitespace);
    if value.is_empty() {
        return Some(0.0);
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes
            .iter()
            .find_map(|prefix| value.strip_prefix(prefix))
        {
            if digits.is_empty() {
                return None;
            }
            let digits = digits
                .chars()
                .map(|character| character.to_digit(radix).map(|digit| digit as u8))
                .collect::<Option<Vec<_>>>()?;
            // JavaScript parses the entire prefixed integer exactly and rounds
            // once when converting it to Number. BigUint's f64 conversion uses
            // round-to-odd before the final nearest-ties-to-even conversion,
            // preserving that behavior without intermediate digit rounding.
            return BigUint::from_radix_be(&digits, radix).and_then(|number| number.to_f64());
        }
    }
    value.parse::<f64>().ok()
}

fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
