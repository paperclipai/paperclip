# openrouter-agent adapter

An agentic adapter that routes Paperclip agent runs to any OpenAI Chat
Completions-compatible endpoint and executes the tool-calling loop locally on
the Paperclip host.  The default upstream is OpenRouter; it works equally well
with `api.openai.com` or any other compatible gateway.

---

## Package layout

```
packages/adapters/openrouter-agent/
  src/
    index.ts            — shared metadata (type, label, static model list,
                          model profiles, agentConfigurationDoc); imported by
                          both server runtime and UI plugin loader; must be
                          free of Node-only imports
    ui-parser.ts        — declarative field parser for the adapter config form
    server/
      index.ts          — creates and exports ServerAdapterModule
      execute.ts        — main run loop (OpenAI tool-call iteration)
      models.ts         — OpenRouter /models discovery, caching, detectModel
      config-schema.ts  — JSON schema for adapter config fields
      instructions.ts   — loads AGENTS.md / HEARTBEAT.md fragments
      tools.ts          — built-in tool implementations (read_file, write_file,
                          list_directory, run_command, apply_patch)
      paperclip-api.ts  — thin wrapper around the Paperclip REST API
      paperclip-tools.ts — Paperclip-specific tool implementations
      skills.ts         — skill resolution helpers
  dist/                 — compiled ESM output (what the server loads)
    index.js            — re-exports from src/index.ts
    server/index.js     — bundled server module (openai is external;
                          @paperclipai/adapter-utils is inlined)
    ui-parser.js        — UI field parser
```

### Build outputs

`tsup` produces three ESM entry points:

| Export path | Source | Purpose |
|---|---|---|
| `.` | `src/server/index.ts` | Server runtime (Node.js) |
| `./meta` | `src/index.ts` | UI metadata (browser-safe) |
| `./ui-parser` | `src/ui-parser.ts` | Declarative config form fields |

`openai` is declared external (peer dep, installed in the deployment
environment).  `@paperclipai/adapter-utils` is bundled — it's an internal dep
versioned alongside the adapter.

---

## Architecture

```
Paperclip core server
  │  loads adapter via ServerAdapterModule (plugin bind-mount)
  │
  ├─ execute(config, run)      ← main agent loop
  │    resolves model from config.model → OPENROUTER_MODEL → default
  │    calls OpenAI Chat Completions iteratively until finish / maxIterations
  │    dispatches tool calls through tools.ts / paperclip-tools.ts
  │
  ├─ listModels()              ← populates model picker in UI
  │    fetches https://openrouter.ai/api/v1/models (5 min cache)
  │    filters to models with "tools" in supported_parameters
  │    prepends leading models (static list + env-var slugs)
  │    sorts remainder alphabetically by model ID (~ prefix stripped)
  │    falls back to leading models if fetch fails
  │
  ├─ detectModel()             ← pre-fills model fields from environment
  │    reads OPENROUTER_MODEL  → reported as primary detected model
  │    reads OPENROUTER_LIGHT_MODEL → reported as lightModel
  │    returns null if neither is set
  │
  ├─ getConfigSchema()         ← drives declarative config form in UI
  │
  └─ testEnvironment()         ← validates API key / endpoint reachability
```

### Model resolution in execute()

For a normal run:
```
config.model  →  OPENROUTER_MODEL  →  openrouter/auto
```

For a light (cheap) run (`config.isLightRun === true`):
```
config.model  →  OPENROUTER_LIGHT_MODEL  →  OPENROUTER_MODEL  →  openrouter/free
```

---

## Environment passthrough

The container must receive these variables (set in `paperclip-boot-linkcast.yaml`):

| Variable | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | Authenticates all OpenRouter requests |
| `OPENROUTER_MODEL` | No | Default model slug for primary runs; also surfaced as the detected model in the UI |
| `OPENROUTER_LIGHT_MODEL` | No | Default model for cheap/light runs; surfaced as `lightModel` in detect-model response so the UI can tag it "environment" in the cheap model picker |

`OPENAI_API_KEY` is accepted as a fallback for `OPENROUTER_API_KEY` when
pointing the adapter at a non-OpenRouter endpoint.

### `~`-prefixed model slugs

OpenRouter routing aliases (e.g. `~google/gemini-flash-latest`) are not
returned by the `/models` discovery API.  They are added to the leading model
list via `OPENROUTER_LIGHT_MODEL` / `OPENROUTER_MODEL` env vars so they appear
as selectable options.  The sort strips the leading `~` so they sort
alphabetically alongside their non-aliased equivalents.

