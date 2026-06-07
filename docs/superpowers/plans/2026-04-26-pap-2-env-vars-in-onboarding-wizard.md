# PAP-2: Expose `adapterConfig.env` in OnboardingWizard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose user-defined environment variables in the first-run `OnboardingWizard` agent setup, so onboarding can inject vars like `CLAUDE_CONFIG_DIR` into the new agent's `adapterConfig.env` without dropping to the API.

**Architecture:** Reuse the existing `EnvVarEditor` component (already used by `AgentConfigForm` for both create and edit flows). Add a collapsible "Environment variables" disclosure in the wizard's adapter setup step. State lives alongside the existing adapter config `useState`s. Merge user env into `buildAdapterConfig()` output, preserving the existing `ANTHROPIC_API_KEY` auto-injection path so it can override or coexist with user values.

**Tech Stack:** React + TypeScript, `@tanstack/react-query` for secrets fetch/mutation, Vitest + React Testing Library for tests, no new dependencies.

**Scope clarification:** `pages/NewAgent.tsx` already uses `AgentConfigForm` which already exposes the env field via `EnvVarEditor`. `NewAgentDialog.tsx` is just an adapter-type picker (routes to `/agents/new`), no form. The ONLY remaining gap is `OnboardingWizard.tsx`. This plan touches that file plus one new test file.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Modify | `ui/src/components/OnboardingWizard.tsx` | Add env state, secrets query, EnvVarEditor render, merge into `buildAdapterConfig()` |
| Create | `ui/src/components/OnboardingWizard.test.tsx` | Single integration test: env from wizard reaches agent creation payload |

No changes to: `EnvVarEditor.tsx`, `AgentConfigForm.tsx`, `pages/NewAgent.tsx`, schema files, server routes. The existing pieces already work — we're just plugging the wizard into them.

---

## Background — required reading

