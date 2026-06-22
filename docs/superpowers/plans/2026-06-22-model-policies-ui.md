# Company Model Policies UI Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Also use the `design-guide` and `frontend-design` skills when building the page component (Task 3).** This is a user-facing company-settings page; it must match the Paperclip design language.

**Goal:** Add a company-settings page where an operator can view, add, edit, delete, and reorder the ordered list of model-policy rules for the selected company, persisted through the existing `GET/PUT /companies/:companyId/model-policies` API (Plan A — already shipped).

**Architecture:** This is "Plan B" of the model-policy feature; the DB-backed backend (`docs/superpowers/plans/2026-06-21-model-policies-db-backend.md`) is already merged. A company's policy is a **single ordered array of rules** with **first-match-wins** precedence — not per-row CRUD. The UI therefore loads the whole array (`GET`), edits a **local working copy**, and saves the **entire array atomically** (`PUT`). The feature is layered so each layer is independently testable: a typed API module → a query key → pure rule-list helpers (where add/remove/update/**reorder** logic lives, unit-tested without a DOM) → the page component (jsdom smoke test) → route + sidebar wiring. It mirrors the existing **Company Skills** settings feature for every cross-cutting pattern (data fetching, toasts, layout, route registration, nav).

**Tech Stack:** React 19, `react-router-dom@7` (imported via the `@/lib/router` re-export wrapper), `@tanstack/react-query@5`, Vitest 3 (default `environment: "node"`; component tests opt into jsdom with a `// @vitest-environment jsdom` docblock and render via raw `react-dom/client` `createRoot` + `act` — **there is no `@testing-library/react` in this repo**), design-system primitives in `ui/src/components/ui/*`.

## Global Constraints

