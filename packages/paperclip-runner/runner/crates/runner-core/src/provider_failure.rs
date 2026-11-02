use serde_json::Value;
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
