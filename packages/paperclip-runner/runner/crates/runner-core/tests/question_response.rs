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
                "options":[{"id":"first","label":"First","recommended":true},{"id":"second","label":"Second"}],
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
fn rejects_present_empty_optional_answers() {
    let mut optional_text_set = question_set();
    optional_text_set["questions"][2]["required"] = json!(false);
    optional_text_set["questions"][2]
        .as_object_mut()
        .unwrap()
        .remove("textValidation");
    let mut empty_text = valid_response();
    empty_text["answers"]["notes"] = json!({"text":"\u{feff}\u{2009}"});
    assert!(validate_question_response(&optional_text_set, &empty_text).is_err());

    let mut optional_custom_set = question_set();
    optional_custom_set["questions"][0]["required"] = json!(false);
    let mut empty_custom = valid_response();
    empty_custom["answers"]["target"] = json!({"customText":"\u{feff}\u{2009}"});
    assert!(validate_question_response(&optional_custom_set, &empty_custom).is_err());
}

#[test]
fn rejects_malformed_persisted_text_constraints() {
    let malformed_constraints = [
        json!("not-an-object"),
        json!({"minLength":"2"}),
        json!({"maxLength":2.5}),
        json!({"pattern":false}),
        json!({"inputType":false}),
        json!({"minimum":"1"}),
        json!({"maximum":{}}),
    ];
    for constraint in malformed_constraints {
        let mut malformed_set = question_set();
        malformed_set["questions"][2]["textValidation"] = constraint.clone();
        assert!(
            validate_question_response(&malformed_set, &valid_response()).is_err(),
            "malformed text constraint unexpectedly passed: {constraint}"
        );
    }
}

#[test]
fn rejects_semantically_malformed_unanswered_questions() {
    let cases = [
        ("duplicate option ids", {
            let mut value = question_set();
            value["questions"][0]["options"][1]["id"] = json!("first");
            value
        }),
        ("inverted text length bounds", {
            let mut value = question_set();
            value["questions"][2]["textValidation"]["minLength"] = json!(6);
            value
        }),
        ("inverted numeric bounds", {
            let mut value = question_set();
            value["questions"][3]["textValidation"]["minimum"] = json!(4);
            value
        }),
        ("invalid text pattern", {
            let mut value = question_set();
            value["questions"][2]["textValidation"]["pattern"] = json!("[");
            value
        }),
    ];
    let response = json!({"schema":"paperclip.question_response.v1","answers":{}});
    for (label, mut set) in cases {
        for question in set["questions"].as_array_mut().unwrap() {
            question["required"] = json!(false);
        }
        assert!(
            validate_question_response(&set, &response).is_err(),
            "{label} unexpectedly passed without an answer"
        );
    }
}

#[test]
fn counts_text_lengths_like_javascript_utf16() {
    let mut bounded_set = question_set();
    bounded_set["questions"][2]["textValidation"] = json!({"minLength":2,"maxLength":2});
    let mut response = valid_response();
    response["answers"]["notes"] = json!({"text":"😀"});
    validate_question_response(&bounded_set, &response).unwrap();

    bounded_set["questions"][2]["textValidation"] = json!({"maxLength":1});
    assert!(validate_question_response(&bounded_set, &response).is_err());
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
    let mut unconstrained_set = question_set();
    unconstrained_set["questions"][2]
        .as_object_mut()
        .unwrap()
        .remove("textValidation");
    let mut code_unit_bounded = valid_response();
    code_unit_bounded["answers"]["notes"] = json!({"text":"😀".repeat(50_000)});
    validate_question_response(&unconstrained_set, &code_unit_bounded).unwrap();
    code_unit_bounded["answers"]["notes"] = json!({"text":"😀".repeat(50_001)});
    assert!(validate_question_response(&unconstrained_set, &code_unit_bounded).is_err());
}
