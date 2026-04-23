# LM Studio Adapter — Dynamische Modell-Dropdowns pro URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Agent-Config-UI für den LM-Studio-Adapter laden „Modell" und „Fallback-Modell" ihre Optionen jeweils lazy vom `/v1/models`-Endpoint der zugehörigen URL (Primary bzw. Fallback); beide Felder bleiben als Combobox mit freier Eingabe; Fallback-Modell ist gesperrt, wenn Fallback-URL leer ist.

**Architecture:** Generische Schema-Erweiterung: der bereits existierende `combobox`-Feld-Typ in `ConfigFieldSchema` bekommt zwei neue `meta`-Schlüssel — `optionsFromUrlField` (Name eines URL-Feldes im selben Schema) und `disabledWhenEmpty`. `ServerAdapterModule.listModels` nimmt optional `{ url }` entgegen; der Paperclip-Server reicht einen neuen `?url=`-Query-Parameter durch. Im UI lädt eine neue Hilfskomponente `UrlModelsCombobox` die Modelle via React-Query (keyed auf URL) erst beim ersten Dropdown-Open.

**Tech Stack:** TypeScript, React (UI), React-Query, Vitest, Express-Style-Router (Server), Node `fetch` mit `AbortSignal.timeout` im Adapter.

**Spec-Referenz:** [docs/superpowers/specs/2026-04-23-lmstudio-dynamic-models-design.md](../specs/2026-04-23-lmstudio-dynamic-models-design.md)

**Arbeits-Repos:**
- Adapter (extern): `/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio/`
- Paperclip Monorepo: `/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip/`

---

## File Structure

Diese Tasks ändern folgende Dateien:

**Adapter-Package** (`opensource/paperclip-adapter-lmstudio/`):
- Modify: `src/server/index.ts` — `listModels(opts?)` + statisches `getConfigSchema()` mit `meta.optionsFromUrlField`/`disabledWhenEmpty`.
- Add: `tests/list-models.test.ts` — `listModels({ url })` + Schema-Shape.

**Shared Types** (`Paperclip/packages/adapter-utils/`):
- Modify: `src/types.ts` — `ServerAdapterModule.listModels` Signatur erweitern + `ConfigFieldMeta`-Utility-Interface dokumentieren.

**Paperclip-Server** (`Paperclip/server/`):
- Modify: `src/adapters/registry.ts:320-328` — `listAdapterModels(type, opts?)` mit try/catch.
- Modify: `src/routes/agents.ts:780-786` — Route liest `req.query.url`.
- Add: `src/adapters/__tests__/registry.models.test.ts` — Registry-Fehlerbehandlung.

**Paperclip-UI** (`Paperclip/ui/`):
- Modify: `src/api/agents.ts:166-169` — `adapterModels(companyId, type, url?)`.
- Modify: `src/lib/queryKeys.ts:26-27` — QueryKey nimmt optional `url` auf.
- Modify: `src/adapters/schema-config-fields.tsx` — `ComboboxField` um `onOpenChange` + `disabled` + `loading` erweitern; neuer Fall im `combobox`-Case für `optionsFromUrlField`; neue Hilfskomponente `UrlModelsCombobox`.
- Add: `src/adapters/__tests__/url-models-combobox.test.tsx` — UI-Verhalten.

**Aufrufer des bestehenden `adapterModels`-Clients bleiben unverändert** (NewIssueDialog, OnboardingWizard, AgentConfigForm) — der neue `url`-Parameter ist optional.

---

## Task 1: Adapter — listModels nimmt optionale URL entgegen

**Files:**
- Modify: `opensource/paperclip-adapter-lmstudio/src/server/index.ts:31-41`
- Test: `opensource/paperclip-adapter-lmstudio/tests/list-models.test.ts`

- [ ] **Step 1: Failing test anlegen**

Datei `opensource/paperclip-adapter-lmstudio/tests/list-models.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServerAdapter } from "../src/server/index.js";

describe("createServerAdapter().listModels", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("fetches from provided url when opts.url is given", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "my-model" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    const result = await adapter.listModels!({ url: "http://external:1234" });

    expect(seen).toEqual(["http://external:1234/v1/models"]);
    expect(result).toEqual([{ id: "my-model", label: "my-model" }]);
  });

  it("falls back to http://localhost:1234 when opts.url is missing", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    await adapter.listModels!();

    expect(seen).toEqual(["http://localhost:1234/v1/models"]);
  });

  it("returns [] when the configured host is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const adapter = createServerAdapter();
    const result = await adapter.listModels!({ url: "http://dead:9999" });

    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Test ausführen und Fehlschlag bestätigen**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio"
pnpm test -- list-models
```

