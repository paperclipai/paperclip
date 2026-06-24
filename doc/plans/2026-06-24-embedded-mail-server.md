# Plan: Embedded mail server + Cloudflare DNS/domains for autonomous agents

## Goal

Give Atelier agents email as a **native, self-hosted capability** (Paperclip
principle: batteries-included control plane, providers swappable later). Four
volets, in order:

1. **Cloudflare connection** — a company connects a Cloudflare account (API token)
   so the platform can manage DNS on the account's zones.
2. **Domain management** — the human **attaches one or more existing domains** they
   already own in that Cloudflare account, and the platform auto-configures the mail
   DNS records (MX, SPF, DKIM, DMARC) on the selected zones. (AI-driven domain
   *registration* via the Registrar API is explicitly **deferred** to a later
   iteration; V1 only attaches zones that already exist.)
3. **Email reception** — an inbound SMTP server; each agent gets a mailbox and can
   create **multiple** addresses; messages are stored and surfaced to the agent.
4. **Email sending** — outbound (DKIM-signed, direct-to-MX) exposed to agents over
   REST, so an agent can **reply** to a human who emailed it.

**Target MVP use case:** a human connects a domain from their Cloudflare account,
emails an agent (`agent@their-domain`), the agent receives it in-run and **replies**.
Receive *and* send are both in the MVP (reply needs send).

Self-hosted send/receive, in-process, no external email SaaS in the data path. A
pluggable provider seam is left for later but not built now.

## Honest constraint (drives phasing, not the design)

Receiving is infra-cheap (inbound port 25 works everywhere). **Sending** depends on
two operational facts that are infra, not code:

- **Outbound port 25 must be open** on the deployment host (often blocked by default
  on cloud/VPS providers; verify on the Coolify host before relying on Phase 3).
- **Sending IP reputation**: a clean dedicated IP, correct PTR/reverse-DNS, not on
  Spamhaus, plus warmup. Deliverability to Gmail/Outlook is gated by SPF/DKIM/DMARC +
  the Gmail/Yahoo bulk rules (<0.3% spam complaints).

So Phase 3 (send) is gated on a one-time port-25 egress check; Phases 0-2 are not.

## Architecture overview

**Everything runs in-process inside the existing `server`** (decision: no separate
container). The mail engine is two background concerns initialized at server startup
alongside `heartbeatService` / backup, sharing the same `db` and process:

- **Inbound SMTP listener** (`smtp-server`, port 25): accept mail for known addresses
  only (no open relay), parse MIME (`mailparser`), write `mail_messages`
  (direction=inbound).
- **Outbound worker** (`setInterval` poll, mirrors the heartbeat/backup pattern):
  pull queued `mail_messages` (direction=outbound), DKIM-sign + deliver direct to the
  recipient MX (`nodemailer`), update status with retry/backoff.

The HTTP control plane (existing Express app) gains the new services + routes for
Cloudflare, domains, addresses, inbox read, and send-enqueue — same
service+routes+run-context pattern as memory / MCP / credentials.

Agents never talk SMTP; they call the control-plane REST API
(`$PAPERCLIP_API_URL` + `$PAPERCLIP_API_KEY`), exactly like every other capability.

```
agent run ──REST──> server (enqueue row) ──poll──> outbound worker (DKIM + direct-MX) ──> internet
internet ──SMTP25──> inbound listener (store row) ──> server inbox API ──run-context──> agent run
DNS ──CF API──> cloudflareService (in server)
```

### Library choice (locked, in-process)

- **Receive**: `smtp-server` (Nodemailer team) — an embeddable SMTP server library
  (not a daemon), so it lives in-process. `mailparser` for MIME → structured fields.
- **Send**: `nodemailer` with a direct-to-MX transport and its **built-in DKIM**
  signing.
- Haraka was considered and rejected: it is a standalone MTA daemon, a poor fit for
  the in-process decision.

## Data model (new Drizzle tables, migration 0108+)

Conventions from `packages/db/src/schema/*` (uuid pk `defaultRandom`, `companyId`
FK partition, `withTimezone` timestamps, index callback, export from
`schema/index.ts`). Latest existing migration is `0107_agent_mcp_servers`; these are
hand-authored after `pnpm db:generate`.

### `cloudflare_connections`
- `id`, `companyId` (FK companies)
- `cfAccountId` text, `apiTokenSecretId` uuid (points at a `company_secrets` row via
  the secret_ref pattern — never store the raw token)
- `status` text (`pending|active|invalid`), `scopes` jsonb, `verifiedAt`,
  `createdByUserId`/`createdByAgentId`, `createdAt`, `updatedAt`
