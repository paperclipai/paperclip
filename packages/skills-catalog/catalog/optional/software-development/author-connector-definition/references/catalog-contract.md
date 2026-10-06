# Catalog authoring contract

Index of the files and assertions a catalog-connector change has to satisfy.

**Verified against Paperclip App commit `18dac1e1` (24 September 2026), by
re-reading every cited file at that commit and running the command ladder below
through the isolated harness.**

**How this file cites things.** A file and a symbol, never a line number, and
never a transcribed count. Both were tried and both rotted: between `728f7185`
and `e558f25e` — nine days — several line numbers moved, and between `e558f25e`
and `18dac1e1` the store-visible count went from 46 to 56 and the candidate
count from 43 to 48. A reader who trusted a printed number would have written a
failing assertion. So the counts below are commands that read the number out of
the repository in front of you. Run them. If a symbol has moved or gone, the
commit wins — record the drift in your report so this file gets corrected.

## Files a minimal store-visible connector touches

| File | Role | Editable? |
| --- | --- | --- |
| `scripts/ingest-app-definitions.mjs` | Human-authored provider source. The `apps` array and, after it, the tuple mapper — grep `const apps = [` and `schemaVersion: 1,`. | Yes — this is the source. |
| `ui/public/brands/apps/<slug>.svg` | Official mark. | Yes. |
| `ui/public/brands/apps/manifest.json` | Branding provenance: slug, provider name, `catalogVisible`, `localAsset`, optional `darkAsset`, optional `aliases`. | Yes. |
| `packages/shared/src/app-definitions.ts` | `CONNECTABLE_APP_SLUGS` and `APP_STORE_HIDDEN_SLUGS`. | Yes. |
| `packages/shared/src/types/app-definition.ts` | The field contract the generator output has to satisfy. | Read-only for authoring. |
| `packages/shared/src/app-definitions/<slug>.json` | Generated definition. | **Generated** — see the exception below. |
| `packages/shared/src/app-definitions.generated.ts` | Generated positional registry. | **Generated.** |
| `packages/shared/src/app-definitions.ingestion-report.json` | Generated review report. | **Generated.** |
| `packages/shared/src/app-definitions.test.ts` | Catalog assertions, including exact counts. | Yes — update, never weaken. |
| `packages/shared/src/self-serve-mcp-research.json` | Dated research ledger. Membership implies connectability. | Only for that programme. |

The runbook's "shortest valid implementation" list omits
`packages/shared/src/app-definitions.ts` and the ingestion report. Both are
required for a store-visible provider.

## The generated-file exception

`scripts/ingest-app-definitions.mjs` (grep `reviewedGoogleSlugs`) reads nine
definitions back from the output directory and re-emits them verbatim:

```js
for (const slug of reviewedGoogleSlugs) {
  const existingIndex = apps.findIndex((app) => app.slug === slug);
  if (existingIndex >= 0) apps.splice(existingIndex, 1);
  apps.push(JSON.parse(fs.readFileSync(path.join(out, `${slug}.json`), "utf8")));
}
```

For `gmail` and the eight `google-*` slugs the JSON file **is** the maintained
source. For every other provider it is generated output and editing it is a
change the next run reverts.

## Generator preconditions

- **Corpus, and how to author without it.** `scripts/ingest-app-definitions.mjs`
  resolves `PAPERCLIP_CONTENT_TEMPLATES`, defaulting to
  `../../paperclip-content/research/connections/vercel/templates`. It throws
  `Expected 99 captures, found N` unless exactly 99 `.md` files (excluding
  `INDEX.md`) are present. A new provider needs no capture of its own. That
  corpus is in the non-public `paperclip-content` repository.

  Two corrections to what that implies, both executed at `066a4e8019`:

  - **When the default path does not exist you get a raw `ENOENT` out of
    `fs.readdirSync`, not the `Expected 99 captures` guard.** The guard only
    runs once the directory has been read. Do not read that `ENOENT` as a
    broken checkout; it is the missing corpus.
  - **`--definitions-only` skips the corpus entirely, and it is enough to
    author a definition.** `node scripts/ingest-app-definitions.mjs
    --definitions-only`, with no corpus present and `PAPERCLIP_CONTENT_TEMPLATES`
    unset, reproduced every checked-in `app-definitions/<slug>.json` file and
    `app-definitions.generated.ts` byte-for-byte — `git status` was clean
    afterwards. Adding one throwaway provider tuple and re-running emitted one
    more definition and changed exactly the new `<slug>.json` plus the
    positional registry.

    Re-measured at `d56a8a39d6`, where the count had grown to 79:
    `Parsed 0 captures and 0 states; emitted 79 Wave 1 definitions`, `git
    status` clean. It was 72 when first executed at `066a4e8019`. The total is
    not the claim — the byte-for-byte reproduction without the corpus is.

  What the flag costs you is `app-definitions.ingestion-report.json`, which it
  does not write. The report is built from corpus captures, so a provider with
  no capture of its own contributes nothing to it and it is correctly left
  unchanged — in the run above it stayed clean. If your change *does* need the
  report refreshed, you need the corpus, and you say so rather than stubbing
  the guard out.