Erwartet: FAIL — `listModels` akzeptiert aktuell kein `opts`-Argument / verwendet weiterhin `http://localhost:1234` trotz übergebener URL.

- [ ] **Step 3: listModels-Signatur erweitern**

`src/server/index.ts` — Änderungen:

```ts
interface ServerAdapterModule {
  type: string;
  execute: typeof execute;
  testEnvironment: typeof testEnvironment;
  agentConfigurationDoc?: string;
  supportsLocalAgentJwt?: boolean;
  listModels?: (opts?: { url?: string }) => Promise<Array<{ id: string; label: string }>>;
  getConfigSchema?: () => Promise<AdapterConfigSchema>;
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    async listModels(opts) {
      const url = opts?.url?.trim() || "http://localhost:1234";
      const models = await fetchModels(url);
      return models.map((id) => ({ id, label: id }));
    },
    async getConfigSchema() {
      // wird in Task 2 umgestellt — hier unverändert belassen
      ...
    },
  };
}
```

Wichtig: `getConfigSchema` in diesem Task noch nicht anfassen — das passiert in Task 2. Nur die `listModels`-Signatur + Implementierung ändern.

- [ ] **Step 4: Tests grün bekommen**

```bash
pnpm test -- list-models
```

Erwartet: alle 3 Tests PASS.

- [ ] **Step 5: Vollständiger Test-Lauf zur Regression-Absicherung**

```bash
pnpm test
```

Erwartet: Alle bestehenden Tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio" add src/server/index.ts tests/list-models.test.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio" commit -m "feat(lmstudio): listModels nimmt optionale { url } entgegen"
```

---

## Task 2: Adapter — getConfigSchema wird statisch, neue meta-Keys

**Files:**
- Modify: `opensource/paperclip-adapter-lmstudio/src/server/index.ts:42-128` (die `async getConfigSchema`-Methode)
- Test: `opensource/paperclip-adapter-lmstudio/tests/list-models.test.ts` (ergänzen)

- [ ] **Step 1: Failing tests für Schema-Shape ergänzen**

Anhängen an `tests/list-models.test.ts`:

```ts
describe("createServerAdapter().getConfigSchema", () => {
  it("does not perform any network requests", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const adapter = createServerAdapter();
    await adapter.getConfigSchema!();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("marks defaultModel as combobox driven by the `url` field", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const field = schema.fields.find((f) => f.key === "defaultModel");

    expect(field?.type).toBe("combobox");
    expect(field?.meta).toMatchObject({ optionsFromUrlField: "url" });
    expect(field?.options).toBeUndefined();
  });

  it("marks fallbackModel as combobox driven by fallbackUrl, disabled when empty", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema!();
    const field = schema.fields.find((f) => f.key === "fallbackModel");

    expect(field?.type).toBe("combobox");
    expect(field?.meta).toMatchObject({
      optionsFromUrlField: "fallbackUrl",
      disabledWhenEmpty: "fallbackUrl",
    });
  });
});
```

- [ ] **Step 2: Tests ausführen und Fehlschlag bestätigen**

```bash
pnpm test -- list-models
```

Erwartet: 3 neue Tests FAIL (Schema ruft aktuell `fetchModels`, `defaultModel` hat Optionen statt meta, `fallbackModel` ist noch `text`).

- [ ] **Step 3: getConfigSchema umbauen**

In `src/server/index.ts` die komplette `async getConfigSchema`-Methode ersetzen durch:

```ts
async getConfigSchema() {
  return {
    version: 1,
    fields: [
      {
        key: "url",
        label: "LM Studio URL",
        type: "text" as const,
        required: true,
        default: "http://localhost:1234",
        hint: "URL des LM Studio Servers",
      },
      {
        key: "defaultModel",
        label: "Modell",
        type: "combobox" as const,
        required: true,
        hint: "LLM-Modell aus LM Studio (wird beim Öffnen von der oben eingetragenen URL geladen)",
        meta: { optionsFromUrlField: "url" },
      },
      {
        key: "fallbackUrl",
        label: "Fallback LM Studio URL (optional)",
        type: "text" as const,
        hint: "Zweite LM-Studio-Instanz (z.B. Mac), die genutzt wird, wenn der Primary nicht erreichbar ist. Leer = kein Fallback.",
      },
      {
        key: "fallbackModel",
        label: "Fallback-Modell (optional)",
        type: "combobox" as const,
        hint: "Modellname auf dem Fallback-Host. Leer = gleicher Name wie Primary-Modell.",
        meta: {
          optionsFromUrlField: "fallbackUrl",
          disabledWhenEmpty: "fallbackUrl",
        },
      },
      {
        key: "probeTimeoutMs",
        label: "Health-Probe Timeout (ms)",
        type: "number" as const,
        default: 2000,
        hint: "Timeout für den kurzen Health-Check vor jedem Heartbeat. Bestimmt, wie schnell der Fallback greift, wenn der Primary-Host aus ist.",
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        type: "number" as const,
        default: 120000,
        hint: "Timeout für Inferenz in Millisekunden",
      },
      {
        key: "streamingEnabled",
        label: "Token-Streaming",
        type: "boolean" as const,
        default: true,
        hint: "Antwort Token für Token in der UI anzeigen",
      },
      {
        key: "maxIterations",
        label: "Max Tool-Iterationen",
        type: "number" as const,
        default: 25,
        hint: "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)",
      },
      {
        key: "maxRunSeconds",
        label: "Max Run-Laufzeit (s)",
        type: "number" as const,
        default: 300,
        hint: "Wallclock-Budget pro Run. Verhindert durchlaufende Tool-Schleifen, die LM Studio stundenlang belasten.",
      },
      {
        key: "allowedWriteRoots",
        label: "Zusätzlich erlaubte Schreib-Pfade",
        type: "text" as const,
        hint: "Kommagetrennte absolute Pfade, in die der Agent zusätzlich zum Arbeitsverzeichnis schreiben darf (z.B. Obsidian-Vault auf externem Volume).",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions File (AGENTS.md)",
        type: "text" as const,
        hint: "Optionaler absoluter Pfad zu einer Markdown-Datei, die als Agent-Persona an den System-Prompt angehängt wird",
      },
    ],
  };
},
```

- [ ] **Step 4: Tests grün bekommen**

```bash
pnpm test -- list-models
```

Erwartet: alle Tests PASS.

- [ ] **Step 5: Build prüfen (tsc)**

```bash
pnpm build
```

Erwartet: Kein TypeScript-Fehler.

- [ ] **Step 6: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio" add src/server/index.ts tests/list-models.test.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio" commit -m "feat(lmstudio): config-schema rein statisch, meta.optionsFromUrlField/disabledWhenEmpty"
```