- unique `(companyId)` for now (one CF connection per company in V1)

### `mail_domains`
- `id`, `companyId`
- `domain` text, `provider` text default `cloudflare`, `cfZoneId` text
- `status` text (`pending|dns_configured|active|failed`)
- DKIM: `dkimSelector` text (e.g. `atl1`), `dkimPrivateKeySecretId` uuid (secret_ref),
  `dkimPublicKey` text
- record flags: `mxConfigured`, `spfConfigured`, `dmarcConfigured` boolean
- `registrarOrderId` text nullable (set when registered via CF Registrar API)
- `createdAt`, `updatedAt`
- unique `(companyId, domain)`; index `(companyId, status)`

### `mail_addresses`
- `id`, `companyId`, `domainId` (FK mail_domains, cascade)
- `agentId` uuid nullable (FK agents; null = company-shared / catch-all)
- `localPart` text, `address` text (full `local@domain`)
- `kind` text (`mailbox|alias|catch_all`)
- `status` text (`active|disabled`), `createdAt`, `updatedAt`
- unique `(domainId, localPart)`, unique `(address)`, index `(companyId, agentId)`
- **Multiple addresses per agent = multiple rows with the same `agentId`.** This is
  the "an agent can create several email addresses" requirement, for free.

### `mail_messages` (inbound + outbound, one table)
- `id`, `companyId`, `addressId` (FK mail_addresses), `agentId` uuid nullable
- `direction` text (`inbound|outbound`)
- `messageId` text, `inReplyTo` text nullable, `references` jsonb nullable
- `fromAddr` text, `toAddrs` jsonb, `ccAddrs` jsonb nullable
- `subject` text, `textBody` text, `htmlBody` text nullable
- `headers` jsonb, `rawRef` text nullable (path/key to raw MIME blob; V1 may inline)
- `status` text (`received|read` for inbound; `queued|sending|sent|failed|bounced`
  for outbound)
- delivery: `attempts` int default 0, `nextAttemptAt` timestamp nullable,
  `error` text nullable, `sentAt` timestamp nullable
- `createdAt`, `updatedAt`
- indexes `(companyId, agentId, direction, status)`, `(addressId, createdAt)`,
  partial-ish `(status, nextAttemptAt)` for the outbound poller

Attachments are out of scope for V1 (text/html only); add `mail_attachments` later.

## Shared package (`packages/shared/src`)

Explicit named re-exports (no `export *`) in `index.ts`, mirroring existing layout.

- `constants.ts`: `MAIL_DOMAIN_STATUSES`, `MAIL_ADDRESS_KINDS`,
  `MAIL_MESSAGE_STATUSES`, `MAIL_MESSAGE_DIRECTIONS`, `CLOUDFLARE_CONNECTION_STATUSES`.
- `types/mail.ts`: `CloudflareConnection`, `MailDomain`, `MailAddress`, `MailMessage`.
- `validators/mail.ts`:
  - `connectCloudflareSchema` `{ apiToken, cfAccountId? }`
  - `registerDomainSchema` `{ domain, mode: "register"|"attach" }`
  - `createAddressSchema` `{ domainId, localPart, kind?, agentId? }`
  - `sendEmailSchema` `{ fromAddressId, to[], cc?[], subject, text, html?, inReplyTo? }`
  - `inboxQuerySchema` `{ since?, status?, limit? }`
- `api.ts`: add to the `API` const —
  `cloudflareConnection: ${API_PREFIX}/companies/:companyId/integrations/cloudflare`,
  `mailDomains: ${API_PREFIX}/companies/:companyId/mail/domains`,
  `agentMailAddresses: ${API_PREFIX}/agents/:agentId/email/addresses`,
  `agentInbox: ${API_PREFIX}/agents/:agentId/email/inbox`,
  `agentSendEmail: ${API_PREFIX}/agents/:agentId/email/send`.

## Server services (`server/src/services`)

All `(db)` factories, named-exported from `services/index.ts` (needed for the route
+ idempotency-mock conventions).

### `cloudflareService(db)`
Wraps the Cloudflare REST API using a token resolved through `secretService`:
- `connect(companyId, apiToken, actor)` → store token as a `company_secrets` row
  (provider `local_encrypted`), `GET /client/v4/user/tokens/verify`, persist
  `cloudflare_connections` with `cfAccountId`, status `active`.
- `getToken(companyId)` → resolve the secret_ref via
  `secretService.resolveEnvBindings` / `resolveSecretValueInternal`.
- DNS: `upsertDnsRecord(companyId, zoneId, {type,name,content,ttl,priority})`,
  `listZones`, `getZoneId(domain)`.
