/** When adapterConfig.url is empty: same-host OpenClaw gateway default. */
export const DEFAULT_OPENCLAW_GATEWAY_WS_URL = "ws://127.0.0.1:18789";

/** Overall adapter timeout (seconds); drives default agent.wait unless waitTimeoutMs is set. */
export const DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_SEC = 900;

/** Default agent.wait budget (ms); long runs often exceed 2 minutes. */
export const DEFAULT_OPENCLAW_GATEWAY_WAIT_TIMEOUT_MS = DEFAULT_OPENCLAW_GATEWAY_TIMEOUT_SEC * 1000;