---

## Task 3: adapter-utils Types — listModels-Signatur + Meta-Keys dokumentieren

**Files:**
- Modify: `packages/adapter-utils/src/types.ts:292-331`

Hinweis: `ConfigFieldSchema.type` enthält bereits `"combobox"` (Zeile 278), und `meta` ist bereits ein offenes `Record<string, unknown>`. Wir ergänzen nur die `listModels`-Signatur und dokumentieren die neuen Meta-Konventionen über JSDoc + einen Utility-Typ.

- [ ] **Step 1: Type-Änderung**

In `packages/adapter-utils/src/types.ts`, Zeile 302 (die `listModels`-Zeile) — komplette Zeile ersetzen:

```ts
  listModels?: (opts?: { url?: string }) => Promise<AdapterModel[]>;
```

Direkt oberhalb von `ConfigFieldSchema` (vor Zeile 275) ein neues Interface einfügen, das die Meta-Konventionen dokumentiert:

```ts
/**
 * Known keys inside `ConfigFieldSchema.meta`. The field is still typed as
 * `Record<string, unknown>` so adapters may add arbitrary keys, but these
 * keys are interpreted by the generic schema renderer in `ui/`.
 */
export interface ConfigFieldMetaKnown {
  /** Existing: provider → models map for `combobox` with provider-scoped options */
  providerModels?: Record<string, string[]>;

  /**
   * Key of another field in the same schema whose value is treated as the base URL
   * when loading combobox options. The renderer calls
   * `GET /api/adapters/:type/models?url=<that-value>` lazily when the dropdown opens.
   * Requires field.type === "combobox".
   */
  optionsFromUrlField?: string;

  /**
   * Key of another field in the same schema. When that field's trimmed value is
   * empty, this field is rendered disabled (input + popover locked).
   */
  disabledWhenEmpty?: string;
}
```

- [ ] **Step 2: Build prüfen (keine neuen Fehler)**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip"
pnpm -C packages/adapter-utils build
```

Erwartet: Kein TypeScript-Fehler.

- [ ] **Step 3: Konsumenten-Typecheck**

```bash
pnpm -C server typecheck 2>&1 | head -40
pnpm -C ui typecheck 2>&1 | head -40
```

Erwartet: Keine neuen Fehler durch die `listModels`-Signatur (der bestehende Aufruf `adapter.listModels()` bleibt kompatibel, da `opts` optional).

- [ ] **Step 4: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add packages/adapter-utils/src/types.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(adapter-utils): listModels akzeptiert { url }, Meta-Keys dokumentiert"
```

---

## Task 4: Server-Registry — listAdapterModels reicht url durch, fängt Fehler

