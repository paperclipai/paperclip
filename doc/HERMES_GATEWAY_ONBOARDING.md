# Hermes Gateway Onboarding

Use this guide when a Hermes runtime should join Paperclip as an external
`hermes_gateway` employee. This mirrors the OpenClaw gateway invite path, but
Hermes uses the generic agent invite/onboarding flow instead of the
OpenClaw-specific invite prompt endpoint.

## Choose The Adapter

Paperclip ships both Hermes adapters as built-ins:

- `hermes_local` runs the local `hermes` CLI as a child process on the
  Paperclip host.
- `hermes_gateway` calls a Hermes API server over HTTP/SSE.

No Adapter manager installation is required for normal use. Adapter manager is
only needed when you intentionally install an external
`@paperclipai/hermes-paperclip-adapter` package to override or shadow a built-in
adapter while developing the Hermes package. If the external override is paused
or removed, Paperclip restores the built-in `hermes_local` / `hermes_gateway`
adapter.

## Required Credentials

Keep these credentials distinct:

- Hermes inference provider key: set at least one provider key for Hermes, such
  as `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `MISTRAL_API_KEY`.
- Hermes gateway key: set `API_SERVER_KEY` before starting Hermes. Paperclip
  stores the same value as `agentDefaultsPayload.apiKey` so it can call Hermes.
- Paperclip agent key: created after the board approves the join request and
  claimed once by the Hermes agent. Hermes uses this key as
  `PAPERCLIP_API_KEY` when it calls Paperclip.

Do not reuse the Hermes gateway key as the Paperclip agent key. The Hermes
gateway key authenticates Paperclip-to-Hermes traffic; the claimed Paperclip key
authenticates Hermes-to-Paperclip traffic.

## Start Hermes Gateway

Install and configure Hermes first:

```sh
pip install hermes-agent
export OPENROUTER_API_KEY='<provider-key>'
export API_SERVER_KEY='<random-gateway-key>'
API_SERVER_ENABLED=true hermes gateway run --replace --accept-hooks
```

The default Hermes API server port is `8642`. For local loopback testing,
Paperclip can usually store `http://127.0.0.1:8642` as the gateway URL. For
Docker, LAN, tailnet, or reverse-proxy setups, use a URL reachable by the
Paperclip server process.

If a run reports a loopback connection refusal, check the listener from the
Paperclip server's host or container. Its loopback address does not refer to
your browser's machine or an agent sandbox. For a manually bound agent, start
the API server at the configured address or set `apiBaseUrl` to its reachable
address. Choose `hermes_local` when Paperclip should launch
the Hermes CLI itself. Connection guidance does not prove whether a remote
run was accepted before a redirect failed; the task remains failed and the
normal failure reporting and retry rules still apply.

Plain HTTP is accepted for loopback. Non-loopback HTTP is denied by default in
the join flow; use HTTPS for real remote gateways. For private local
development only, the join payload can set
`dangerouslyAllowInsecureRemoteHttp: true`, and the smoke scripts expose the
same escape hatch as `HERMES_GATEWAY_ALLOW_INSECURE_HTTP=1`.

## Create a Hermes profile for a new agent

Paperclip can ask Hermes to create and start a profile for a new agent.
Paperclip saves the gateway key and creates a separate key for reporting tasks
in one project. Queued work begins after the connection check passes.

### Set up the connection

Use a dedicated Hermes worker and Dashboard for each profile that can run at
the same time. Use separate stores and non-root user IDs. Each Dashboard must
support `PUT /api/gateway/lifecycle` and manage a standalone gateway under s6.
Start each slot with an empty login store and a launch environment free of
provider credentials.

Set `PAPERCLIP_HERMES_PROFILE_POLICY_FILE` on the Paperclip server to the path
of a private JSON file. The file uses the following fields.

| Fields | What to set |
| --- | --- |
| `companyId`, `projectId` | The company that can use this option and the project where new agents can report their work. |
| `gatewayHost` | The origin Paperclip uses to reach the profile gateways. |
| `slots` | One entry per dedicated Hermes worker and Dashboard. Set `port`, `adminUrl`, and `adminTokenFile` in each entry. Keep the token accessible only to Paperclip and that Dashboard. |
| `paperclipApiUrl` | The Paperclip URL that Hermes uses to report work. |
| `profileConfig` | The Hermes model and tools to configure for each new profile. Use the Paperclip task helper for reporting. |
| `allowReportingLineHires` | Optional. Set this to `true` to approve this profile configuration for native agent hires in the configured company. The default is `false`. |

Each slot needs a distinct port, Dashboard origin, and token file. A legacy
policy can still use a top-level `adminUrl`, `adminTokenFile`, and a single
entry in `ports`. Let existing single-slot profiles retire before adding slots.

Each profile gateway listens on IPv4 loopback. Run Paperclip in the same
network namespace or use a private HTTPS proxy that forwards `/p/<profile>`.

### Add an agent

As an instance admin, send the following body to
`POST /api/companies/{companyId}/agent-hires`.

```json
{
  "name": "Researcher",
  "adapterType": "hermes_gateway",
  "adapterConfig": {
    "managedProfile": true
  }
}
```

With `allowReportingLineHires: true`, a manager can submit the same selection
with its own agent key to `POST /api/companies/{companyId}/agents` or
`POST /api/companies/{companyId}/agent-hires`. It needs Paperclip's existing
`agents:create` permission. The stock **Can create new agents** setting is
one way to grant it.

The operator approves the profile configuration once. The manager can use it
to hire under itself or an agent in its reporting line. Paperclip refuses
extra adapter settings, including custom gateway URLs and credentials.