- **Branding.** `brandingFor` throws
  `<slug>: missing local branding provenance` unless the slug has a manifest row
  (only `oauth-generic` and `api-key-generic` are exempt). Branding precedes
  generation.
- **Method invariants** (`validateApp`): `schemaVersion === 1`; non-empty
  `slug`, `name`, `methods`; an `api_key` tool method requires `keyPlacement`;
  an `oauth` method requires a non-empty `ownershipModes`; a required
  non-checkbox tenant/extension/credential field requires a `placeholder`.

## Tuple shape

`[slug, name, description, category, domain, urlPatterns, method|methods, extra?]`

- `category` is one of `ai`, `analytics`, `commerce`, `communication`,
  `content`, `data`, `developer`, `productivity`, `other`.
- The 5th element (`domain`) is discarded by the mapper. `docsUrl` must go in
  `extra`, or it is only backfilled for providers that also appear in the
  research ledger (`ingest-app-definitions.mjs`, grep `docsUrl`).
- `method(key, transport, auth, defaults, riskTier, guidanceMd, extra)` fills
  `ownershipModes` as `["customer", "dcr"]` for `oauth` and `["customer"]`
  otherwise, plus a default `whenToUse`.

  **That default is a capability claim, and it is silent.** Using the helper
  asserts both that the provider accepts an operator-registered client
  (`customer`) and that Paperclip may auto-register one (`dcr`). Neither is
  free: omit `dcr` for a provider Paperclip must not auto-register, and omit
  `customer` for a provider with no way for an operator to register a client of
  their own. Pass `ownershipModes` explicitly in `extra` whenever your probe did
  not establish both, and say in your report which of the two you observed
  advertised rather than inherited from the helper.
- `featured` is a hard-coded six-slug list in the mapper. Do not add to it as
  part of authoring a new provider.

## Visibility chain

```txt
APP_DEFINITIONS (generated, all providers)
  └─ filtered by CONNECTABLE_APP_SLUGS  ─▶ CONNECTABLE_APP_DEFINITIONS
       └─ minus APP_STORE_HIDDEN_SLUGS  ─▶ APP_STORE_DEFINITIONS  ─▶ gallery API
```

`GET /api/companies/:companyId/tools/apps` returns `APP_STORE_DEFINITIONS`
directly (`server/src/routes/tool-access.ts`, grep `tools/apps`). There is no
company-scoped definition store, and `connectToolAppSchema` accepts a
`galleryKey` or a `link` and nothing else (`connectToolAppSchema` in
`packages/shared/src/validators/tool-access.ts`). A catalog connector is
therefore always a shared-source change.

### Three states, not two

The chain above is about *listing*. It is not the whole visibility contract,
and reading it as though it were is the mistake this file used to invite.

| State | How you set it | What a user can do |
| --- | --- | --- |
| **Store-visible** | In `CONNECTABLE_APP_SLUGS`, not in `APP_STORE_HIDDEN_SLUGS` | Sees the card, connects. |
| **Connectable but unlisted** | Add the slug to `APP_STORE_HIDDEN_SLUGS` | Does **not** see the card in the gallery, and can still connect by direct URL or by slug lookup. Hiding is not withholding. |
| **Withheld** | `availability: { available: false, reason }` on the definition | Cannot connect. The reason renders where the Connect action would be. |

The third one is the one to reach for when a connector is authored but not yet
proven against the provider — offline authoring legitimately produces a column
of "not run", and a definition in that state must not offer a Connect button
that cannot work.

`available: false` is enforced server-side, not just in the UI. Grep these
before trusting the label:

```sh
git grep -n 'availability?\.available === false' server/src ui/src
```

At `18dac1e1` that is refused by the metadata preflight (`notFound("App not
found")` in `server/src/services/tool-access.ts`), filtered out of agent
connection intents (`server/src/services/connection-intents.ts`), and rendered
as a disabled card with the reason in `ConnectionSetupFlow.tsx` and
`Browse.tsx`.

### Executing the unlisted path

The table says which state to want. Nothing said how to take the second one,
and it is the state people reach for by habit — so here are its mechanics in
full. Take it when a connector is deliberately connectable without being
advertised. When the reason it should not be advertised is that nobody has
proven it against the provider, you want the third state, not this one.

Three edits, all required:

1. **`packages/shared/src/app-definitions.ts`** — add the slug to
   `CONNECTABLE_APP_SLUGS` *and* to `APP_STORE_HIDDEN_SLUGS`. Missing the first
   makes the definition unreachable; missing the second makes it listed.