**Files:**
- Modify: `server/src/adapters/registry.ts:320-328`
- Test: `server/src/adapters/__tests__/registry.models.test.ts`

- [ ] **Step 1: Failing test anlegen**

Datei `server/src/adapters/__tests__/registry.models.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry")>();
  return actual;
});

describe("listAdapterModels", () => {
  it("passes opts.url to the adapter's listModels", async () => {
    const { __test_setActiveAdapter, listAdapterModels } = await import("../registry");
    const listSpy = vi.fn(async (_opts?: { url?: string }) => [
      { id: "remote-model", label: "remote-model" },
    ]);
    __test_setActiveAdapter({
      type: "mock",
      execute: vi.fn(),
      testEnvironment: vi.fn(),
      listModels: listSpy,
    } as unknown as Parameters<typeof __test_setActiveAdapter>[0]);

    const result = await listAdapterModels("mock", { url: "http://x:1234" });

    expect(listSpy).toHaveBeenCalledWith({ url: "http://x:1234" });
    expect(result).toEqual([{ id: "remote-model", label: "remote-model" }]);
  });

  it("returns [] when the adapter throws (URL unreachable)", async () => {
    const { __test_setActiveAdapter, listAdapterModels } = await import("../registry");
    __test_setActiveAdapter({
      type: "mock",
      execute: vi.fn(),
      testEnvironment: vi.fn(),
      listModels: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as Parameters<typeof __test_setActiveAdapter>[0]);

    const result = await listAdapterModels("mock", { url: "http://dead:9999" });
    expect(result).toEqual([]);
  });

  it("ignores opts for adapters that do not accept them (backwards compat)", async () => {
    const { __test_setActiveAdapter, listAdapterModels } = await import("../registry");
    const legacyListModels = vi.fn(async () => [
      { id: "legacy", label: "legacy" },
    ]);
    __test_setActiveAdapter({
      type: "mock",
      execute: vi.fn(),
      testEnvironment: vi.fn(),
      listModels: legacyListModels,
    } as unknown as Parameters<typeof __test_setActiveAdapter>[0]);

    const result = await listAdapterModels("mock");
    expect(legacyListModels).toHaveBeenCalledWith(undefined);
    expect(result).toEqual([{ id: "legacy", label: "legacy" }]);
  });
});
```

**Wichtig:** Der Test nutzt `__test_setActiveAdapter`, ein existierendes oder hier neu zu ergänzendes Test-Helper. Bevor du den Test schreibst, prüfe ob ein Helper bereits existiert:

```bash
grep -n "__test_setActiveAdapter\|testing\|__test" server/src/adapters/registry.ts
```

Falls **nicht vorhanden**, füge ihn am Ende von `server/src/adapters/registry.ts` hinzu (nur in Non-Production-Modus registriert):

```ts
// ---------------------------------------------------------------------------
// Test helpers (nicht für Production)
// ---------------------------------------------------------------------------
export function __test_setActiveAdapter(adapter: ServerAdapterModule): void {
  adaptersByType.set(adapter.type, adapter);
}
export function __test_clearAdapters(): void {
  adaptersByType.clear();
}
```

Falls ein bestehendes Muster mit `vi.mock` + Factory bereits im Repo vorhanden ist (z.B. in Nachbar-Tests), passe den Test daran an statt den Helper neu einzuführen. Konsistenz mit bestehendem Code schlägt Neuerung.

- [ ] **Step 2: Tests ausführen und Fehlschlag bestätigen**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip"
pnpm -C server test -- registry.models
```

Erwartet: FAIL — `listAdapterModels` nimmt aktuell kein `opts` entgegen und fängt Fehler nicht ab.

- [ ] **Step 3: Registry anpassen**

`server/src/adapters/registry.ts:320-328` ersetzen:

```ts
export async function listAdapterModels(
  type: string,
  opts?: { url?: string },
): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    try {
      const discovered = await adapter.listModels(opts);
      if (discovered.length > 0) return discovered;
    } catch {
      return [];
    }
  }
  return adapter.models ?? [];
}
```

- [ ] **Step 4: Tests grün bekommen**

```bash
pnpm -C server test -- registry.models
```

Erwartet: alle 3 Tests PASS.

- [ ] **Step 5: Voller Server-Testlauf**

```bash
pnpm -C server test
```

Erwartet: Keine Regressionen.

- [ ] **Step 6: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add server/src/adapters/registry.ts server/src/adapters/__tests__/registry.models.test.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(server): listAdapterModels akzeptiert { url }, liefert [] bei Adapter-Fehler"
```

---

## Task 5: Server-Route — `?url=`-Query-Parameter durchreichen

**Files:**
- Modify: `server/src/routes/agents.ts:780-786`