- `ui/src/components/EnvVarEditor.tsx` — the component being reused. Props: `value: Record<string, EnvBinding>`, `secrets: CompanySecret[]`, `onCreateSecret: (name, value) => Promise<CompanySecret>`, `onChange: (env) => void`. Internal state syncs with `value` prop via `useEffect`.
- `ui/src/components/AgentConfigForm.tsx:902-921` — the canonical usage pattern (mirrors what we'll do in OnboardingWizard).
- `ui/src/components/AgentConfigForm.tsx:187-210` — secrets query + createSecret mutation pattern (copy this shape to OnboardingWizard).
- `ui/src/components/OnboardingWizard.tsx:316-350` — current `buildAdapterConfig()`, including the existing `ANTHROPIC_API_KEY` auto-injection at lines 339-348 that we must preserve.
- `packages/shared/src/validators/secret.ts` — `EnvBinding` type: union of `string | {type:"plain",value} | {type:"secret_ref",secretId,version?}`. Server normalizes plain strings to `{type:"plain",value}` on save.

---

### Task 1: Add env state, secrets query, and createSecret mutation to OnboardingWizard

**Files:**
- Modify: `ui/src/components/OnboardingWizard.tsx`

- [ ] **Step 1: Add imports for EnvBinding type and secretsApi**

Edit the top of the file (around the existing imports near line 1-50). Add these imports:

```typescript
import { secretsApi } from "../api/secrets";
import type { EnvBinding } from "@paperclipai/shared";
import { EnvVarEditor } from "./EnvVarEditor";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
```

If `useMutation`/`useQuery`/`useQueryClient` and a query client are already imported, deduplicate — don't double-import. The `EnvBinding` type lives in `@paperclipai/shared` per `EnvVarEditor`'s own import (verify by looking at `ui/src/components/EnvVarEditor.tsx` line ~1-10).

Also add to `queryKeys`-related import if needed:

```typescript
import { queryKeys } from "@/lib/queryKeys";
```

- [ ] **Step 2: Add user env binding state inside `OnboardingWizard()` function body**

Find the existing `useState<AdapterType>("claude_local")` line (around line 111). Below it (or grouped with the other adapter-config `useState`s), add:

```typescript
const [userEnv, setUserEnv] = useState<Record<string, EnvBinding>>({});
```

`{}` is the empty initial value (matches the `EMPTY_ENV` constant used elsewhere).

- [ ] **Step 3: Reset user env when adapter type changes**

Find the existing `function setAdapterType` callback or the existing reset block around line 291. There's already a reset (`setAdapterType("claude_local")`) — find where adapter-type-specific state gets cleared and add `setUserEnv({})` next to it. Example pattern (search for similar resets in the file):

```typescript
// In the existing resetForm / handleAdapterChange / setAdapter logic, alongside:
//   setModel("");
//   setCommand(...);
// add:
setUserEnv({});
```

Goal: when the user picks a different adapter type mid-wizard, their env vars don't leak to the new adapter (which may have different conventions).

- [ ] **Step 4: Wire secrets query and createSecret mutation**

Below the existing `useQuery` calls (search for `queryKey: queryKeys.agents.adapterModels` around line 198), add:

```typescript
const queryClient = useQueryClient();

const { data: availableSecrets = [] } = useQuery({
  queryKey: createdCompanyId
    ? queryKeys.secrets.list(createdCompanyId)
    : ["secrets", "none"],
  queryFn: () => secretsApi.list(createdCompanyId!),
  enabled: !!createdCompanyId,
});

const createSecret = useMutation({
  mutationFn: async (input: { name: string; value: string }) => {
    if (!createdCompanyId) throw new Error("Create a company first");
    return secretsApi.create(createdCompanyId, input);
  },
  onSuccess: () => {
    if (createdCompanyId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(createdCompanyId),
      });
    }
  },
});
```

If `queryKeys.secrets.list` doesn't exist (verify by `grep -n "secrets:" ui/src/lib/queryKeys.ts`), use a literal array key — e.g. `["secrets", createdCompanyId]` — or add the key shape to `queryKeys.ts` matching the existing convention. Match what `AgentConfigForm.tsx` uses at lines 187-210.

- [ ] **Step 5: Run typecheck to verify imports and types resolve**

Run from the repo root:

```bash
pnpm --filter @paperclipai/ui typecheck
```

Expected: PASS (no type errors). If there's a missing `EnvBinding` import or wrong queryKey shape, fix and retry.

- [ ] **Step 6: Commit foundation changes**

```bash
git add ui/src/components/OnboardingWizard.tsx
git commit -m "feat(PAP-2): add env state and secrets wiring to OnboardingWizard"
```

---

### Task 2: Write failing integration test

**Files:**
- Create: `ui/src/components/OnboardingWizard.test.tsx`

- [ ] **Step 1: Write the failing integration test**

Create `ui/src/components/OnboardingWizard.test.tsx` with this content. Follow the patterns established by other UI integration tests (look at `ui/src/components/IssueChatThread.test.tsx` or `ui/src/components/Sidebar.test.tsx` for QueryClient/router setup if needed):

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OnboardingWizard } from "./OnboardingWizard";

// Mock the agents API so we can capture the adapterConfig that gets sent
const createAgentMock = vi.fn();