2. **`packages/shared/src/app-definitions.test.ts`** — add the slug to the exact
   sorted list in the `APP_STORE_HIDDEN_SLUGS` assertion. It is `toEqual`
   against a literal array and it is sorted, so insert it in position rather
   than appending.
3. **`ui/public/brands/apps/manifest.json`** — the branding row still has to
   exist, because `brandingFor` throws without it, but set
   `"catalogVisible": false`. The manifest-parity assertion compares the
   `catalogVisible` set against the *store-visible* set, so an unlisted slug
   left `catalogVisible: true` fails it.

And one thing not to do: **do not touch the store count.**
`APP_STORE_DEFINITIONS` excludes hidden slugs, so its length does not change.
Bumping it — the instruction the store-visible path gives — fails the test by
one in the other direction.

Checked against `18dac1e1`: all 20 slugs in `APP_STORE_HIDDEN_SLUGS` have a
manifest row, every one carries `catalogVisible: false`, and the 56 rows with
`catalogVisible: true` are exactly `APP_STORE_DEFINITIONS`. The three edits
above are what the existing unlisted providers already did.

## Assertions with exact counts or sets

These fail on any addition. Update them deliberately.

Read the current numbers before you touch anything. This prints every count
the catalog pins, out of the checkout in front of you:

```sh
grep -nE 'toHaveLength\(|verifiedAt\)\.toBe' packages/shared/src/app-definitions.test.ts
```

At `18dac1e1` that reports `APP_STORE_DEFINITIONS` 56, `SELF_SERVE_MCP_CANDIDATES`
48, `SELF_SERVE_MCP_RESEARCH.entries` 51, `verifiedAt` `"2026-08-26"`. Those four
are here to show you what the output looks like, not to be copied into an edit —
three of the four have already changed once since this file was written.

| Assertion | Where | What breaks |
| --- | --- | --- |
| `expect(APP_STORE_DEFINITIONS).toHaveLength(N)` | `app-definitions.test.ts`, in `it("withholds unverified and reserved providers …")` | Any new store-visible provider. Set the count to what the command above reports, plus one. |
| `catalogVisible` manifest set must equal the store-visible definition set, and asset paths must equal `branding` values | same test — grep `manifest.providers.filter` | A manifest row without a definition, or the reverse. Also enforces PNG ≥ 128×128 and rejects script/`foreignObject`/event handlers in SVG. |
| Required non-advanced tenant/extension fields enumerated in a short allowlist | `app-definitions.test.ts` — grep `field.advanced !== true` | Any visible required field on the default path. Prefer making the field optional or advanced with a default. |
| `expect(SELF_SERVE_MCP_CANDIDATES).toHaveLength(N)` | `app-definitions.test.ts` | Adding a provider to the research ledger. |
| Ledger entry count with a fixed `verifiedAt` | `app-definitions.test.ts` — grep `SELF_SERVE_MCP_RESEARCH` | Same. Also requires HTTPS `docsUrl`/`serverUrl`, a non-empty `authMode`, a prerequisite longer than 10 characters, and a valid tier. |
| `APP_STORE_HIDDEN_SLUGS` exact sorted list | `app-definitions.test.ts` — grep `APP_STORE_HIDDEN_SLUGS` | Hiding a provider. Hidden slugs must still be connectable. |
| Method and field invariants across the whole catalog | `it("enforces method and field invariants")` | A missing `keyPlacement`, empty `ownershipModes`, or a required credential field with no placeholder. |

The provider-slug membership check above those uses `arrayContaining`, so an
addition does not break it. Measured at `e558f25e`: adding one store-visible
provider failed exactly one assertion, the `APP_STORE_DEFINITIONS` count.

## Network and deployment guard

A private, loopback or reserved MCP address is accepted only when the deployment
is *not* both authenticated and publicly exposed; link-local egress is denied in
every mode.

```ts
// allowPrivateRemoteEndpoints, in server/src/services/tool-access.ts
function allowPrivateRemoteEndpoints() {
  return (
    options.deploymentMode !== "authenticated" ||
    options.deploymentExposure !== "public"
  );
}
```

`DEPLOYMENT_MODES` is `["local_trusted", "authenticated"]` and
`DEPLOYMENT_EXPOSURES` is `["private", "public"]`
(`packages/shared/src/constants.ts`). The check runs inside
`guardedRemoteHttpFetch` at dial time rather than as a standalone pre-flight,
which is what closes the DNS-rebinding window — so a same-machine desktop MCP
endpoint is a local-deployment capability, not a configuration flag to widen.
Report it as an unsupported deployment shape instead.

## Access defaults

```ts
// packages/shared/src/app-definitions.ts:245-257
export function recommendedDefaultsForApp(app, methodKey) {
  void app;
  void methodKey;
  return { access: "all_agents", askFirstRiskLevels: [] };
}
```