Diese Änderung ist klein genug, dass ein dedizierter Unit-Test für die Route übertrieben wäre — Task 4 testet die zugrundeliegende Funktion. Wenn das Repo bereits Route-Integrationstests für den Endpoint hat, ergänze einen Case; sonst genügt manuelles Verifizieren mit `curl`.

- [ ] **Step 1: Route anpassen**

In `server/src/routes/agents.ts:780-786` den Block:

```ts
router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  const type = assertKnownAdapterType(req.params.type as string);
  const models = await listAdapterModels(type);
  res.json(models);
});
```

ersetzen durch:

```ts
router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  const type = assertKnownAdapterType(req.params.type as string);
  const rawUrl = typeof req.query.url === "string" ? req.query.url : undefined;
  const url = rawUrl?.trim() || undefined;
  const models = await listAdapterModels(type, { url });
  res.json(models);
});
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -C server typecheck
```

Erwartet: keine Fehler.

- [ ] **Step 3: Manuell verifizieren (Dev-Server)**

```bash
pnpm dev
# In zweitem Terminal:
curl -s "http://localhost:<port>/api/companies/<companyId>/adapters/lmstudio_local/models?url=http://localhost:1234" | jq .
```

Erwartet: Liste von Modellen aus der lokalen LM-Studio-Instanz.

Mit abweichender URL:

```bash
curl -s "http://localhost:<port>/api/companies/<companyId>/adapters/lmstudio_local/models?url=http://dead-host:9999" | jq .
```

Erwartet: `[]` (keine 500er), Response innerhalb weniger Sekunden (Timeout in `fetchModels`).

- [ ] **Step 4: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add server/src/routes/agents.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(server): /adapters/:type/models akzeptiert ?url=-Query"
```

---

## Task 6: UI — API-Client & QueryKey um optionale url erweitern

**Files:**
- Modify: `ui/src/api/agents.ts:166-169`
- Modify: `ui/src/lib/queryKeys.ts:26-27`

- [ ] **Step 1: API-Client anpassen**

`ui/src/api/agents.ts:166-169` ersetzen:

```ts
  adapterModels: (companyId: string, type: string, url?: string) => {
    const qs = url ? `?url=${encodeURIComponent(url)}` : "";
    return api.get<AdapterModel[]>(
      `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models${qs}`,
    );
  },
```

- [ ] **Step 2: QueryKey anpassen**

`ui/src/lib/queryKeys.ts:26-27` ersetzen:

```ts
    adapterModels: (companyId: string, adapterType: string, url?: string) =>
      ["agents", companyId, "adapter-models", adapterType, url ?? ""] as const,
```

Der leere String im Schlüssel ist wichtig: er trennt den Standardfall (kein URL) vom Fall `url=""`, beide normalisiert zum gleichen Key.

- [ ] **Step 3: Konsumenten-Check**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip"
pnpm -C ui typecheck
```