vi.mock("../api/agents", () => ({
  agentsApi: {
    create: (...args: unknown[]) => createAgentMock(...args),
    adapterModels: vi.fn().mockResolvedValue({ models: [] }),
    testEnvironment: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/secrets", () => ({
  secretsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

// If OnboardingWizard depends on a company-creation API, mock that too. Inspect
// imports in OnboardingWizard.tsx and add the matching mocks.

function renderWizard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OnboardingWizard />
    </QueryClientProvider>,
  );
}

describe("OnboardingWizard env vars", () => {
  beforeEach(() => {
    createAgentMock.mockReset();
    createAgentMock.mockResolvedValue({ id: "agent-1" });
  });

  it("submits user-defined env vars in adapterConfig.env", async () => {
    const user = userEvent.setup();
    renderWizard();

    // 1. Walk through to the company creation step and create one
    //    (use the same userEvent flow a real user would; selectors will need
    //    to match the actual labels/placeholders in OnboardingWizard.tsx)

    // 2. On the agent setup step, choose claude_local (it's the default per line 111)

    // 3. Expand the "Environment variables" disclosure (or click the section
    //    header that toggles the EnvVarEditor)
    const envToggle = await screen.findByText(/environment variables/i);
    await user.click(envToggle);

    // 4. Fill in a key/value row
    //    EnvVarEditor renders inputs for each row — we type into the first row's
    //    key and plain-value inputs.
    const keyInputs = await screen.findAllByPlaceholderText(/KEY|name|key/i);
    await user.type(keyInputs[0], "CLAUDE_CONFIG_DIR");

    const valueInputs = await screen.findAllByPlaceholderText(/value|VALUE/i);
    await user.type(valueInputs[0], "/Users/test/.claude-paperclip");

    // 5. Submit the wizard (final "Create agent" / "Finish" button)
    const submitButton = await screen.findByRole("button", {
      name: /create|finish|done|next/i,
    });
    await user.click(submitButton);

    // 6. Assert the agentsApi.create call payload contains the env binding
    await waitFor(() => {
      expect(createAgentMock).toHaveBeenCalled();
    });
    const callArgs = createAgentMock.mock.calls[0];
    const payload = callArgs[1] ?? callArgs[0];
    expect(payload.adapterConfig.env).toMatchObject({
      CLAUDE_CONFIG_DIR: expect.objectContaining({
        // Matches either the inline-string format or the {type:"plain",value} object form
        // before the server normalizes it. Adjust to whichever shape the wizard sends.
      }),
    });
    // More specific check — should include the user value somewhere reachable:
    const env = payload.adapterConfig.env;
    const binding = env.CLAUDE_CONFIG_DIR;
    const stringValue =
      typeof binding === "string"
        ? binding
        : (binding as { value?: string }).value;
    expect(stringValue).toBe("/Users/test/.claude-paperclip");
  });
});
```

**Note for the implementer:** the placeholder strings (`KEY`, `value`) above need to match the actual input placeholders in `EnvVarEditor.tsx`. Run `grep -n "placeholder" ui/src/components/EnvVarEditor.tsx` to confirm the exact attribute values, then update the regexes. Also: the test assumes the wizard's company-creation step is straightforward to walk through. If it requires complex setup (mock fetch responses, simulated server states), reduce scope to only the agent-setup step by mocking the wizard's earlier-step state directly via test setup — don't fight the test infrastructure.

If the test fails because the wizard requires extensive earlier-step state to reach the agent step, simplify by extracting the env-related logic into a smaller testable surface — but only if necessary. First try the full walk-through.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @paperclipai/ui test OnboardingWizard.test.tsx --run
```

Expected: FAIL — either because the env editor can't be opened (Task 3 not yet done), or because `createAgentMock` is called without `adapterConfig.env`.

- [ ] **Step 3: Commit the failing test**

```bash
git add ui/src/components/OnboardingWizard.test.tsx
git commit -m "test(PAP-2): add failing integration test for env in OnboardingWizard"
```

---

### Task 3: Render EnvVarEditor and merge user env into buildAdapterConfig

**Files:**
- Modify: `ui/src/components/OnboardingWizard.tsx`

- [ ] **Step 1: Add EnvVarEditor rendering in the wizard's adapter-config step**

Locate the adapter-setup step in `OnboardingWizard.tsx` — search for where adapter type, model, command, and url fields are rendered together (likely a JSX block inside the step that runs around line 230+). Below the existing adapter fields and before the navigation buttons, add a collapsible disclosure containing the EnvVarEditor:

```tsx
<details className="border rounded-md p-3 bg-muted/40">
  <summary className="cursor-pointer text-sm font-medium select-none">
    Environment variables (advanced)
  </summary>
  <div className="mt-3">
    <p className="text-xs text-muted-foreground mb-2">
      Inject env vars into the spawned subprocess. Useful for things like
      <code className="mx-1">CLAUDE_CONFIG_DIR</code>
      to point at an alternate Claude Code config.
    </p>
    <EnvVarEditor
      value={userEnv}
      secrets={availableSecrets}
      onCreateSecret={async (name, value) => {
        const created = await createSecret.mutateAsync({ name, value });
        return created;
      }}
      onChange={(env) => setUserEnv(env ?? {})}
    />
  </div>
</details>
```

Use the codebase's preferred Tailwind/CSS conventions for the collapsible. If the codebase has a `<Collapsible>` or `<Accordion>` primitive (look in `ui/src/components/ui/`), prefer that over `<details>`. Match the existing file's style.

- [ ] **Step 2: Merge user env into `buildAdapterConfig()` output**

Edit the existing `buildAdapterConfig()` function (around lines 316-350). Replace the current ANTHROPIC_API_KEY block with a merged version that incorporates `userEnv` first:

```typescript
function buildAdapterConfig(): Record<string, unknown> {
  const adapter = getUIAdapter(adapterType);
  const config = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType,
    model:
      adapterType === "codex_local"
        ? model || DEFAULT_CODEX_LOCAL_MODEL
        : adapterType === "gemini_local"
          ? model || DEFAULT_GEMINI_LOCAL_MODEL
        : adapterType === "cursor"
        ? model || DEFAULT_CURSOR_LOCAL_MODEL
        : model,
    command,
    args,
    url,
    dangerouslySkipPermissions:
      adapterType === "claude_local" || adapterType === "opencode_local",
    dangerouslyBypassSandbox:
      adapterType === "codex_local"
        ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
        : defaultCreateValues.dangerouslyBypassSandbox
  });

  // Merge user-defined env into the adapter-built config.
  // Order:
  //   1) start from whatever the adapter built (existing behavior)
  //   2) layer user env on top — user takes precedence over adapter defaults
  //   3) ANTHROPIC_API_KEY auto-injection for claude_local + forceUnsetAnthropicApiKey
  //      runs LAST, so it can still force the key to empty when the user opted in.
  //      User-provided ANTHROPIC_API_KEY would be overridden by this — that's
  //      consistent with the existing "force unset" semantics.
  const baseEnv =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {};
  const mergedEnv: Record<string, unknown> = { ...baseEnv, ...userEnv };

  if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
    mergedEnv.ANTHROPIC_API_KEY = { type: "plain", value: "" };
  }

  if (Object.keys(mergedEnv).length > 0) {
    config.env = mergedEnv;
  }

  return config;
}
```

The `if (Object.keys(mergedEnv).length > 0)` guard avoids attaching an empty `env: {}` to adapter configs that don't need it — preserves existing behavior when neither the user nor the auto-inject path has anything to add.

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @paperclipai/ui typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the integration test**

```bash
pnpm --filter @paperclipai/ui test OnboardingWizard.test.tsx --run
```

Expected: PASS. If the test fails because of placeholder regex mismatches or selector issues, fix the test (not the implementation) — the implementation should be correct from the merge logic.

- [ ] **Step 5: Run the full UI test suite to confirm no regressions**

```bash
pnpm --filter @paperclipai/ui test --run
```

Expected: All previously-passing tests still pass. If any pre-existing test fails, investigate whether it's a real regression from this change. If unrelated/pre-existing failure, document in the commit message.

- [ ] **Step 6: Commit the implementation**

```bash
git add ui/src/components/OnboardingWizard.tsx
git commit -m "feat(PAP-2): expose env vars in OnboardingWizard agent setup"
```

---

### Task 4: Manual smoke test against running dev server

**Files:** none modified (verification only)

- [ ] **Step 1: Start (or restart) the dev server**

If a dev server is already running from PAP-1 work, leave it. Otherwise:

```bash
PORT=4500 pnpm dev
```

(Use `PORT=4500` per the discovery in PAP-1 — `.env` files are not auto-loaded for main clones; see PAP-5 for the underlying issue.)

- [ ] **Step 2: Open the UI**

Open: `http://127.0.0.1:4500`

If a company already exists from earlier work, you'll need a fresh state to hit the OnboardingWizard. Either:
- Delete the existing instance state (`rm -rf ~/.paperclip/instances/default`) and restart, OR
- Use the API directly to delete the existing company and let the wizard re-trigger.

- [ ] **Step 3: Walk through the wizard**

1. Create a test company.
2. On the agent setup step, leave adapter type as `claude_local`.
3. Expand the new "Environment variables (advanced)" disclosure.
4. Add a row: key `CLAUDE_CONFIG_DIR`, value `/Users/bfeld/.claude-paperclip` (use the actual path).
5. Complete the wizard.

- [ ] **Step 4: Verify the agent has the env binding**

```bash
# Find the new agent's company id and agent id, then:
CID=$(curl -sf http://127.0.0.1:4500/api/companies | python3 -c "import sys,json; print(json.load(sys.stdin)[-1]['id'])")
AID=$(curl -sf "http://127.0.0.1:4500/api/companies/$CID/agents" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
curl -sf "http://127.0.0.1:4500/api/agents/$AID" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['adapterConfig'].get('env'), indent=2))"
```

Expected output: a JSON object with `CLAUDE_CONFIG_DIR` set to (server-normalized form) `{"type":"plain","value":"/Users/bfeld/.claude-paperclip"}`.

If the output is `null` or missing the key, the wizard didn't actually submit it. Check browser devtools network tab for the `POST /api/companies/.../agents` request payload and trace from there.

- [ ] **Step 5: Capture the verification in a Linear comment on PAP-2**

Use the Linear MCP from this session, or note in the PR description that the smoke test passed with the verification command output.

---

## Self-Review Checklist

Run through this before handing off:

1. **Spec coverage** — does each piece of the ticket map to a task?
   - "Add Environment Variables section to agent adapter config form" → Task 3 Step 1 ✅
   - "Free-form key/value pairs" → EnvVarEditor (already supports this) ✅
   - "Toggle for plain vs secret_ref binding type" → EnvVarEditor (already supports this) ✅
   - "Validation per envConfigSchema" → server-side, already enforced ✅

2. **Placeholder scan** — search the plan for "TBD" / "implement later" / "fill in details" — none present.

3. **Type consistency** — `userEnv` is `Record<string, EnvBinding>` everywhere; `EnvVarEditor`'s `value` prop accepts the same. `mergedEnv` is `Record<string, unknown>` to match the existing `config.env` typing in `buildAdapterConfig`'s return shape.

4. **Open question for the implementer**: the `<details>` element vs. an existing UI primitive — the implementer should pick whatever matches the codebase's conventions. Both work; matching existing patterns gets the visual styling right.

---

## Out of scope (do NOT do in this PR)

- Refactoring `OnboardingWizard.tsx` (it's 1343 lines but that's not this ticket's problem).
- Changing `EnvVarEditor.tsx`.
- Adding env editing to other places (already exists in `AgentConfigForm`; nothing else needs it now).
- Auto-detecting the user's `~/.claude-paperclip/` path or prepopulating the env field — that's a separate Brad-personal convenience, not a Paperclip product feature.
- The `agentsApi.create` payload shape — already supported by the server (PATCH route shallow-merges; CREATE route accepts the env field via `adapterConfigSchema`).

---

## Commit policy

The plan creates 3 commits:
1. `feat(PAP-2): add env state and secrets wiring to OnboardingWizard`
2. `test(PAP-2): add failing integration test for env in OnboardingWizard`
3. `feat(PAP-2): expose env vars in OnboardingWizard agent setup`

When ready to PR, use `/commit` (or whatever the paperclip repo's commit convention is — see the project's CONTRIBUTING.md or the GitHub issue companion for any specifics).

PR title suggestion: `feat: expose env vars in OnboardingWizard agent setup (#4542)` — referencing the GitHub issue companion.
