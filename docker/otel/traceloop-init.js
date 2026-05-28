// Register Traceloop's LLM instrumentations on the OTel SDK that is already
// bootstrapped by @opentelemetry/auto-instrumentations-node/register.
//
// Do NOT call @traceloop/node-server-sdk.initialize() here: that SDK creates
// its own exporter and defaults to api.traceloop.com. Paperclip must export
// through OTEL_EXPORTER_OTLP_ENDPOINT -> in-cluster otel-gateway -> Opik.

const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { AnthropicInstrumentation } = require("@traceloop/instrumentation-anthropic");
const { OpenAIInstrumentation } = require("@traceloop/instrumentation-openai");

const traceContent = (process.env.TRACELOOP_TELEMETRY_TRACE_CONTENT || "true") !== "false";

registerInstrumentations({
  instrumentations: [
    new AnthropicInstrumentation({ traceContent }),
    new OpenAIInstrumentation({ traceContent }),
  ],
});
