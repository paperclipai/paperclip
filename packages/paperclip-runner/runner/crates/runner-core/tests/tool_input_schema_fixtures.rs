use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ProviderToolBridge,
    TOOL_SET_SCHEMA,
};
use serde_json::{json, Value};

const FIXTURES: &str = include_str!("../../../../test/fixtures/tool-input-schema-fixtures.json");

fn accepted_cases() -> Vec<Value> {
    let fixtures: Value = serde_json::from_str(FIXTURES).unwrap();
    fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["accepted"] == json!(true))
        .cloned()
        .collect()
}

fn admitted_schema(case: &Value) -> Value {
    let mut schema = case["schema"].clone();
    if let Some(dialect) = case.get("dialectUri") {
        schema["$schema"] = dialect.clone();
    }
    schema
}

fn tool_set(cases: &[Value]) -> AuthorizedToolSet {
    let operations = cases
        .iter()
        .map(|case| AuthorizedTool {
            operation_id: format!("app_{}", case["name"].as_str().unwrap()),
            version: 1,
            description: "Fixture app tool.".to_owned(),
            input_schema: admitted_schema(case),
            response_schema: json!({"type": "object"}),
        })
        .collect::<Vec<_>>();
    AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    }
}

#[test]
fn every_schema_the_controller_admits_compiles_in_one_tool_set() {
    let cases = accepted_cases();
    assert!(cases.len() >= 5);
    ProviderToolBridge::default()
        .prepare(tool_set(&cases))
        .unwrap();
}

#[test]
fn schemas_the_controller_finds_uncompilable_are_refused_here_too() {
    let fixtures: Value = serde_json::from_str(FIXTURES).unwrap();
    let refused = fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["reason"] == json!("uncompilable"))
        .cloned()
        .collect::<Vec<_>>();
    assert!(!refused.is_empty());
    for case in &refused {
        assert!(
            ProviderToolBridge::default()
                .prepare(tool_set(std::slice::from_ref(case)))
                .is_err(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn begin_call_agrees_with_the_shared_argument_fixtures() {
    let cases = accepted_cases();
    for case in &cases {
        let operation_id = format!("app_{}", case["name"].as_str().unwrap());
        for (expected, key) in [(true, "valid"), (false, "invalid")] {
            for (index, input) in case[key].as_array().unwrap().iter().enumerate() {
                let mut bridge = ProviderToolBridge::default();
                bridge.prepare(tool_set(&cases)).unwrap();
                let admitted = bridge
                    .begin_call(format!("call-{index}"), operation_id.clone(), input.clone())
                    .is_ok();
                assert_eq!(admitted, expected, "{operation_id} {key} {input}");
            }
        }
    }
}
