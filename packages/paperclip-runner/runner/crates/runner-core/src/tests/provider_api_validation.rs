use super::*;

#[test]
fn api_window_rejection_explains_limits_and_allows_corrected_call() {
    let contract_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../generated/capability/semantic-tool-contracts.json");
    let contracts: Value =
        serde_json::from_str(&fs::read_to_string(contract_path).unwrap()).unwrap();
    let contract = contracts
        .as_array()
        .unwrap()
        .iter()
        .find(|contract| contract["name"] == "call_api")
        .unwrap();
    let operation = crate::provider_bridge::AuthorizedTool {
        operation_id: "call_api".to_owned(),
        version: 1,
        description: contract["description"].as_str().unwrap().to_owned(),
        input_schema: contract["inputSchema"].clone(),
        response_schema: contract["outputSchema"].clone(),
    };
    let mut bridge = ProviderToolBridge::default();
    bridge
        .prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                .unwrap(),
            operations: vec![operation],
        })
        .unwrap();
    let mut input = json!({
        "operationId": "GET /api/assets/{assetId}/content",
        "pathParams": {"assetId": "PRIVATE_ASSET"},
        "responseText": {"limitBytes": 60000}
    });
    let error = bridge
        .begin_call(
            "api-window".to_owned(),
            "call_api".to_owned(),
            input.clone(),
        )
        .unwrap_err();
    let result = invalid_tool_call_result("api-window".to_owned(), "call_api".to_owned(), &error);
    let message = result.result["error"]["message"].as_str().unwrap();
    assert!(message.contains("responseText.limitBytes"));
    let window_schema =
        &contract["inputSchema"]["properties"]["responseText"]["properties"]["limitBytes"];
    assert!(message.contains(&format!(
        "from {} through {} bytes (default {})",
        window_schema["minimum"], window_schema["maximum"], window_schema["default"]
    )));
    assert!(message.contains("/properties/responseText/properties/limitBytes/maximum"));
    assert!(!message.contains("PRIVATE_ASSET"));
    assert!(message.len() <= 512);
    assert!(!message.chars().any(char::is_control));
    assert_eq!(result.result["error"]["code"], "invalid_tool_call");
    input["responseText"]["limitBytes"] = json!(16000);
    let mut unknown_field = input.clone();
    unknown_field["responseText"]["PRIVATE_FIELD"] = json!("PRIVATE_VALUE");
    let unknown_error = bridge
        .begin_call(
            "unknown-api-window".to_owned(),
            "call_api".to_owned(),
            unknown_field,
        )
        .unwrap_err();
    let unknown_result = invalid_tool_call_result(
        "unknown-api-window".to_owned(),
        "call_api".to_owned(),
        &unknown_error,
    );
    let unknown_message = unknown_result.result["error"]["message"].as_str().unwrap();
    assert!(unknown_message.contains("/additionalProperties"));
    for private in ["PRIVATE_FIELD", "PRIVATE_VALUE", "PRIVATE_ASSET"] {
        assert!(!unknown_result.result.to_string().contains(private));
    }
    assert!(unknown_message.len() <= 512);
    let denied = ProviderToolBridge::default()
        .begin_call("denied-api".to_owned(), "call_api".to_owned(), json!({}))
        .unwrap_err();
    assert_eq!(
        invalid_tool_call_result("denied-api".to_owned(), "call_api".to_owned(), &denied).result
            ["error"]["message"],
        GENERIC_INVALID_TOOL_CALL_MESSAGE
    );
    assert!(bridge
        .begin_call("api-window".to_owned(), "call_api".to_owned(), input)
        .is_ok());
}