- Email Routing: not used in V1 — for self-hosted receive we point MX at our own mail
  host instead of forwarding.
- Registrar (AI-driven registration): **deferred**. V1 only attaches zones the human
  already owns. (Future: `registerDomain` via the April-2026 Registrar API beta;
  3DS-on-API-charge unverified, to be tested then.)

### `mailDomainService(db)`
- `listAttachableZones(companyId)` → `cloudflareService.listZones`, so the human can
  pick which existing domain(s) to attach.
- `attach(companyId, {domain}, actor)`:
  - Resolve the existing `cfZoneId` for the chosen domain.
  - Generate a DKIM RSA keypair; store the private key as a `company_secrets` row,
    set `dkimPrivateKeySecretId` + `dkimPublicKey` + `dkimSelector`.
  - Via `cloudflareService.upsertDnsRecord`, publish: `MX` → our mail host,
    `TXT` SPF (`v=spf1 ip4:<mail-ip> -all`), `TXT` `<selector>._domainkey` (DKIM),
    `TXT` `_dmarc` (`v=DMARC1; p=quarantine; rua=...`).
  - Persist `mail_domains` and flip `status` to `active` when records verify.
- `verify(domainId)` → re-check records resolved; flip flags/status.

### `mailAddressService(db)`
- `create(companyId, {domainId, localPart, kind, agentId}, actor)` (enforces domain
  active + uniqueness; an agent may create many).
- `list(companyId, {agentId?})`, `disable(id)`, `getByAddress(address)` (used by the
  inbound listener to validate RCPT TO).

### `mailMessageService(db)`
- `recordInbound(companyId, parsed)` (called by the mail container after MIME parse).
- `enqueueOutbound(companyId, agentId, sendInput)` → validate `fromAddressId` belongs
  to agent + domain active → insert `direction:"outbound", status:"queued"`.
- `claimDueOutbound(now, limit)` / `markSent` / `markFailed` (retry/backoff) — used by
  the outbound worker.
- `listInbox(companyId, agentId, query)`, `markRead(id)`.
- `buildRunEmailSummary(companyId, agentId)` → compact unread-inbox digest string for
  run-context injection.

### `email-guide.ts`
- `renderEmailGuide(companyId, agentId)` — always-injected how-to (mirrors
  `renderCapabilityRequestGuide`): documents
  `GET /api/agents/:agentId/email/inbox`, `POST /api/agents/:agentId/email/send`,
  `POST /api/agents/:agentId/email/addresses`, with `Authorization: Bearer
  $PAPERCLIP_API_KEY`, and the posture "check and answer your mail at the start of a
  run; create a dedicated address per service you sign up for."

## Server routes (`server/src/routes`) + registration

New route modules, each `export function …Routes(db)` returning a `Router`, mounted in
`server/src/app.ts` via `api.use(...)`:

- `cloudflare-integration.ts`: `POST/GET/DELETE /companies/:companyId/integrations/cloudflare`
- `mail-domains.ts`: `POST/GET /companies/:companyId/mail/domains`,
  `POST /companies/:companyId/mail/domains/:id/verify`
- `mail.ts` (agent-facing): `GET/POST /agents/:agentId/email/addresses`,
  `GET /agents/:agentId/email/inbox`, `GET /email/messages/:id`,
  `POST /agents/:agentId/email/messages/:id/read`, `POST /agents/:agentId/email/send`

Authz: board (user) for connect/register/attach; agent-or-board for addresses/inbox/
send (enforce `actor.agentId === :agentId` for agent calls, per the existing auth
middleware shape). `assertCompanyAccess` via `routes/authz.ts`.

Activity logging (`logActivity`): `cloudflare_connected`, `mail_domain_registered`,
`mail_address_created`, `email_sent`, `email_received`.

### Test obligations (must pass)
- **openapi-routes test**: add each new route to the OpenAPI spec and add the route
  files to the `apiPrefixes` map in
  `server/src/__tests__/openapi-routes.test.ts`.
- **idempotency mock**: if any *existing* mocked route (e.g. approvals) instantiates a
  new service, add it to the `../services/index.js` mock in
  `approval-routes-idempotency.test.ts`. (New mail routes get their own service
  instantiation, so they need their own light coverage; they do not touch the
  approvals mock unless we wire an email capability into approvals.)
- Integration tests (embedded Postgres): address uniqueness + multi-per-agent,
  enqueue→claim→markSent transitions, inbound record + inbox read, DKIM key stored as
  secret_ref (not plaintext).

## Run-context injection (`server/src/services/heartbeat.ts`)

Beside the existing memory / MCP / capability-guide block (~line 8591-8622):