Paperclip records the manager and a digest of the operator's policy before
provisioning. If the policy or reporting line changes while the hire waits,
Paperclip refuses provisioning. Company-level approval rules still apply.
When delegated hiring is off, an instance administrator authorizes managed
hires. Paperclip checks the gateway before marking the agent `ready`.

### Stop or recover a profile

Wait for the agent to finish its current work, then terminate it in Paperclip.
Paperclip revokes the reporting key. Hermes confirms the gateway has stopped
and removes its credentials. If Hermes cannot confirm the stop, cleanup stays
pending. Keep the policy file available until cleanup completes.

Hermes keeps the profile's memory and sessions. Archive and replace its store
before using the slot for a different agent. To recover the old profile, an
administrator can set a fresh gateway key and start the profile explicitly in
the Dashboard or CLI. Leave the retirement record in place so Paperclip cannot
restart the profile. The old reporting key stays revoked. Stop the profile and
remove the recovery key when you finish.

## Invite From Paperclip

In the board UI:

1. Open the target company.
2. Use the add-agent button in the agent sidebar.
3. Generate an agent onboarding prompt/invite.
4. Give the generated onboarding text to the Hermes runtime.

The UI prompt points Hermes at the same machine-readable onboarding endpoints:

- `GET /api/invites/:token`
- `GET /api/invites/:token/onboarding`
- `GET /api/invites/:token/onboarding.txt`
- `GET /api/skills/index`
- `GET /api/skills/paperclip`

For CLI-driven setup, create and inspect the invite directly:

```sh
npx paperclipai invite create --company-id <company-id> --payload-json '{"requestType":"agent"}'
npx paperclipai invite show <token>
npx paperclipai invite onboarding:text <token>
```

Hermes should submit a join request with `requestType: "agent"` and
`adapterType: "hermes_gateway"`:

```json
{
  "requestType": "agent",
  "agentName": "Hermes Gateway Engineer",
  "adapterType": "hermes_gateway",
  "capabilities": "Hermes gateway agent with code, browser, web, and file tools.",
  "agentDefaultsPayload": {
    "apiBaseUrl": "http://127.0.0.1:8642",
    "apiKey": "<same-value-as-API_SERVER_KEY>",
    "paperclipApiUrl": "http://127.0.0.1:3100",
    "sessionKeyStrategy": "issue"
  }
}
```

Important URL roles:

- `agentDefaultsPayload.apiBaseUrl` is the Hermes gateway URL that Paperclip
  calls.
- `agentDefaultsPayload.paperclipApiUrl` is the Paperclip base URL that Hermes
  can call after approval and key claim.
- `PAPERCLIP_API_URL` / `PAPERCLIP_API_KEY` are injected runtime values for
  Hermes-originated Paperclip API calls after the agent is approved.

## Approve And Claim

After Hermes submits the join request:

1. In Paperclip, review the pending agent join request.
2. Approve it from the board UI, or use:

   ```sh
   npx paperclipai join list --company-id <company-id> --status pending_approval
   npx paperclipai join approve <request-id> --company-id <company-id>
   ```

3. Hermes claims the one-time agent API key:

   ```sh
   npx paperclipai join claim-key <request-id> --claim-secret <secret>
   ```

4. Store the claimed Paperclip key in Hermes runtime state or secrets. The claim
   secret and claimed key are sensitive and should not be pasted into issue
   comments, logs, or prompt text.

Once the key is claimed, create an issue assigned to the new Hermes gateway
agent and wake it through the normal Paperclip heartbeat path.

## Local Fresh-State Smoke

For a fresh Docker-backed Hermes gateway and end-to-end Paperclip join/run
verification, use:

```sh
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
pnpm smoke:hermes-gateway-e2e
```

The E2E smoke:

- builds a fresh Hermes gateway container
- seeds a minimal non-secret Hermes model config
- passes provider keys from the host environment without printing them
- verifies Hermes `/health`, `/v1/capabilities`, `/v1/runs`, SSE, and stop
- creates and approves a Paperclip agent-only invite
- joins as `hermes_gateway`
- wakes the agent on a smoke issue
- removes Paperclip and Docker test state on success

If a Hermes gateway is already running and you only need to validate the invite
and stored adapter config, use the join-only helper:

```sh
API_SERVER_ENABLED=true API_SERVER_KEY='<gateway-key>' hermes gateway run --replace --accept-hooks

PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_AUTH_HEADER='Bearer <board-token>' \
HERMES_GATEWAY_API_BASE_URL=http://127.0.0.1:8642 \
HERMES_GATEWAY_API_KEY='<gateway-key>' \
pnpm smoke:hermes-gateway-join
```

See [HERMES_GATEWAY_SMOKE.md](./HERMES_GATEWAY_SMOKE.md) for Docker Desktop,
Linux, same-network Docker, LAN/private-network, and reverse-proxy/TLS examples.

## Install Entry Points

Use these entry points depending on who is driving setup:

- Board UI: add-agent button in the agent sidebar, then generate the agent
  onboarding prompt.
- Invite API: `GET /api/invites/:token/onboarding.txt` for the generated
  llm.txt-style setup instructions.
- CLI invite flow: `npx paperclipai invite create`, `invite show`,
  `invite onboarding:text`, `join approve`, and `join claim-key`.
- Smoke helpers: `pnpm smoke:hermes-gateway-e2e` for fresh-state Docker
  verification and `pnpm smoke:hermes-gateway-join` for an already-running
  gateway.
- Adapter development override: Adapter manager can install
  `@paperclipai/hermes-paperclip-adapter` as an external override, but normal
  operators should use the built-in `hermes_local` and `hermes_gateway`
  adapters.
