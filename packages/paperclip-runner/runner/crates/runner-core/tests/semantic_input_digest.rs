use paperclip_runner_core::provider_bridge::semantic_value_digest;
use serde_json::Value;

#[test]
fn semantic_input_digests_match_the_authenticated_controller_fixtures() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/semantic-input-digests.json"
    ))
    .expect("parse shared semantic input digest fixtures");
    for fixture in fixtures.as_array().expect("digest fixture array") {
        assert_eq!(
            semantic_value_digest(&fixture["input"]),
            fixture["digest"].as_str().expect("fixture digest"),
            "fixture {}",
            fixture["name"]
        );
    }
}