```ts
const emailInbox = await mailMessageService(db)
  .buildRunEmailSummary(agent.companyId, agent.id)
  .catch(() => "");
if (emailInbox) context.paperclipEmailInbox = emailInbox;
else delete context.paperclipEmailInbox;
context.paperclipEmailGuide = renderEmailGuide(agent.companyId, agent.id);
```

Adapter (`packages/adapters/claude-local/src/server/execute.ts`): render
`context.paperclipEmailInbox` + `context.paperclipEmailGuide` as prompt sections in
`joinPromptSections([...])`, mirroring `memoryNote` / `capabilityNote`. Inbox content
is not secret, so no redaction needed (unlike MCP env/headers).

## In-process mail engine (in `server`)

No separate package/container. A `mailEngine(db, config)` is initialized in
`server/src/index.ts` next to `heartbeatService` / backup, behind a
`MAIL_ENABLED` flag (default off in dev/embedded, on in prod once DNS is ready).

- **Inbound listener** (`smtp-server`): listen on internal `2525`; in Docker, map host
  `25:2525` (and `587:2587`) so the unprivileged `node` user (UID 1000) needn't bind
  <1024. Validate RCPT TO via `mailAddressService.getByAddress` → reject unknown
  recipients (no open relay / backscatter). Parse with `mailparser` →
  `mailMessageService.recordInbound`.
- **Outbound worker**: `setInterval` poll `claimDueOutbound`, resolve the domain DKIM
  private key via `secretService`, build + DKIM-sign with `nodemailer`, deliver to
  each recipient MX, `markSent` / `markFailed` with exponential backoff.
- **TLS** (STARTTLS on 587 + opportunistic on 25): cert for the mail host's own
  hostname (Let's Encrypt), path via env; configurable.

## Deployment / Coolify

- Same single server container; expose host ports `25` (and `587` for submission) on
  it (`25:2525`, `587:2587`).
- One-time host setup (the operational gate): confirm **outbound port 25 is open**
  (provider may block by default), set **reverse DNS (PTR)** for the host IP, and
  obtain a TLS cert for the mail hostname.
- Set the mail host's own A record + the per-domain MX → this hostname.
- Env: `MAIL_ENABLED`, `MAIL_HOSTNAME`, `MAIL_PUBLIC_IP`, `MAIL_SMTP_PORT`,
  `MAIL_SUBMISSION_PORT`, plus the existing `DATABASE_URL` / `PAPERCLIP_*`.

## Security

- Cloudflare token + DKIM private keys stored only as `company_secrets` (secret_ref),
  never in jsonb config; resolved at use time; redacted in logs/run-context like the
  MCP env/headers redaction in `execute.ts`.
- Cloudflare token scope guidance surfaced in the connect UI/docs: `Zone:DNS:Edit`
  only is enough for V1 (attach + DNS). No `Registrar` (spend) permission is needed
  since domain purchase is deferred — keep the token billing-free.
- Inbound: known-recipient-only (no open relay). Outbound: per-company/agent send rate
  limits; cap recipients per message; log every send.

## Phasing

- **Phase 0 — Cloudflare connect + attach domains (volets 1+2)**: schema
  `cloudflare_connections` + `mail_domains`, `cloudflareService.connect/verify/
  listZones/upsertDnsRecord`, `mailDomainService.listAttachableZones/attach` (DKIM
  keygen + publish MX/SPF/DKIM/DMARC on the chosen existing zone), connect + attach
  routes + UI. No mail flow yet. Independently shippable + testable. (No Registrar /
  domain purchase.)
- **Phase 1 — Reception (volet 3)**: `mail_addresses` + `mail_messages`, the
  in-process inbound SMTP listener, address provisioning (multi-per-agent +
  catch-all), inbox API, run-context injection + email guide. Works without outbound
  port 25 → a human can already email an agent and the agent sees it in-run.
- **Phase 2 — Sending / reply (volet 4)**: outbound worker + DKIM signing + send/reply
  API. Completes the MVP loop (agent replies to the human). Gated on the port-25
  egress check; the easy first case is replying to an engaged human recipient.

Each phase is a separate PR (linear history; English repo content), green on
`pnpm test:run` (modulo the known env-only failures) and `pnpm -r typecheck`.

## Out of scope (V1)

- **AI-driven domain registration / purchase** (Cloudflare Registrar API) — deferred;
  V1 attaches existing zones only.
- Attachments, threading UI, multi-CF-connection per company, IMAP/POP access,
  a pluggable external-provider seam (left as a future `MailProvider` interface),
  inbound spam filtering beyond known-recipient + SPF/DKIM checks, sending warmup
  automation.
