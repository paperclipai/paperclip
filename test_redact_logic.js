// Simple test to verify the redaction logic
function redactPlainEnvBindings(config) {
  if (!config) return config;
  const env = config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return config;
  const redactedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && value.type === "plain") {
      redactedEnv[key] = { type: "plain", value: "[REDACTED]" };
    } else {
      redactedEnv[key] = value;
    }
  }
  return { ...config, env: redactedEnv };
}

// Test case
const testConfig = {
  adapterType: "test",
  env: {
    API_KEY: { type: "plain", value: "secret123" },
    NON_PLAIN_VAR: "regular_value",
    ANOTHER_SECRET: { type: "plain", value: "another_secret" }
  }
};

const result = redactPlainEnvBindings(testConfig);
console.log("Original config:", JSON.stringify(testConfig, null, 2));
console.log("Redacted config:", JSON.stringify(result, null, 2));

// Verify redaction worked
if (result.env.API_KEY.value === "[REDACTED]" &&
    result.env.ANOTHER_SECRET.value === "[REDACTED]" &&
    result.env.NON_PLAIN_VAR === "regular_value") {
  console.log("✓ Redaction logic works correctly!");
} else {
  console.log("✗ Redaction logic failed!");
}