Uniform and open for every provider, method and tier: every discovered action is
enabled and every active action defaults to **Allowed**, including `write` and
`destructive`. This is an opt-in restriction model — finishing a connection is a
configure-authorized, audited operation and **Ask first** stays available
afterwards. Do not compensate by misclassifying a tool, and do not change this
function in a provider change.

Changed-action quarantine activates when a *connection* sets
`quarantineNewEntries`. It is not an `AppDefinition` field; declaring it in a
manifest does nothing.

## Transport boundaries

| Transport | Manifest-only? | Boundary |
| --- | --- | --- |
| `mcp_remote` | Yes | First-class: discovery, health, catalog, gateway, OAuth, credential projection. |
| `local_stdio` | Only via a registered template | Reported unsupported outside `local_trusted` mode or a configured trusted runtime host (`server/src/services/tool-access.ts`, grep `local_stdio`). Never put a bare command in a definition. |
| `rest_api` | No | Not exposed through the connected MCP gateway. Needs an execution adapter first. |

`api_key` is an authentication mode, not a transport. Most API-key catalog
entries authenticate a remote MCP server.

Header credentials and secret-bearing generated URLs have the complete generic
runtime path. The schema also accepts `query`, `body_json` and `env` placements,
but schema acceptance is not proof the gateway projects them — trace the
invocation path and add an end-to-end fixture before shipping one.

## OAuth endpoint precedence

1. A **complete** `authorizationEndpoint` + `tokenEndpoint` pair in the method's
   `defaults` is used unconditionally. Discovery never runs, and endpoints
   stored on the connection and `401` challenge hints are not consulted at all.
2. Otherwise, for `mcp_remote`, endpoints already stored on the connection (then
   the challenge hints, field by field) are used if they form a complete pair.
3. Only then does the RFC 9728 → RFC 8414 discovery chain run.

So a complete manifest pair is authoritative and outlives its own accuracy.
Ship `serverUrl` alone for a discovery-capable provider.

Client resolution order, independent of the above: deployment-preconfigured
client, Client ID Metadata Document (needs a public HTTPS base URL), RFC 7591
dynamic registration, then an operator-supplied client. For a curated method,
`ownershipModes` gates only the curated path — omit `dcr` for a provider
Paperclip must not auto-register.

## Command ladder

Deterministic, no vendor account:

```sh
node scripts/check-app-brand-assets.mjs
node --test scripts/app-brand-validation.test.mjs
pnpm connections:ingest-app-definitions          # honours PAPERCLIP_CONTENT_TEMPLATES
pnpm exec vitest run \
  packages/shared/src/app-definitions.test.ts \
  packages/shared/src/app-definitions-url.test.ts
pnpm --filter @paperclipai/shared typecheck
```

Wider, when the change reaches server or UI code:

```sh
pnpm exec vitest run \
  server/src/__tests__/tool-access-service.test.ts \
  server/src/__tests__/generic-mcp-connection.test.ts \
  server/src/__tests__/tool-connection-removal.test.ts \
  ui/src/pages/apps/AppsConnect.test.tsx \
  ui/src/pages/apps/Browse.test.tsx
pnpm check:token-gates
pnpm -r typecheck
```

`server/src/__tests__/generic-mcp-connection.test.ts` stands up an in-process
MCP server and authorization server, so the OAuth path is exercisable with no
network and no credentials. Extend it with a fixture rather than reaching for a
real account.

Diff review before handing off:

```sh
git diff --check
git status --short
git diff -- scripts/ingest-app-definitions.mjs \
  packages/shared/src/app-definitions \
  packages/shared/src/app-definitions.generated.ts \
  ui/public/brands/apps
```

`app-definitions.generated.ts` uses positional imports (`a0`, `a1`, …), so
inserting one provider renumbers every later import — roughly 50 diff lines for
a one-provider change. That is correct output, not churn to fix. Moving the
tuple to the end of the tuple list does not avoid it, because several providers
are appended to `apps` after that list.

## Account-bound lifecycle (not deterministic)

Required once per exposed method before a provider is store-ready, and outside
this skill's authority without explicit approval: preflight on public metadata
only; connect; catalog listing compared against reviewed expectations; one
narrow read; write-classification check; one call through an actual run-scoped
gateway; refresh and reconnect; revoke and confirm calls fail closed; reconnect
after removal; and a credential scan across responses, logs, activity, audit and
every evidence artifact.

Record only provider and method key, date, environment, endpoint origin and
path, non-sensitive connection ID, tool names and counts, policy result,
redacted outcome codes, and revoke/reconnect outcome. Never record token values,
secret-bearing URLs, authorization codes, provider session detail, personal
email, tenant content, HAR files, or pre-callback screenshots.
