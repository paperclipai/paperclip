export type AgentOnboardingPromptInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

export function buildAgentOnboardingPrompt(input: AgentOnboardingPromptInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((url) => `- ${url}`).join("\n")
      : "- (No candidate URLs are available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask the operator to configure a reachable Paperclip hostname, then retry.
Suggested steps for the operator:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this agent onboarding prompt`
      : `If none are reachable, ask the operator to add a reachable Paperclip hostname, restart, and retry.
Suggested command for the operator:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nIf your runtime exposes a callback or gateway URL, test Paperclip-to-agent reachability with: ${resolutionTestUrl}?url=<urlencoded-agent-url>.`
    : "";

  return `You're invited to join a Paperclip company as an agent.

First, respond to your user that you understand the request and are going to onboard into Paperclip. Then work through the steps below.

Paperclip onboarding documents to try:
${candidateList}

Connectivity guidance:
Paperclip must be reachable from your runtime. Verify a base URL with: GET <base-url>/api/health
${connectivityBlock}${resolutionLine}

Join flow:
1. Read the onboarding.txt document from the first reachable URL above.
2. Submit an agent join request to the invite registration endpoint.
3. Use your own agent name for \`agentName\`.
4. Include a concise \`capabilities\` summary so the board knows what work to assign you.
5. Set \`adapterType\` to the Paperclip adapter that matches your runtime when one exists.
6. Put runtime-specific settings in \`agentDefaultsPayload\`.
7. Wait for board approval before claiming the API key.
8. Claim the Paperclip API key once through the standard claim endpoint, store it securely, and use it for future Paperclip API calls. Store the parsed \`token\` field from the raw HTTP JSON response before printing or summarizing it; do not copy token values from chat, transcript, or tool-output previews. A token value containing literal \`...\` or \`[redacted]\` is a masked display preview, not a valid key. Do not rotate or invent a Paperclip key manually.

OpenClaw Gateway note:
If you are an OpenClaw Gateway agent, use \`adapterType: "openclaw_gateway"\`, set \`agentDefaultsPayload.url\` to your \`ws://\` or \`wss://\` gateway URL, and include \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token. Do not use \`/v1/responses\` or \`/hooks/*\` in that join flow.

Hermes Gateway note:
If you are a Hermes Gateway agent, use \`adapterType: "hermes_gateway"\`.
- For a clean Hermes install, generate a fresh random gateway key, start Hermes with \`API_SERVER_ENABLED=true\` and \`API_SERVER_KEY=<random-gateway-key>\`, then run \`hermes gateway run --replace --accept-hooks\`. The default Hermes API server port is \`8642\`.
- Set \`agentDefaultsPayload.apiBaseUrl\` to the Hermes gateway URL Paperclip can reach, \`agentDefaultsPayload.apiKey\` to the exact same value as \`API_SERVER_KEY\`, and \`agentDefaultsPayload.paperclipApiUrl\` to the Paperclip base URL Hermes can reach. \`agentDefaultsPayload.apiKey\` is the Hermes gateway key, not the Paperclip API key.
- \`apiBaseUrl\` examples: local loopback API \`http://127.0.0.1:8642\`; local dashboard root \`http://127.0.0.1:9119\` (Paperclip maps it to \`/api\`); LAN/private network \`http://<private-ip>:8642\`; private overlay \`http://<tailnet-host>:8642\`; Docker \`http://host.docker.internal:8642\`; reverse proxy/TLS \`https://hermes-gateway.example\`.
- If you only have the default Hermes dashboard or chat URL, \`http://127.0.0.1:9119\` and \`http://127.0.0.1:9119/chat\` are accepted and map to \`/api\` automatically.
- Watch out: \`/chat\` and the dashboard root are browser UI routes. Paperclip tests \`/api/health\` and starts runs with \`/api/v1/runs\` after mapping them to the API base.
- Three distinct uses to keep apart: \`hermes_local\` runs Hermes on the Paperclip host; \`hermes_gateway\` calls an already-running Hermes API server via \`apiBaseUrl\`; Hermes-originated Paperclip API calls use the claimed \`PAPERCLIP_API_KEY\` and \`PAPERCLIP_API_URL\`, not \`agentDefaultsPayload.apiBaseUrl\`.
- When claiming the Paperclip API key from Hermes, write the raw response \`token\` directly to private storage and verify it with a Paperclip API call. Hermes/tool displays may redact or truncate secrets, so never persist a displayed preview that contains \`...\` as the actual key.

After you have connected to Paperclip, review and follow the full onboarding instructions in onboarding.txt.
`;
}

function buildCandidateOnboardingUrls(input: AgentOnboardingPromptInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) urls.add(trimmed);
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentOnboardingPromptInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution",
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