---

## Dynamic model discovery

`listModels()` fetches `https://openrouter.ai/api/v1/models` on first call and
caches for 5 minutes.  The UI invalidates that cache when the model dropdown is
opened, triggering a fresh fetch within the TTL window.

The returned list is ordered:

1. **Leading models** — static entries (`openrouter/auto`, `openrouter/free`)
   plus any model slug found in `OPENROUTER_MODEL`, `OPENROUTER_DEFAULT_MODEL`,
   or `OPENROUTER_LIGHT_MODEL`.  Their display names are upgraded with OpenRouter
   API data when available.
2. **Dynamic models** — all remaining tool-capable, non-expired models from the
   API, sorted alphabetically by model ID (ignoring a leading `~`).

Model labels include capability tags derived from OpenRouter metadata:
`free`, `thinking`, `vision`, `structured`, `parallel-tools`.

### "environment" tag and live vs. recorded values

The "environment" tag in the model picker marks a model whose slug came from
`OPENROUTER_MODEL` or `OPENROUTER_LIGHT_MODEL`.  What happens when the user
selects it depends on whether `adapterConfig.model` is left empty or not:

- **Field left empty** (no model saved in config) — `execute()` reads the env
  var at run time.  Changing the env var and restarting the container picks up
  the new model immediately, for both primary and cheap lanes.

- **User selects "environment"** — writes `""` to `adapterConfig.model`.
  `execute()` falls through to `OPENROUTER_MODEL` (or `OPENROUTER_LIGHT_MODEL`
  for the cheap lane) → built-in constant at run time.  Changing the env var
  and restarting the container picks up the new model automatically.

- **User selects "default"** — writes the literal hardcoded adapter default
  (e.g. `openrouter/auto`) to `adapterConfig.model`.  `execute()` uses that
  slug directly, bypassing env var precedence.  The env var has no effect as
  long as this value is saved.

- **Field left empty** (never touched) — behaves identically to selecting
  "environment": `execute()` resolves `OPENROUTER_MODEL` → built-in constant.

The trigger button reflects the effective state: empty field with an env var
set shows the env var model with an "environment" tag; empty field with no env
var shows the adapter default with a "default" tag; an explicit default
selection shows the literal slug with a "default" tag.

**Implementation note:** this is an expedient encoding — "environment" maps to
the existing empty-field convention and "default" writes the literal slug — rather
than a first-class meta-value scheme (e.g. `tag://default`, `tag://environment`).
Upsides: minimal blast radius, no adapter type-system changes, and env-var-driven
fleet testing is fully preserved.  Downside: agents that explicitly selected
"default" persist the literal slug (e.g. `openrouter/auto`); if `DEFAULT_OPENROUTER_MODEL`
ever changes to a semantically different constant those records will be stale and
need manual remediation.  In practice the risk is low because `openrouter/auto`
is itself a durable routing alias.

---

## Deployment (linkcast)

The adapter is loaded as a bind-mounted plugin.  The Paperclip server reads the
compiled `dist/` directory from the host filesystem at startup — no Docker image
rebuild is required for adapter changes.

### Bind-mount location

```
/Users/marc/Projects/linkcast/crew/paperclip/companies/linkcast/adapters/paperclip-openrouter-agent/
```

### Rebuild

From the monorepo root or the adapter package directory:

```bash
# From the adapter package
cd packages/adapters/openrouter-agent
pnpm build

# Or from the repo root
pnpm --filter paperclip-openrouter-agent build
```

If `@paperclipai/adapter-utils` has changed, rebuild it first:

```bash
pnpm --filter @paperclipai/adapter-utils build
pnpm --filter paperclip-openrouter-agent build
```

### Redistribute (deploy to linkcast)

Copy the compiled dist to the bind-mount:

```bash
cp -r packages/adapters/openrouter-agent/dist \
  /Users/marc/Projects/linkcast/crew/paperclip/companies/linkcast/adapters/paperclip-openrouter-agent/
```

Then restart the container to reload the adapter:

```bash
pcc restart
```

No `pcc build` is needed unless changes were made to the **Paperclip core
server** (e.g. `server/src/`) or the **UI** (`ui/src/`).  Those live inside the
Docker image and require a full image rebuild:

```bash
pcc build && pcc restart
# or, if layer caching causes stale results:
pcc build --no-cache server && pcc restart
```