- **First-match-wins ordering is load-bearing.** Rule order in the array IS the precedence. Never reorder rules implicitly (e.g. don't sort). Save persists the exact visible order.
- **Atomic save only.** Persist via a single `PUT /companies/:companyId/model-policies` with the full `{ rules }` array. Never issue per-rule writes — the backend stores one `rules` jsonb document per company.
- **Purely additive / fail-safe.** This plan changes no dispatch or server behavior. A company with no rules behaves exactly as before (empty array).
- **Reuse shared constants — never hardcode value lists.** Import `MODEL_PROFILE_KEYS` / `ModelProfileKey`, `AGENT_ROLES` / `AGENT_ROLE_LABELS`, `ISSUE_PRIORITIES`, `ISSUE_WORK_MODES` from `@paperclipai/shared`. The form maps over these. `wakeReason` has no enum → free-text entry.
- **Rule shape (mirror of `server/src/services/model-policy.ts` + `model-policy-schema.ts`):**
  ```ts
  interface ModelPolicyMatch {
    agentRole?: string[];
    wakeReason?: string[];
    issuePriority?: string[];
    workMode?: string[];
  }
  interface ModelPolicyRule {
    when: ModelPolicyMatch;   // empty object = matches everything
    modelProfile: ModelProfileKey;   // "cheap" | "deep" | "bulk"
    reason?: string;
  }
  ```
  The UI types live in `ui/src/api/modelPolicies.ts` and **must stay in sync** with the server schema. `modelProfile` reuses the shared `ModelProfileKey` so the enum can't drift.
- **API base path:** `/companies/${encodeURIComponent(companyId)}/model-policies`. The shared HTTP client is `import { api } from "./client"` (methods `get`/`post`/`put`/`patch`/`delete`; base `/api`; throws `ApiError`).
- **HTTP client mock pattern in tests** (used by every `ui/src/api/*.test.ts`): `const mockApi = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))` then `vi.mock("./client", () => ({ api: mockApi }))`.

---

## File Structure

- `ui/src/api/modelPolicies.ts` (create) — typed API client + the `ModelPolicyRule` / `ModelPolicyMatch` / `CompanyModelPolicyResponse` UI types. One responsibility: talking to the backend.
- `ui/src/api/modelPolicies.test.ts` (create) — asserts the GET/PUT paths and bodies via the mocked client.
- `ui/src/lib/queryKeys.ts` (modify) — add a `modelPolicies.list(companyId)` key alongside `companySkills`.
- `ui/src/lib/modelPolicyRules.ts` (create) — **pure** rule-list helpers: `emptyRule`, `addRule`, `removeRule`, `updateRule`, `moveRule`, `setSignal`, `normalizeRules`, `isDirty`. One responsibility: immutable array transforms. No React, no I/O.
- `ui/src/lib/modelPolicyRules.test.ts` (create) — unit tests for the helpers (node env).
- `ui/src/pages/CompanyModelPolicies.tsx` (create) — the page: loads policy, edits a local working copy, renders an ordered list of rule editors with reorder/delete, Add/Save/Discard. Built with `design-guide` + `frontend-design`.
- `ui/src/pages/CompanyModelPolicies.test.tsx` (create) — jsdom smoke test: renders rules from a mocked query, "Add rule" appends a row, "Save" calls the save mutation.
- `ui/src/App.tsx` (modify) — register the route in `boardRoutes()` next to the other `company/settings/*` routes.
- `ui/src/components/CompanySettingsSidebar.tsx` (modify) — add a "Model Policies" nav item.

---

### Task 1: API client module + query key

**Files:**
- Create: `ui/src/api/modelPolicies.ts`
- Test: `ui/src/api/modelPolicies.test.ts`
- Modify: `ui/src/lib/queryKeys.ts`

**Interfaces:**
- Consumes: `api` from `ui/src/api/client.ts` (`api.get<T>(path)`, `api.put<T>(path, body)`); `ModelProfileKey` from `@paperclipai/shared`.
- Produces (used by Tasks 2–3):
  - `interface ModelPolicyMatch { agentRole?: string[]; wakeReason?: string[]; issuePriority?: string[]; workMode?: string[] }`
  - `interface ModelPolicyRule { when: ModelPolicyMatch; modelProfile: ModelProfileKey; reason?: string }`
  - `interface CompanyModelPolicyResponse { rules: ModelPolicyRule[] }`
  - `modelPoliciesApi.get(companyId: string): Promise<CompanyModelPolicyResponse>`
  - `modelPoliciesApi.save(companyId: string, rules: ModelPolicyRule[]): Promise<CompanyModelPolicyResponse>`
  - `queryKeys.modelPolicies.list(companyId: string)` → `["model-policies", companyId]`

- [ ] **Step 1: Write the failing test**

Create `ui/src/api/modelPolicies.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { modelPoliciesApi } from "./modelPolicies";
import type { ModelPolicyRule } from "./modelPolicies";

describe("modelPoliciesApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.put.mockReset();
    mockApi.get.mockResolvedValue({ rules: [] });
    mockApi.put.mockResolvedValue({ rules: [] });
  });

  it("GETs the company model policy at the company-scoped path", async () => {
    await modelPoliciesApi.get("company 1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company%201/model-policies");
  });

  it("PUTs the full rules array as { rules }", async () => {
    const rules: ModelPolicyRule[] = [
      { when: { issuePriority: ["high"] }, modelProfile: "deep", reason: "urgent" },
      { when: {}, modelProfile: "cheap" },
    ];
    await modelPoliciesApi.save("c1", rules);
    expect(mockApi.put).toHaveBeenCalledWith("/companies/c1/model-policies", { rules });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/api/modelPolicies.test.ts`
Expected: FAIL with "Cannot find module './modelPolicies'".
> If the `@paperclipai/ui` filter name is wrong, get the exact package name with `node -e "console.log(require('./ui/package.json').name)"` from the repo root and use it for every `pnpm --filter` command in this plan. (Confirmed package dir is `ui/`.)

- [ ] **Step 3: Write the API module**

Create `ui/src/api/modelPolicies.ts`:

```ts
import type { ModelProfileKey } from "@paperclipai/shared";
import { api } from "./client";

/** Mirrors server/src/services/model-policy.ts `ModelPolicyMatch`. An omitted
 *  key imposes no constraint; an empty `when` (no keys) matches every task. */
export interface ModelPolicyMatch {
  agentRole?: string[];
  wakeReason?: string[];
  issuePriority?: string[];
  workMode?: string[];
}

/** Mirrors server/src/services/model-policy.ts `ModelPolicyRule`. */
export interface ModelPolicyRule {
  when: ModelPolicyMatch;
  modelProfile: ModelProfileKey;
  reason?: string;
}

export interface CompanyModelPolicyResponse {
  rules: ModelPolicyRule[];
}

export const modelPoliciesApi = {
  get: (companyId: string) =>
    api.get<CompanyModelPolicyResponse>(
      `/companies/${encodeURIComponent(companyId)}/model-policies`,
    ),
  save: (companyId: string, rules: ModelPolicyRule[]) =>
    api.put<CompanyModelPolicyResponse>(
      `/companies/${encodeURIComponent(companyId)}/model-policies`,
      { rules },
    ),
};
```

- [ ] **Step 4: Add the query key**

In `ui/src/lib/queryKeys.ts`, add a `modelPolicies` group next to the existing `companySkills` group (match the existing `as const` style exactly):

```ts
  modelPolicies: {
    list: (companyId: string) => ["model-policies", companyId] as const,
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/api/modelPolicies.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @paperclipai/ui exec tsc -b`
Expected: PASS (clean).

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/modelPolicies.ts ui/src/api/modelPolicies.test.ts ui/src/lib/queryKeys.ts
git commit -m "feat(ui): model-policies API client + query key"
```

---

### Task 2: Pure rule-list helpers

**Files:**
- Create: `ui/src/lib/modelPolicyRules.ts`
- Test: `ui/src/lib/modelPolicyRules.test.ts`

**Interfaces:**
- Consumes: `ModelPolicyRule`, `ModelPolicyMatch` from `../api/modelPolicies`; `ModelProfileKey` from `@paperclipai/shared`.
- Produces (used by Task 3):
  - `SIGNAL_KEYS: readonly ["agentRole","wakeReason","issuePriority","workMode"]`; `type SignalKey = (typeof SIGNAL_KEYS)[number]`
  - `emptyRule(defaultProfile: ModelProfileKey): ModelPolicyRule`
  - `addRule(rules: ModelPolicyRule[], rule: ModelPolicyRule): ModelPolicyRule[]`
  - `removeRule(rules: ModelPolicyRule[], index: number): ModelPolicyRule[]`
  - `updateRule(rules: ModelPolicyRule[], index: number, next: ModelPolicyRule): ModelPolicyRule[]`
  - `moveRule(rules: ModelPolicyRule[], index: number, dir: "up" | "down"): ModelPolicyRule[]`
  - `setSignal(rule: ModelPolicyRule, key: SignalKey, values: string[]): ModelPolicyRule`
  - `normalizeRules(rules: ModelPolicyRule[]): ModelPolicyRule[]`
  - `isDirty(a: ModelPolicyRule[], b: ModelPolicyRule[]): boolean`

All helpers are pure and return new arrays/objects (never mutate inputs).

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/modelPolicyRules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ModelPolicyRule } from "../api/modelPolicies";
import {
  SIGNAL_KEYS,
  addRule,
  emptyRule,
  isDirty,
  moveRule,
  normalizeRules,
  removeRule,
  setSignal,
  updateRule,
} from "./modelPolicyRules";

const r = (mp: "cheap" | "deep" | "bulk", when: Record<string, string[]> = {}): ModelPolicyRule => ({
  when,
  modelProfile: mp,
});

describe("modelPolicyRules helpers", () => {
  it("SIGNAL_KEYS lists the four match signals", () => {
    expect(SIGNAL_KEYS).toEqual(["agentRole", "wakeReason", "issuePriority", "workMode"]);
  });

  it("emptyRule has an empty when and the given default profile", () => {
    expect(emptyRule("cheap")).toEqual({ when: {}, modelProfile: "cheap" });
  });

  it("addRule appends without mutating the input", () => {
    const base = [r("cheap")];
    const next = addRule(base, r("deep"));
    expect(next).toHaveLength(2);
    expect(next[1].modelProfile).toBe("deep");
    expect(base).toHaveLength(1); // not mutated
  });

  it("removeRule drops the rule at the index", () => {
    expect(removeRule([r("cheap"), r("deep"), r("bulk")], 1)).toEqual([r("cheap"), r("bulk")]);
  });

  it("updateRule replaces the rule at the index", () => {
    expect(updateRule([r("cheap"), r("deep")], 0, r("bulk"))).toEqual([r("bulk"), r("deep")]);
  });

  it("moveRule up swaps with the previous item", () => {
    expect(moveRule([r("cheap"), r("deep")], 1, "up")).toEqual([r("deep"), r("cheap")]);
  });

  it("moveRule down swaps with the next item", () => {
    expect(moveRule([r("cheap"), r("deep")], 0, "down")).toEqual([r("deep"), r("cheap")]);
  });

  it("moveRule clamps at the boundaries (no-op, returns equal content)", () => {
    expect(moveRule([r("cheap"), r("deep")], 0, "up")).toEqual([r("cheap"), r("deep")]);
    expect(moveRule([r("cheap"), r("deep")], 1, "down")).toEqual([r("cheap"), r("deep")]);
  });

  it("setSignal sets a non-empty value list under when[key]", () => {
    const next = setSignal(r("cheap"), "issuePriority", ["high", "critical"]);
    expect(next.when.issuePriority).toEqual(["high", "critical"]);
  });

  it("setSignal removes the key when given an empty list", () => {
    const start = r("cheap", { issuePriority: ["high"] });
    const next = setSignal(start, "issuePriority", []);
    expect(next.when).toEqual({});
  });

  it("isDirty is false for structurally equal rule sets regardless of signal key order", () => {
    const a: ModelPolicyRule[] = [{ when: { issuePriority: ["high"], workMode: ["planning"] }, modelProfile: "deep" }];
    const b: ModelPolicyRule[] = [{ when: { workMode: ["planning"], issuePriority: ["high"] }, modelProfile: "deep" }];
    expect(isDirty(a, b)).toBe(false);
  });

  it("isDirty is true when a rule changes", () => {
    expect(isDirty([r("cheap")], [r("deep")])).toBe(true);
  });

  it("normalizeRules orders the when keys by SIGNAL_KEYS and drops empty arrays", () => {
    const normalized = normalizeRules([
      { when: { workMode: ["planning"], issuePriority: [], agentRole: ["engineer"] }, modelProfile: "deep" },
    ]);
    expect(Object.keys(normalized[0].when)).toEqual(["agentRole", "workMode"]);
    expect(normalized[0].when).not.toHaveProperty("issuePriority");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/modelPolicyRules.test.ts`
Expected: FAIL with "Cannot find module './modelPolicyRules'".

- [ ] **Step 3: Write the helpers**

Create `ui/src/lib/modelPolicyRules.ts`:

```ts
import type { ModelProfileKey } from "@paperclipai/shared";
import type { ModelPolicyMatch, ModelPolicyRule } from "../api/modelPolicies";

export const SIGNAL_KEYS = ["agentRole", "wakeReason", "issuePriority", "workMode"] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export function emptyRule(defaultProfile: ModelProfileKey): ModelPolicyRule {
  return { when: {}, modelProfile: defaultProfile };
}

export function addRule(rules: ModelPolicyRule[], rule: ModelPolicyRule): ModelPolicyRule[] {
  return [...rules, rule];
}

export function removeRule(rules: ModelPolicyRule[], index: number): ModelPolicyRule[] {
  return rules.filter((_, i) => i !== index);
}

export function updateRule(
  rules: ModelPolicyRule[],
  index: number,
  next: ModelPolicyRule,
): ModelPolicyRule[] {
  return rules.map((rule, i) => (i === index ? next : rule));
}

export function moveRule(
  rules: ModelPolicyRule[],
  index: number,
  dir: "up" | "down",
): ModelPolicyRule[] {
  const target = index + (dir === "up" ? -1 : 1);
  if (target < 0 || target >= rules.length) return rules;
  const copy = rules.slice();
  const tmp = copy[index];
  copy[index] = copy[target];
  copy[target] = tmp;
  return copy;
}

export function setSignal(
  rule: ModelPolicyRule,
  key: SignalKey,
  values: string[],
): ModelPolicyRule {
  const when: ModelPolicyMatch = { ...rule.when };
  if (values.length === 0) {
    delete when[key];
  } else {
    when[key] = values;
  }
  return { ...rule, when };
}

/** Rebuild each rule's `when` with keys in SIGNAL_KEYS order, dropping empty
 *  arrays, and omit an undefined `reason`. Produces a canonical form for
 *  equality checks and for the save payload. */
export function normalizeRules(rules: ModelPolicyRule[]): ModelPolicyRule[] {
  return rules.map((rule) => {
    const when: ModelPolicyMatch = {};
    for (const key of SIGNAL_KEYS) {
      const value = rule.when[key];
      if (value && value.length > 0) {
        when[key] = [...value];
      }
    }
    const normalized: ModelPolicyRule = { when, modelProfile: rule.modelProfile };
    if (rule.reason && rule.reason.trim().length > 0) {
      normalized.reason = rule.reason;
    }
    return normalized;
  });
}

export function isDirty(a: ModelPolicyRule[], b: ModelPolicyRule[]): boolean {
  return JSON.stringify(normalizeRules(a)) !== JSON.stringify(normalizeRules(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/modelPolicyRules.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @paperclipai/ui exec tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/modelPolicyRules.ts ui/src/lib/modelPolicyRules.test.ts
git commit -m "feat(ui): pure model-policy rule-list helpers (add/remove/move/dirty)"
```

---

### Task 3: The Company Model Policies page

**Files:**
- Create: `ui/src/pages/CompanyModelPolicies.tsx`
- Test: `ui/src/pages/CompanyModelPolicies.test.tsx`

> **Use the `design-guide` and `frontend-design` skills for this task.** The code below is a correct, design-system-consistent starting point (it imports only existing `@/components/ui/*` primitives and mirrors `CompanySkills.tsx`), but invoke those skills to refine spacing, hierarchy, empty states, and copy before committing.

**Interfaces:**
- Consumes: `modelPoliciesApi`, `ModelPolicyRule` from `../api/modelPolicies`; all helpers from `../lib/modelPolicyRules`; `queryKeys` from `../lib/queryKeys`; `useCompany` from `../context/CompanyContext`; the toast + breadcrumb hooks; `AGENT_ROLES`, `AGENT_ROLE_LABELS`, `ISSUE_PRIORITIES`, `ISSUE_WORK_MODES`, `MODEL_PROFILE_KEYS` from `@paperclipai/shared`; design primitives from `@/components/ui/*`.
- Produces: a default-exported (and named) React component `CompanyModelPolicies` consumed by `App.tsx` (Task 4).

- [ ] **Step 1: Reconnaissance (no code change) — confirm the exact hook/import names**

The cross-cutting hooks differ subtly across pages. Before writing the component, confirm the exact names by reading `ui/src/pages/CompanySkills.tsx`'s import block and copy them verbatim:
- Company id hook: `useCompany()` → property name (`selectedCompanyId`).
- Toast hook: `useToastActions()` vs `useToast()` and the call shape (`pushToast({ tone, title, body })`). Use whichever `CompanySkills.tsx` uses.
- Breadcrumb hook: `useBreadcrumbs()` → `setBreadcrumbs([...])`.
- Router: `import { useNavigate } from "@/lib/router"` (re-exports `react-router-dom`). Only needed if you navigate; this page does not, so it can be omitted.
- Design primitives: confirm `Select` is exported from `@/components/ui/select` as `Select, SelectTrigger, SelectValue, SelectContent, SelectItem`, and `Label` from `@/components/ui/label`.

If any name differs from what the code in Step 3 uses, adjust the import/usage to the real name. **Do not invent names.**

- [ ] **Step 2: Write the failing component test**

Create `ui/src/pages/CompanyModelPolicies.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.fn();
const getMock = vi.fn();

vi.mock("../api/modelPolicies", async () => {
  const actual = await vi.importActual<typeof import("../api/modelPolicies")>("../api/modelPolicies");
  return {
    ...actual,
    modelPoliciesApi: {
      get: getMock,
      save: saveMock,
    },
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Acme" } }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { CompanyModelPolicies } from "./CompanyModelPolicies";

let container: HTMLDivElement;
let root: Root;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={client}>
      <CompanyModelPolicies />
    </QueryClientProvider>,
  );
}

async function flush() {
  // allow the useQuery promise microtasks to resolve
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset();
  saveMock.mockResolvedValue({ rules: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CompanyModelPolicies", () => {
  it("renders existing rules from the loaded policy", async () => {
    getMock.mockResolvedValue({
      rules: [{ when: { issuePriority: ["high"] }, modelProfile: "deep", reason: "urgent work" }],
    });
    act(() => renderPage());
    await flush();
    expect(container.textContent).toContain("urgent work");
  });

  it("'Add rule' appends a new rule row", async () => {
    getMock.mockResolvedValue({ rules: [] });
    act(() => renderPage());
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("add rule"),
    );
    expect(addButton).toBeTruthy();
    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // A rule editor now exists — find the Save button enabled by the dirty state.
    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("save"),
    );
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save persists the working copy via modelPoliciesApi.save", async () => {
    getMock.mockResolvedValue({ rules: [] });
    act(() => renderPage());
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("add rule"),
    )!;
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("save"),
    )!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith("company-1", [{ when: {}, modelProfile: "cheap" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyModelPolicies.test.tsx`
Expected: FAIL with "Cannot find module './CompanyModelPolicies'".

- [ ] **Step 4: Write the page component**

Create `ui/src/pages/CompanyModelPolicies.tsx`. (Adjust the toast/breadcrumb hook imports to the exact names confirmed in Step 1.)

```tsx
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  ISSUE_PRIORITIES,
  ISSUE_WORK_MODES,
  MODEL_PROFILE_KEYS,
  type ModelProfileKey,
} from "@paperclipai/shared";
import { ArrowDown, ArrowUp, Cpu, Plus, Trash2 } from "lucide-react";
import { modelPoliciesApi, type ModelPolicyRule } from "../api/modelPolicies";
import {
  SIGNAL_KEYS,
  addRule,
  emptyRule,
  isDirty,
  moveRule,
  normalizeRules,
  removeRule,
  setSignal,
  updateRule,
  type SignalKey,
} from "../lib/modelPolicyRules";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PROFILE_LABELS: Record<ModelProfileKey, string> = {
  cheap: "Cheap",
  deep: "Deep",
  bulk: "Bulk",
};

const SIGNAL_LABELS: Record<SignalKey, string> = {
  agentRole: "Agent role",
  wakeReason: "Wake reason",
  issuePriority: "Issue priority",
  workMode: "Work mode",
};

// Known value options per signal. wakeReason has no enum -> free text.
const SIGNAL_OPTIONS: Record<SignalKey, { value: string; label: string }[] | null> = {
  agentRole: AGENT_ROLES.map((role) => ({ value: role, label: AGENT_ROLE_LABELS[role] })),
  issuePriority: ISSUE_PRIORITIES.map((p) => ({ value: p, label: p })),
  workMode: ISSUE_WORK_MODES.map((m) => ({ value: m, label: m })),
  wakeReason: null,
};

export function CompanyModelPolicies() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const policyQuery = useQuery({
    queryKey: queryKeys.modelPolicies.list(selectedCompanyId ?? ""),
    queryFn: () => modelPoliciesApi.get(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const loadedRules = policyQuery.data?.rules;
  const [draft, setDraft] = useState<ModelPolicyRule[]>([]);

  // Sync the working copy from the server whenever fresh data arrives.
  useEffect(() => {
    if (loadedRules) setDraft(loadedRules);
  }, [loadedRules]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Settings", href: "/company/settings" }, { label: "Model Policies" }]);
  }, [setBreadcrumbs]);

  const dirty = useMemo(
    () => Boolean(loadedRules) && isDirty(draft, loadedRules ?? []),
    [draft, loadedRules],
  );

  const saveMutation = useMutation({
    mutationFn: (rules: ModelPolicyRule[]) => modelPoliciesApi.save(selectedCompanyId!, normalizeRules(rules)),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.modelPolicies.list(selectedCompanyId!),
      });
      setDraft(response.rules);
      pushToast({ tone: "success", title: "Model policy saved", body: "Rules updated for this company." });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Could not save the model policy.",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cpu} message="Select a company to manage model policies." />;
  }
  if (policyQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }
  if (policyQuery.error) {
    return (
      <div className="px-4 py-6 text-sm text-destructive">
        {policyQuery.error instanceof Error ? policyQuery.error.message : "Failed to load model policies."}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="text-sm font-bold text-foreground">Model Policies</h1>
          <p className="text-xs text-muted-foreground">
            Rules are evaluated top to bottom; the first match selects the model profile. An
            explicit per-issue override still wins over these rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => setDraft(loadedRules ?? [])}
          >
            Discard
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? "Saving..." : "Save policy"}
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {draft.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No rules yet. Without rules, every task uses the agent's default profile.
          </p>
        ) : (
          <ol className="space-y-3">
            {draft.map((rule, index) => (
              <RuleEditor
                key={index}
                index={index}
                total={draft.length}
                rule={rule}
                onChange={(next) => setDraft((cur) => updateRule(cur, index, next))}
                onRemove={() => setDraft((cur) => removeRule(cur, index))}
                onMove={(dir) => setDraft((cur) => moveRule(cur, index, dir))}
              />
            ))}
          </ol>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="mt-4"
          onClick={() => setDraft((cur) => addRule(cur, emptyRule("cheap")))}
        >
          <Plus className="mr-1 h-4 w-4" /> Add rule
        </Button>
      </div>
    </div>
  );
}

function RuleEditor({
  index,
  total,
  rule,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  rule: ModelPolicyRule;
  onChange: (next: ModelPolicyRule) => void;
  onRemove: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">Rule {index + 1}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove("up")} aria-label="Move rule up">
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" disabled={index === total - 1} onClick={() => onMove("down")} aria-label="Move rule down">
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Delete rule">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {SIGNAL_KEYS.map((key) => (
          <SignalField
            key={key}
            signalKey={key}
            values={rule.when[key] ?? []}
            onChange={(values) => onChange(setSignal(rule, key, values))}
          />
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Model profile</Label>
          <Select
            value={rule.modelProfile}
            onValueChange={(value) => onChange({ ...rule, modelProfile: value as ModelProfileKey })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_PROFILE_KEYS.map((profile) => (
                <SelectItem key={profile} value={profile}>
                  {PROFILE_LABELS[profile]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Reason (optional)</Label>
          <Input
            value={rule.reason ?? ""}
            placeholder="why this rule"
            onChange={(event) =>
              onChange({ ...rule, reason: event.target.value === "" ? undefined : event.target.value })
            }
          />
        </div>
      </div>
    </li>
  );
}

function SignalField({
  signalKey,
  values,
  onChange,
}: {
  signalKey: SignalKey;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const options = SIGNAL_OPTIONS[signalKey];
  return (
    <div className="space-y-1">
      <Label className="text-xs">{SIGNAL_LABELS[signalKey]}</Label>
      {options ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt) => {
            const active = values.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  onChange(active ? values.filter((v) => v !== opt.value) : [...values, opt.value])
                }
                className={
                  active
                    ? "rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-xs text-primary"
                    : "rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      ) : (
        <Input
          value={values.join(", ")}
          placeholder="comma,separated"
          onChange={(event) =>
            onChange(
              event.target.value
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
        />
      )}
    </div>
  );
}

export default CompanyModelPolicies;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyModelPolicies.test.tsx`
Expected: PASS (3 tests). If the `Select` component renders a portal that confuses jsdom, the three assertions here only touch the header buttons and the "Add rule" button (not the Select), so they should pass; if a `Select` portal throws in jsdom, wrap the Select usage check out of the test (the test never opens the Select).

- [ ] **Step 6: Apply design-guide / frontend-design polish**

Invoke the `design-guide` and `frontend-design` skills and refine: header/section spacing, the rule-card visual hierarchy, the signal chips, the empty state, and microcopy. Keep the component's public surface (`CompanyModelPolicies`, default export) and the test green.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @paperclipai/ui exec tsc -b`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/CompanyModelPolicies.tsx ui/src/pages/CompanyModelPolicies.test.tsx
git commit -m "feat(ui): company model policies editor page"
```

---

### Task 4: Route registration + sidebar nav

**Files:**
- Modify: `ui/src/App.tsx` (the `boardRoutes()` function)
- Modify: `ui/src/components/CompanySettingsSidebar.tsx`

**Interfaces:**
- Consumes: `CompanyModelPolicies` from `./pages/CompanyModelPolicies` (Task 3).
- Produces: a reachable route `/company/settings/model-policies` and a sidebar entry linking to it.

- [ ] **Step 1: Recon — find the company-settings route group and nav block (no code change)**

Run:
```bash
grep -n "company/settings" ui/src/App.tsx
grep -n "SidebarNavItem" ui/src/components/CompanySettingsSidebar.tsx
```
Confirm the exact JSX shape of the sibling `company/settings/*` routes and the `SidebarNavItem` block (per the codebase map, routes look like `<Route path="company/settings/secrets" element={<Secrets />} />` and nav items like `<SidebarNavItem to="/company/settings/secrets" label="Secrets" icon={KeyRound} end />`). Note the lazy-vs-eager import convention for page components at the top of `App.tsx` and follow it.

- [ ] **Step 2: Register the route in `App.tsx`**

Add the import at the top of `ui/src/App.tsx` following the existing page-import convention (eager, matching `CompanySkills`):

```tsx
import { CompanyModelPolicies } from "./pages/CompanyModelPolicies";
```

Inside `boardRoutes()`, next to the other `company/settings/*` routes, add:

```tsx
<Route path="company/settings/model-policies" element={<CompanyModelPolicies />} />
```

- [ ] **Step 3: Add the sidebar nav entry**

In `ui/src/components/CompanySettingsSidebar.tsx`, add `Cpu` to the existing `lucide-react` import, then add a nav item after the "Secrets" item inside the `<div className="flex flex-col gap-0.5">`:

```tsx
<SidebarNavItem
  to="/company/settings/model-policies"
  label="Model Policies"
  icon={Cpu}
  end
/>
```

(If `Cpu` is already imported, don't duplicate it. If another icon better fits the design language per `design-guide`, use it.)

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @paperclipai/ui exec tsc -b`
Expected: PASS.

Run: `pnpm --filter @paperclipai/ui build`
Expected: build succeeds (route + import resolve).

- [ ] **Step 5: Run the full new test surface + the App test**

Run:
```bash
pnpm --filter @paperclipai/ui exec vitest run \
  src/api/modelPolicies.test.ts \
  src/lib/modelPolicyRules.test.ts \
  src/pages/CompanyModelPolicies.test.tsx \
  src/App.test.tsx
```
Expected: PASS. (`App.test.tsx` exercises route wiring; confirm the new route didn't break it.)

- [ ] **Step 6: Manual verification checklist (record results in the commit/PR)**

Start the UI dev server (`pnpm --filter @paperclipai/ui dev`), open a company, go to **Company Settings → Model Policies**, and confirm:
- The page loads (empty state when the company has no rules).
- "Add rule" adds a rule; signal chips toggle; profile select works; reason input works.
- Move up/down reorders; delete removes.
- "Save policy" persists (toast shows success); reload keeps the rules; "Discard" reverts unsaved edits.
- A second company with no policy still shows empty (no cross-company leakage).

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.tsx ui/src/components/CompanySettingsSidebar.tsx
git commit -m "feat(ui): route + sidebar nav for company model policies"
```

---

## Self-Review

**Spec coverage** (against the handoff `docs/superpowers/HANDOFF-2026-06-21-model-policy.md` §"Plan B — UI editor"):
- "A company-settings page to list/add/edit/delete/reorder rules" → list (Task 3 page), add (`addRule`), edit (`RuleEditor` + `updateRule`/`setSignal`), delete (`removeRule`), reorder (`moveRule` + up/down buttons). ✅
- "Mirror `ui/src/pages/CompanySkills.tsx`" → same `useCompany`/`useQuery`/`useMutation`/toast/`EmptyState`/`PageSkeleton`/design-primitive patterns. ✅
- "Touch: `ui/src/api/modelPolicies.ts`, `ui/src/pages/CompanyModelPolicies.tsx`, route in `ui/src/App.tsx` (boardRoutes()), nav in `ui/src/components/CompanySettingsSidebar.tsx`" → Tasks 1, 3, 4. ✅
- "Use the `design-guide` + `frontend-design` skills" → Task 3 Step 6 (and the task header). ✅
- "Keep the env-var fallback working; a company with a DB row ignores the env var" → No backend change here; the page only reads/writes via the existing service which already implements the fallback. ✅ (Out of scope for the UI.)
- Consumes the Plan A API exactly: `GET`/`PUT /companies/:companyId/model-policies` with `{ rules }`. ✅

**Out of scope (by design):** any backend change; per-rule (vs whole-document) endpoints; drag-and-drop reordering (dnd-kit is available but up/down buttons are simpler and fully unit-testable — noted as a possible enhancement); known-value autocomplete for `wakeReason` (free-text, no enum); a server-side `@paperclipai/shared` `ModelPolicyRule` type (UI mirrors the server type with a sync note rather than refactoring the server).

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Task 3 Step 1 and Task 4 Step 1 are real reconnaissance steps with concrete confirm-or-adjust outcomes (exact hook names; exact route/nav JSX), not placeholders — the surrounding code is fully written.

**Type consistency:** `ModelPolicyRule`/`ModelPolicyMatch`/`CompanyModelPolicyResponse` are defined in Task 1 and imported unchanged in Tasks 2–3. Helper names (`emptyRule`, `addRule`, `removeRule`, `updateRule`, `moveRule`, `setSignal`, `normalizeRules`, `isDirty`, `SIGNAL_KEYS`, `SignalKey`) are defined in Task 2 and used with identical signatures in Task 3. `modelPoliciesApi.get/save` (Task 1) are called identically in Task 3 and mocked identically in the Task 3 test. `queryKeys.modelPolicies.list` (Task 1) is used identically in Task 3. `ModelProfileKey` and the shared constant arrays come from `@paperclipai/shared`. The component export name `CompanyModelPolicies` (Task 3) matches the import in Task 4.

**Known risk / verify-at-execution:** The exact toast/breadcrumb hook names (`useToastActions` vs `useToast`, `pushToast` shape) and the `Select` export names are confirmed-then-adjusted in Task 3 Step 1 — the codebase map indicates these names, but the plan instructs the implementer to copy the verbatim names from `CompanySkills.tsx` and adjust if they differ. The `pnpm --filter` package name is verified in Task 1 Step 2 with a fallback command.