Erwartet: keine neuen Fehler. Die bestehenden Aufrufer in `NewIssueDialog.tsx:410`, `OnboardingWizard.tsx:190`, `AgentConfigForm.tsx:285` bleiben kompatibel, da `url` optional.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add ui/src/api/agents.ts ui/src/lib/queryKeys.ts
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(ui): adapterModels API + QueryKey akzeptieren optionales url"
```

---

## Task 7: UI — ComboboxField um onOpenChange + disabled + loading erweitern

**Files:**
- Modify: `ui/src/adapters/schema-config-fields.tsx:64-200`

Im aktuellen Stand der Komponente gibt es weder einen Open-Callback nach außen noch ein `disabled`/`loading`. Wir erweitern die Komponente minimal, brechen aber keine bestehenden Aufrufer (alle neuen Props sind optional).

- [ ] **Step 1: Signatur + Props erweitern**

In `ui/src/adapters/schema-config-fields.tsx`, die Funktion `ComboboxField` (ab Zeile 64) — `interface`-Teil ersetzen:

```tsx
function ComboboxField({
  value,
  options,
  onChange,
  placeholder,
  onOpenChange,
  disabled,
  loading,
}: {
  value: string;
  options: { label: string; value: string; group?: string }[];
  onChange: (val: string) => void;
  placeholder?: string;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
```

- [ ] **Step 2: Open-State-Setter in Callback wrappen**

Direkt unter `const [open, setOpen] = useState(false);` hinzufügen:

```tsx
  const setOpenExt = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );
```

In der bestehenden Funktion alle Stellen, die `setOpen(true)` bzw. `setOpen(false)` aufrufen, durch `setOpenExt(...)` ersetzen. Konkret:
- `handleKeyDown` bei `ArrowDown`: `setOpenExt(true)` statt `setOpen(true)`.
- Im `onChange`-Handler des Inputs: `setOpenExt(true)` statt `setOpen(true)`.
- Im `onFocus`: `setOpenExt(true)` statt `setOpen(true)`.
- Im `onBlur`-Timeout: `setOpenExt(false)` statt `setOpen(false)`.
- Im `select`-Callback: `setOpenExt(false)` statt `setOpen(false)`.
- Im `handleKeyDown` bei `Escape`: `setOpenExt(false)` statt `setOpen(false)`.
- Am `<Popover open={... && filtered.length > 0} onOpenChange={setOpenExt}>` — ersetze `setOpen` durch `setOpenExt`.

- [ ] **Step 3: disabled-Verhalten implementieren**

Den `<input>`-Tag um `disabled={disabled}` erweitern und die Klasse bei disabled angepasst:

```tsx
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          className={`flex-1 rounded-l-md border border-r-0 border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 focus:z-10 ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          value={displayValue}
          placeholder={placeholder ?? "Type or select..."}
          onChange={(e) => {
            if (disabled) return;
            setFilter(e.target.value);
            if (!open) setOpenExt(true);
          }}
          onFocus={() => {
            if (disabled) return;
            if (!open) setOpenExt(true);
          }}
          onBlur={() => {
            setTimeout(() => setOpenExt(false), 150);
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            handleKeyDown(e);
          }}
        />
```

Den Chevron-Button ebenfalls:

```tsx
            <button
              type="button"
              disabled={disabled}
              className={`rounded-r-md border border-border px-2 py-1.5 hover:bg-accent/50 transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
```

- [ ] **Step 4: loading-Zustand im Popover**

Innerhalb von `<PopoverContent ...>` über dem `Array.from(grouped.entries())`-Loop:

```tsx
          {loading && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              Lade Modelle…
            </div>
          )}
          {!loading && Array.from(grouped.entries()).map(([group, opts]) => (
            /* bestehendes Rendering */
          ))}
          {!loading && filter && filtered.length === 0 && (
            /* bestehender Custom-Value-Hinweis */
          )}
```

Zusätzlich, wenn `loading === false && options.length === 0 && !filter` → kurzen Hinweis anzeigen:

```tsx
          {!loading && options.length === 0 && !filter && (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              Keine Modelle — URL erreichbar? Modellname manuell eintippen.
            </div>
          )}
```

- [ ] **Step 5: Typecheck**

```bash
pnpm -C ui typecheck
```

Erwartet: keine Fehler.

- [ ] **Step 6: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add ui/src/adapters/schema-config-fields.tsx
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(ui/combobox): onOpenChange + disabled + loading props"
```

---

## Task 8: UI — UrlModelsCombobox + neuer combobox-Case mit optionsFromUrlField

**Files:**
- Modify: `ui/src/adapters/schema-config-fields.tsx` (Imports + neue Komponente + Case-Block)
- Test: `ui/src/adapters/__tests__/url-models-combobox.test.tsx`

- [ ] **Step 1: Failing Component-Tests schreiben**

Datei `ui/src/adapters/__tests__/url-models-combobox.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SchemaConfigFields } from "../schema-config-fields";
import { agentsApi } from "../../api/agents";

vi.mock("../../api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn(),
  },
}));

const mockSchema = {
  version: 1,
  fields: [
    { key: "url", label: "LM Studio URL", type: "text", default: "http://localhost:1234" },
    {
      key: "defaultModel",
      label: "Modell",
      type: "combobox",
      meta: { optionsFromUrlField: "url" },
    },
    { key: "fallbackUrl", label: "Fallback URL", type: "text" },
    {
      key: "fallbackModel",
      label: "Fallback-Modell",
      type: "combobox",
      meta: { optionsFromUrlField: "fallbackUrl", disabledWhenEmpty: "fallbackUrl" },
    },
  ],
};

// Mock the config-schema fetch
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(mockSchema), { status: 200 }),
  ) as unknown as typeof fetch;
});

function renderWith(props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const values = {
    adapterSchemaValues: {
      url: "http://primary:1234",
      fallbackUrl: "",
    },
  };
  const set = vi.fn();
  return render(
    <QueryClientProvider client={client}>
      <SchemaConfigFields
        adapterType="lmstudio_local"
        isCreate
        values={values}
        set={set}
        config={{}}
        eff={(_k, _fk, def) => def}
        mark={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("SchemaConfigFields with optionsFromUrlField", () => {
  it("does not fetch models until user opens the dropdown", async () => {
    (agentsApi.adapterModels as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderWith();
    // Warten bis Schema geladen und gerendert ist
    await screen.findByLabelText(/Modell/i);
    expect(agentsApi.adapterModels).not.toHaveBeenCalled();
  });

  it("fetches with current url value when the combobox opens", async () => {
    (agentsApi.adapterModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "qwen", label: "qwen" },
    ]);
    renderWith();

    const modelInput = (await screen.findByLabelText(/^Modell$/i)) as HTMLInputElement;
    fireEvent.focus(modelInput);

    await waitFor(() =>
      expect(agentsApi.adapterModels).toHaveBeenCalledWith(
        expect.any(String),
        "lmstudio_local",
        "http://primary:1234",
      ),
    );
  });

  it("disables fallbackModel when fallbackUrl is empty", async () => {
    (agentsApi.adapterModels as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    renderWith();
    const fallbackInput = (await screen.findByLabelText(/Fallback-Modell/i)) as HTMLInputElement;
    expect(fallbackInput.disabled).toBe(true);
  });
});
```

Note: Falls in `SchemaConfigFields` das `companyId`-Prop-Handling derzeit abweicht (z.B. aus einem Context statt als Prop), passe den Test entsprechend an den bestehenden Pfad an. Der wesentliche Prüfpunkt bleibt: `adapterModels` wird mit dem Wert des URL-Feldes aufgerufen, nicht einem hardcoded Default.

- [ ] **Step 2: Tests ausführen und Fehlschlag bestätigen**

```bash
pnpm -C ui test -- url-models-combobox
```

Erwartet: FAIL — Komponenten nutzen den neuen Mechanismus noch nicht.

- [ ] **Step 3: Imports in schema-config-fields.tsx erweitern**

Am Dateianfang ergänzen:

```tsx
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
```

Falls `adapterType` die Company-ID aus einem Context bezieht: prüfe den bestehenden Pfad und ziehe ihn gleichartig nach (z.B. `useSelectedCompanyId()`). Der Test-Code verwendet den gleichen Pfad.

- [ ] **Step 4: UrlModelsCombobox-Hilfskomponente einfügen**

Direkt vor dem `SchemaConfigFields`-Export:

```tsx
function UrlModelsCombobox({
  adapterType,
  companyId,
  url,
  value,
  disabled,
  onChange,
  placeholder,
}: {
  adapterType: string;
  companyId: string | null | undefined;
  url: string;
  value: string;
  disabled: boolean;
  onChange: (val: string) => void;
  placeholder?: string;
}) {
  const [hasOpened, setHasOpened] = useState(false);

  const enabled = hasOpened && !disabled && Boolean(companyId) && url.length > 0;

  const { data, isFetching } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "", adapterType, url),
    queryFn: () => agentsApi.adapterModels(companyId!, adapterType, url),
    enabled,
    staleTime: 30_000,
  });

  const options = (data ?? []).map((m) => ({ label: m.label, value: m.id }));

  return (
    <ComboboxField
      value={value}
      options={options}
      disabled={disabled}
      loading={isFetching}
      onChange={onChange}
      placeholder={placeholder}
      onOpenChange={(open) => {
        if (open) setHasOpened(true);
      }}
    />
  );
}
```

- [ ] **Step 5: combobox-Case um URL-Fall erweitern**

Im bestehenden Switch (`case "combobox":`) — **vor** der bestehenden `providerModels`-Logik — einfügen:

```tsx
          case "combobox": {
            const currentVal = String(readValue(field) ?? "");

            // Fall A: URL-abhängige Optionen
            if (field.meta?.optionsFromUrlField) {
              const urlFieldKey = field.meta.optionsFromUrlField as string;
              const urlFieldSchema = schema.fields.find((f) => f.key === urlFieldKey);
              const urlValue = String(
                urlFieldSchema ? readValue(urlFieldSchema) ?? "" : "",
              ).trim();

              const disabledField = field.meta.disabledWhenEmpty as string | undefined;
              const isDisabled = disabledField
                ? !String(
                    readValue(schema.fields.find((f) => f.key === disabledField)!) ?? "",
                  ).trim()
                : false;

              return (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <UrlModelsCombobox
                    adapterType={adapterType}
                    companyId={selectedCompanyId}
                    url={urlValue}
                    value={currentVal}
                    disabled={isDisabled}
                    onChange={(v) => writeValue(field, v || undefined)}
                    placeholder={field.hint}
                  />
                </Field>
              );
            }

            // Fall B: providerModels (bestehende Logik, unverändert)
            // ... existing block bleibt unverändert ...
          }
```

**Wichtig:** Die bestehende providerModels-Logik bleibt identisch erhalten, wird nur in einen `else`-Zweig verschoben. Schau dir [ui/src/adapters/schema-config-fields.tsx:421-461](../../../ui/src/adapters/schema-config-fields.tsx#L421-L461) genau an und lasse die Zeilen 425-460 (Options-Berechnung + Field/Combobox-Rendering) intakt.

`selectedCompanyId` existiert bereits im Scope (aus Props oder Hook). Falls nicht, benutze den vorhandenen Pfad aus dem Top der Komponente — das ist derselbe, den die bestehende `schemaCache` und `fetchConfigSchema`-Logik implizit annimmt.

- [ ] **Step 6: Tests grün bekommen**

```bash
pnpm -C ui test -- url-models-combobox
```

Erwartet: alle 3 Tests PASS.

- [ ] **Step 7: Voller UI-Testlauf**

```bash
pnpm -C ui test
```

Erwartet: Keine Regressionen.

- [ ] **Step 8: Typecheck**

```bash
pnpm -C ui typecheck
```

Erwartet: keine Fehler.

- [ ] **Step 9: Commit**

```bash
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" add ui/src/adapters/schema-config-fields.tsx ui/src/adapters/__tests__/url-models-combobox.test.tsx
git -C "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip" commit -m "feat(ui): UrlModelsCombobox — lazy Modelle pro URL, disabled bei leerem Referenzfeld"
```

---

## Task 9: Manueller Smoke-Test im Dev-Server

Nach globaler Regel (UI-Changes) verpflichtend: die Funktion einmal im Browser durchklicken, Regressionen gegenchecken.

- [ ] **Step 1: Adapter-Package lokal neu bauen und im Paperclip-Workspace verlinken**

Wenn der LM-Studio-Adapter als externes Package eingebunden ist, muss er neu gebaut werden, damit die Änderungen aus Task 1+2 greifen:

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/opensource/paperclip-adapter-lmstudio"
pnpm build
```

Dann im Paperclip-Repo ggf. `pnpm install` / Link-Refresh, je nach lokalem Setup.

- [ ] **Step 2: Dev-Server starten**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip"
pnpm dev
```

- [ ] **Step 3: Smoke-Test durchklicken**

1. Agent-Config öffnen → Adapter `lmstudio_local` wählen.
2. Primary-URL = `http://localhost:1234` → "Modell"-Dropdown öffnen → lokale Modelle erscheinen.
3. Primary-URL ändern zu `http://<externer-host>:1234` → Dropdown schließen → erneut öffnen → Modelle der externen Maschine erscheinen.
4. Fallback-URL leer lassen → Fallback-Modell-Feld sichtbar ausgegraut, Klick öffnet nichts, Tippen gesperrt.
5. Fallback-URL auf eine echte URL setzen → Feld wird aktiv → Dropdown öffnen → Modelle der Fallback-Maschine.
6. Primary-URL tippfehlerhaft (z.B. `http://nope:1234`) → Dropdown öffnet → zeigt „Keine Modelle — URL erreichbar? Modellname manuell eintippen." → Modellname manuell tippen → Enter commited den Wert.
7. Agent speichern → gespeicherte Config enthält Modellnamen korrekt.
8. Regression: bei anderen Adaptern (z.B. `claude-local`) ist das Modell-Dropdown weiterhin gefüllt und unverändert funktional.

- [ ] **Step 4: Ergebnis dokumentieren**

Kurzes Ergebnis-Log im Ticket / Commit-Body (nicht als neue Datei) hinterlegen. Bei gefundenen Regressions: zurück zum verursachenden Task.

- [ ] **Step 5: Keinen Commit nötig** (nur Verifikation, kein Code-Change).

---

## Notes for the implementer

- **Reihenfolge der Tasks** ist bindend: Task 1 → 2 ändert den externen Adapter, Task 3 die Shared-Types. Ohne Task 3 wird das Paperclip-Repo typecheck-brechen, sobald Task 1+2 eincheckt sind (wenn der Adapter als Workspace-Dep eingebunden ist) — also Task 3 direkt im Anschluss ausführen.
- **Fallback-Adapter-Integration**: Der LM-Studio-Adapter ist ein **externes Package**. Abhängig vom lokalen Dev-Setup musst du nach Task 2 `pnpm build` im Adapter-Repo laufen lassen und ggf. im Paperclip-Workspace neu installieren, damit die Schema-Änderungen auch wirklich greifen (Task 9 erinnert daran).
- **Keine Migration** gespeicherter Adapter-Configs nötig. Ein bestehender `defaultModel: "qwen-2.5-7b"` funktioniert in der neuen Combobox direkt.
- **SSRF-Risiko** (URL-Param lässt Server beliebige Hosts anfragen) ist im Spec-Doc dokumentiert und akzeptiert, da der Endpoint nur für authentifizierte Company-Admins offen ist. Falls das später gelockert wird → Host-Allowlist nachrüsten.
