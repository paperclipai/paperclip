use num_bigint::BigUint;
use paperclip_runner_core::question_response::validate_question_response;
use serde_json::{json, Value};

fn question_set() -> Value {
    json!({
        "schema":"paperclip.question_set.v1",
        "questions":[
            {
                "id":"target",
                "prompt":"Which target?",
                "required":true,
                "answerMode":"single_select",
                "options":[{"id":"first","label":"First"},{"id":"second","label":"Second"}],
                "customAnswer":{"enabled":true}
            },
            {
                "id":"regions",
                "prompt":"Which regions?",
                "required":false,
                "answerMode":"multi_select",
                "options":[{"id":"east","label":"East"},{"id":"west","label":"West"}]
            },
            {
                "id":"notes",
                "prompt":"Add notes",
                "required":true,
                "answerMode":"text",
                "textValidation":{"minLength":2,"maxLength":5,"pattern":"^[A-Z]+$"}
            },
            {
                "id":"count",
                "prompt":"How many?",
                "required":false,
                "answerMode":"text",
                "textValidation":{"inputType":"integer","minimum":1,"maximum":3}
            }
        ]
    })
}

fn valid_response() -> Value {
    json!({
        "schema":"paperclip.question_response.v1",
        "answers":{
            "target":{"selectedOptionIds":["first"]},
            "regions":{"selectedOptionIds":["east","west"]},
            "notes":{"text":"YES"},
            "count":{"text":"2"}
        }
    })
}

#[test]
fn accepts_answers_that_match_the_exact_question_set() {
    validate_question_response(&question_set(), &valid_response()).unwrap();

    let mut custom = valid_response();
    custom["answers"]["target"] = json!({"customText":"another"});
    validate_question_response(&question_set(), &custom).unwrap();

    let mut javascript_numeric_syntax = valid_response();
    javascript_numeric_syntax["answers"]["count"] = json!({"text":"\u{feff}0x2\u{feff}"});
    validate_question_response(&question_set(), &javascript_numeric_syntax).unwrap();

    let mut empty_custom_with_selection = valid_response();
    empty_custom_with_selection["answers"]["target"] =
        json!({"selectedOptionIds":["first"],"customText":"\u{feff}"});
    validate_question_response(&question_set(), &empty_custom_with_selection).unwrap();
}

#[test]
fn rounds_large_prefixed_integers_like_javascript_number() {
    let mut bounded_set = question_set();
    bounded_set["questions"][3]["textValidation"]["minimum"] = json!(1_152_921_504_606_847_200_u64);
    bounded_set["questions"][3]["textValidation"]["maximum"] = json!(1_152_921_504_606_847_200_u64);

    for value in [
        "0x1000000000000081",
        "0o100000000000000000201",
        "0b1000000000000000000000000000000000000000000000000000010000001",
    ] {
        let mut response = valid_response();
        response["answers"]["count"] = json!({"text":value});
        validate_question_response(&bounded_set, &response)
            .unwrap_or_else(|error| panic!("{value} should match JavaScript Number: {error}"));
    }
}

#[test]
fn matches_javascript_radix_overflow_midpoint() {
    let mut unbounded_set = question_set();
    let validation = unbounded_set["questions"][3]["textValidation"]
        .as_object_mut()
        .unwrap();
    validation.remove("minimum");
    validation.remove("maximum");

    let overflow = BigUint::from(1_u8) << 1024_usize;
    // Number.MAX_VALUE is 2^1024 - 2^971. The midpoint to the
    // non-representable 2^1024 sentinel is 2^1024 - 2^970. At the midpoint,
    // nearest-ties-to-even selects the sentinel, which JavaScript exposes as
    // Infinity; the immediately preceding integer still rounds to MAX_VALUE.
    let infinite_midpoint = &overflow - (BigUint::from(1_u8) << 970_usize);
    let largest_finite = &infinite_midpoint - BigUint::from(1_u8);
    let below_overflow_but_infinite = &overflow - BigUint::from(1_u8);

    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        let mut response = valid_response();
        response["answers"]["count"] =
            json!({"text":format!("{prefix}{}", largest_finite.to_str_radix(radix))});
        validate_question_response(&unbounded_set, &response).unwrap_or_else(|error| {
            panic!("the largest finite-rounding base-{radix} integer was rejected: {error}")
        });

        for value in [&infinite_midpoint, &below_overflow_but_infinite, &overflow] {
            response["answers"]["count"] =
                json!({"text":format!("{prefix}{}", value.to_str_radix(radix))});
            assert!(
                validate_question_response(&unbounded_set, &response).is_err(),
                "base-{radix} value that rounds to Infinity was accepted"
            );
        }
    }
}

#[test]
fn treats_ecmascript_bom_whitespace_as_an_empty_required_answer() {
    let mut unconstrained_set = question_set();
    unconstrained_set["questions"][2]
        .as_object_mut()
        .unwrap()
        .remove("textValidation");

    let mut bom_text = valid_response();
    bom_text["answers"]["notes"] = json!({"text":"\u{feff}"});
    assert!(validate_question_response(&unconstrained_set, &bom_text).is_err());

    let mut bom_custom = valid_response();
    bom_custom["answers"]["target"] = json!({"customText":"\u{feff}"});
    assert!(validate_question_response(&question_set(), &bom_custom).is_err());
}

#[test]
fn rejects_cross_document_and_answer_mode_mismatches() {
    let cases = [
        ("missing required", {
            let mut value = valid_response();
            value["answers"].as_object_mut().unwrap().remove("target");
            value
        }),
        ("unknown question", {
            let mut value = valid_response();
            value["answers"]["other"] = json!({"text":"x"});
            value
        }),
        ("unknown option", {
            let mut value = valid_response();
            value["answers"]["target"] = json!({"selectedOptionIds":["other"]});
            value
        }),
        ("multiple single selections", {
            let mut value = valid_response();
            value["answers"]["target"] = json!({"selectedOptionIds":["first","second"]});
            value
        }),
        ("combined single selection", {
            let mut value = valid_response();
            value["answers"]["target"] =
                json!({"selectedOptionIds":["first"],"customText":"other"});
            value
        }),
        ("selection on text", {
            let mut value = valid_response();
            value["answers"]["notes"] = json!({"selectedOptionIds":["first"]});
            value
        }),
        ("pattern mismatch", {
            let mut value = valid_response();
            value["answers"]["notes"] = json!({"text":"no"});
            value
        }),
        ("numeric mismatch", {
            let mut value = valid_response();
            value["answers"]["count"] = json!({"text":"4"});
            value
        }),
        ("invalid numeric syntax", {
            let mut value = valid_response();
            value["answers"]["count"] = json!({"text":"0xGG"});
            value
        }),
        ("non-ECMAScript numeric whitespace", {
            let mut value = valid_response();
            value["answers"]["count"] = json!({"text":"\u{0085}2\u{0085}"});
            value
        }),
    ];
    for (label, response) in cases {
        assert!(
            validate_question_response(&question_set(), &response).is_err(),
            "{label} unexpectedly passed"
        );
    }
}

#[test]
fn rejects_malformed_or_oversized_response_envelopes() {
    assert!(validate_question_response(
        &question_set(),
        &json!({"schema":"paperclip.question_response.v2","answers":{}})
    )
    .is_err());
    assert!(validate_question_response(
        &question_set(),
        &json!({
            "schema":"paperclip.question_response.v1",
            "answers":{"notes":{"text":"x".repeat(800_000)}}
        })
    )
    .is_err());
}
