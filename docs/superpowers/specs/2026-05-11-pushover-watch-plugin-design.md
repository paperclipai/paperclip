---
title: Paperclip → Apple Watch Notifications via Pushover-Plugin
status: draft
date: 2026-05-11
scope: WHITESTAG + Health Insights Companies
---

## Ziel

Walter erhält Push-Notifications auf seiner Apple Watch Ultra 3, wenn in Paperclip zwei Klassen von Ereignissen auftreten:

1. **CEO/CHO-Task fertig:** ein der CEO-Rolle zugewiesener Task (in WHITESTAG: "CEO"; in Health Insights: "CHO") geht in den Status `done` über.
2. **Walter muss antworten:** ein offener Wartezustand auf Walters Input — vier Spielarten zusammengefasst:
   - Task in `in_review` und Walter zugewiesen
   - Task `blocked` mit @-Mention an Walter im aktuellsten Kommentar
   - @-Mention an Walter in einem neuen Kommentar
   - Pending Board-Approval

Out of Scope: andere Companies (Clara Sound), andere Event-Typen, Notifications für die Web-/Mobile-Paperclip-UI, Konfigurations-UI (Config erfolgt zunächst per Paperclip-Plugin-Settings-API als Plain-JSON).

## Voraussetzungen

- Paperclip-Dev-Server läuft lokal auf `http://127.0.0.1:3100` (launchd-Service `ing.paperclip.dev`).
- Pushover-Account mit:
  - User Key (persönlich)
  - Application API Token (für eine in der Pushover-Console angelegte App "Paperclip Watch")
- Pushover-App auf iPhone und Apple Watch installiert und mit demselben Account angemeldet.
- Plugin-System des Paperclip-Servers wie in `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` dokumentiert (Alpha-Surface).
- Plugin-Worker und Plugin-UI gelten als **trusted code** (vom Server gehosteter Node-Prozess bzw. Same-Origin-JS). Capability-Gating greift nur worker-seitig.

## Konstanten

| Schlüssel | Wert |
|---|---|
| Walters User-ID | `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9` |
| Mention-Format in Kommentaren | `[@DisplayName](user://<userId>)` |
| WHITESTAG Company-ID | `9cebf3cf-efe8-4597-a400-f06488900a87` |
| WHITESTAG Issue-Prefix | `WHI` |
| WHITESTAG CEO-Agent-ID | `506c873e-3a40-4483-9a45-0eb0fa1554bb` |
| Health Company-ID | `158c4959-4973-4cb0-8066-55ec0f35625e` |
| Health Issue-Prefix | `HEA` |
| Health CHO-Agent-ID | `6ddf2bfa-fe1c-4e26-a316-091b6ef3c182` |
| Paperclip Web-Base (Click-Back) | `https://company.whitestag.ai` |
| Pushover API-Endpoint | `https://api.pushover.net/1/messages.json` |
| Plugin-ID | `whitestag.pushover-watch` |
| Plugin-Paket-Name | `@paperclipai/plugin-pushover-watch` |

## Wichtige Eigenheiten des aktuellen Plugin-Runtimes

Aus `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` und SDK-Inspektion:

- **Plugin-Aktivierung ist instance-wide**, nicht per-company. Events tragen `companyId`, aber Config liegt unter `instanceConfigSchema` und damit instance-global. Folge: per-Company-Verhalten wird über ein `companies[]`-Array innerhalb einer einzigen Instance-Config abgebildet (siehe Schema unten).
- `ctx.assets` ist **nicht** Teil des aktuellen Runtimes.
- Plugin-Workflows nutzen `pnpm @paperclipai/create-paperclip-plugin` als Scaffold (kein Hand-Schreiben des Bundlers).
- Capability-Namen sind eindeutig — siehe Capability-Liste unten.

## Plugin-Layout (nach Scaffold)

```
packages/plugins/pushover-watch/
├── package.json                # @paperclipai/plugin-pushover-watch
├── src/
│   ├── index.ts                # exports manifest
│   ├── manifest.ts             # PaperclipPluginManifestV1
│   ├── worker.ts               # definePlugin({ setup(ctx) {...} }); runWorker(plugin, import.meta.url)
│   ├── config-schema.ts        # JSON-Schema → instanceConfigSchema im Manifest
│   ├── transitions.ts          # Status-Übergangs-Detektor (pure Funktionen)
│   ├── mentions.ts             # Mention-Parser (pure Funktionen)
│   ├── pushover-client.ts      # Wrapper um ctx.http.fetch → api.pushover.net
│   └── triggers.ts             # Mapping Event → Pushover-Payload
├── tests/
│   ├── transitions.test.ts
│   ├── mentions.test.ts
│   └── worker.spec.ts          # mit @paperclipai/plugin-sdk/testing → createTestHarness
├── esbuild.config.mjs
└── rollup.config.mjs
```

**Scaffold-Aufruf:**

```bash
pnpm --filter @paperclipai/create-paperclip-plugin build
node packages/plugins/create-paperclip-plugin/dist/index.js \
  @paperclipai/plugin-pushover-watch \
  --output ./packages/plugins
```

## Manifest

```ts
// manifest.ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "whitestag.pushover-watch",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Pushover Watch Notifications",
  description:
    "Sends Apple Watch notifications via Pushover for CEO-done tasks and board-wait states. Multi-company-aware via instance config.",
  author: "WHITESTAG",
  categories: ["notifications"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issue.comments.read",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      pushoverUserKeyRef: {
        type: "string",
        title: "Pushover User Key (secret reference)",
        description: "UUID einer Secret-Entry in company_secrets, die den Pushover User Key hält.",
      },
      pushoverAppTokenRef: {
        type: "string",
        title: "Pushover App Token (secret reference)",
        description: "UUID einer Secret-Entry, die den Pushover Application API Token hält.",
      },
      boardUserId: {
        type: "string",
        title: "Board User ID",
        description: "User-ID des Empfängers der Notifications.",
        default: "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9",
      },
      clickbackBaseUrl: {
        type: "string",
        format: "uri",
        title: "Paperclip Web Base URL",
        default: "https://company.whitestag.ai",
      },
      dryRun: {
        type: "boolean",
        title: "Dry-Run: log payload statt senden",
        default: false,
      },
      companies: {
        type: "array",
        title: "Per-Company-Konfiguration",
        items: {
          type: "object",
          properties: {
            companyId: { type: "string", format: "uuid" },
            issuePrefix: { type: "string", description: "z.B. WHI oder HEA" },
            topAgentIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
              description: "Agent-IDs deren done-Tasks getriggert werden (CEO/CHO).",
            },
            enabled: { type: "boolean", default: true },
          },
          required: ["companyId", "issuePrefix", "topAgentIds"],
        },
        default: [
          {
            companyId: "9cebf3cf-efe8-4597-a400-f06488900a87",
            issuePrefix: "WHI",
            topAgentIds: ["506c873e-3a40-4483-9a45-0eb0fa1554bb"],
            enabled: true,
          },
          {
            companyId: "158c4959-4973-4cb0-8066-55ec0f35625e",
            issuePrefix: "HEA",
            topAgentIds: ["6ddf2bfa-fe1c-4e26-a316-091b6ef3c182"],
            enabled: true,
          },
        ],
      },
    },
    required: ["pushoverUserKeyRef", "pushoverAppTokenRef", "boardUserId", "companies"],
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
```

Hinweise:

- `pushoverUserKeyRef` / `pushoverAppTokenRef` enthalten UUIDs, nicht die Klartext-Credentials. Diese werden zur Laufzeit per `ctx.secrets.resolve(...)` aufgelöst (Capability `secrets.read-ref`).
- Eine eigene Settings-UI (`settingsPage`-Slot) ist **out of scope für v0.1.0**. Die initiale Config wird per Plugin-Settings-API gepostet oder direkt in der DB hinterlegt.
- Kein UI-Bundle → `entrypoints.ui` weggelassen.

## Worker-Hauptfluss

```ts
// worker.ts (skizziert)
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { bootstrapCompany } from "./bootstrap.js";
import { handleIssueUpdated } from "./triggers.js";
import { handleCommentCreated } from "./triggers.js";
import { handleApprovalCreated } from "./triggers.js";

const plugin = definePlugin({
  async setup(ctx) {
    const config = await ctx.config.get();
    if (!config?.companies?.length) {
      ctx.logger.warn("pushover_watch_no_companies_configured");
      return;
    }

    const enabledCompanyIds = new Set(
      config.companies.filter((c) => c.enabled !== false).map((c) => c.companyId),
    );

    // One-shot per-company bootstrap: seed issue state cache so first real updates
    // can detect transitions without firing false positives on existing data.
    for (const companyConfig of config.companies) {
      if (companyConfig.enabled === false) continue;
      await bootstrapCompany(ctx, companyConfig);
    }

    ctx.events.on("issue.updated", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleIssueUpdated(ctx, config, event);
    });

    ctx.events.on("issue.comment.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleCommentCreated(ctx, config, event);
    });

    ctx.events.on("approval.created", async (event) => {
      if (!enabledCompanyIds.has(event.companyId)) return;
      await handleApprovalCreated(ctx, config, event);
    });
  },

  async onConfigChanged(_newConfig) {
    // Force a restart on config change so company filter set is rebuilt cleanly.
    // (Returning undefined / not implementing this hook causes a restart by default.)
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

## Trigger-Matrix

| # | Event | Bedingung | Pushover-Priority | Title-Template |
|---|---|---|---|---|
| T1 | `issue.updated` | `prev.status≠done ∧ new.status=done ∧ new.assigneeAgentId ∈ companyCfg.topAgentIds` | `0` | `[<PREFIX>] CEO erledigt: <issue.title>` |
| T2 | `issue.updated` | `prev.status≠in_review ∧ new.status=in_review ∧ new.assigneeUserId=boardUserId` | `0` | `[<PREFIX>] Review-Handover: <issue.title>` |
| T3 | `issue.updated` | `prev.status≠blocked ∧ new.status=blocked ∧ jüngster Kommentar enthält user://<boardUserId>` | `1` | `[<PREFIX>] Blockiert, braucht dich: <issue.title>` |
| T4 | `issue.comment.created` | Body matcht `user://18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9` UND Author ≠ Walter | `0` | `[<PREFIX>] @-Mention von <author>: <issue.title>` |
| T5 | `approval.created` | `payload.type=request_board_approval ∧ payload.status=pending` | `1` | `[<PREFIX>] Approval wartet: <payload.title>` |
| T6 | `issue.updated` | `prev.status≠new.status ∧ new.status ∈ {done, in_review, blocked} ∧ (prev.assigneeAgentId ∈ companyCfg.secretaryAgentIds ∨ new.assigneeAgentId ∈ companyCfg.secretaryAgentIds)` | `0` (done/in_review) / `1` (blocked) | `[<PREFIX>] Sekretärin erledigt / Sekretärin: Review / Sekretärin: Blockiert: <issue.title>` |

T6 läuft vor T1/T2/T3 und preemptet überlappende Matches (z.B. Sekretärin → `in_review` mit Walter als assignee würde sonst T2 feuern — stattdessen Sekretärin-Label). Bei leerem `secretaryAgentIds` (z.B. HEA) ist T6 inaktiv.

**Click-Back-URL** für T1–T4 und T6: `<clickbackBaseUrl>/<PREFIX>/issues/<issue.identifier>`
**Click-Back-URL** für T5: `<clickbackBaseUrl>/<PREFIX>/approvals/<approval.id>`

## State-Management (Ansatz B)

### Storage-Layout

Mit der SDK-`PluginStateClient`-API:

```ts
type CachedIssueState = {
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: string;
};

// Schreiben
await ctx.state.set(
  { scopeKind: "issue", scopeId: issueId, stateKey: "pushover-watch:last-seen" },
  cachedState,
);

// Lesen
const prev = await ctx.state.get<CachedIssueState>(
  { scopeKind: "issue", scopeId: issueId, stateKey: "pushover-watch:last-seen" },
);
```

### Bootstrap-Marker

```ts
// Pro Company markieren, dass Bootstrap gelaufen ist:
await ctx.state.set(
  { scopeKind: "company", scopeId: companyId, stateKey: "pushover-watch:bootstrap-done" },
  { at: new Date().toISOString() },
);
```

### Bootstrap-Routine (`bootstrapCompany`)

1. Prüfe `bootstrap-done`-Marker; wenn gesetzt, return.
2. Lade alle offenen Issues der Company via `ctx.issues.list({ companyId, status: ["todo","in_progress","in_review","blocked"] })` (SDK exposed via worker context).
3. Für jedes Issue: `ctx.state.set(...issue:...lastSeen)` mit aktueller Status-Triple.
4. Setze `bootstrap-done`-Marker.
5. **Während Bootstrap werden keine Notifications gesendet.**

### Transition-Detection

```ts
async function handleIssueUpdated(ctx, config, event) {
  const issueId = event.entityId;
  const prev = await ctx.state.get<CachedIssueState>({
    scopeKind: "issue", scopeId: issueId, stateKey: "pushover-watch:last-seen",
  });

  const next: CachedIssueState = {
    status: event.payload.status,
    assigneeAgentId: event.payload.assigneeAgentId ?? null,
    assigneeUserId: event.payload.assigneeUserId ?? null,
    updatedAt: event.occurredAt,
  };

  // Cache updaten BEVOR Trigger entscheidet, damit Folge-Events korrekt sind
  await ctx.state.set(
    { scopeKind: "issue", scopeId: issueId, stateKey: "pushover-watch:last-seen" },
    next,
  );

  if (!prev) return;  // unbekanntes Issue → nur seeden, kein Notify

  const companyCfg = config.companies.find((c) => c.companyId === event.companyId);
  if (!companyCfg) return;

  if (matchesT1(prev, next, companyCfg.topAgentIds)) {
    await dispatchT1(ctx, config, companyCfg, event, next);
  } else if (matchesT2(prev, next, config.boardUserId)) {
    await dispatchT2(ctx, config, companyCfg, event, next);
  } else if (matchesT3(prev, next, config.boardUserId)) {
    await dispatchT3(ctx, config, companyCfg, event, next);
  }
}
```

**Dedup-Garantie:** Strikte Status-Übergänge (`prev.status ≠ next.status` ist Teil jeder Bedingung) verhindern Mehrfachfeuer durch wiederholte `issue.updated`-Events ohne Status-Wechsel.

## Mention-Parser

```ts
// mentions.ts
const MENTION_PATTERN = /\[@[^\]]+\]\(user:\/\/([a-zA-Z0-9_-]+)\)/g;

export function findMentionedUsers(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_PATTERN)) ids.add(m[1]);
  return ids;
}

export function commentMentionsUser(body: string, userId: string): boolean {
  return findMentionedUsers(body).has(userId);
}
```

- T3: setzt `commentMentionsUser` auf den **jüngsten** Kommentar an. Der `issue.updated`-Event-Payload enthält keinen Kommentar-Body, daher ein Lookup via `ctx.issues.getLatestComment(issueId)` oder Fallback `ctx.http`-Call gegen `/api/issues/<id>/comments?order=desc&limit=1` (Capability `issue.comments.read`).
- T4: nutzt `commentMentionsUser` direkt auf `event.payload.body`.

## Pushover-Client

```ts
// pushover-client.ts
import type { PluginContext } from "@paperclipai/plugin-sdk";

export async function sendPushover(
  ctx: PluginContext,
  params: {
    userKey: string;
    appToken: string;
    title: string;
    message: string;
    url: string;
    urlTitle: string;
    priority: 0 | 1;
  },
): Promise<{ ok: boolean; status?: number }> {
  const body = new URLSearchParams({
    token: params.appToken,
    user: params.userKey,
    title: params.title,
    message: params.message,
    url: params.url,
    url_title: params.urlTitle,
    priority: String(params.priority),
  });

  const res = await ctx.http.fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    ctx.logger.warn("pushover_send_failed", { status: res.status });
    return { ok: false, status: res.status };
  }
  return { ok: true, status: res.status };
}
```

Im Trigger-Handler werden Credentials einmal pro Dispatch aufgelöst:

```ts
const [userKey, appToken] = await Promise.all([
  ctx.secrets.resolve(config.pushoverUserKeyRef),
  ctx.secrets.resolve(config.pushoverAppTokenRef),
]);
```

**Fehlerverhalten:**

- HTTP 4xx (außer 429): einmal loggen, nicht retryen.
- HTTP 429 oder 5xx: ein Retry nach 5 s. Bei weiterem Fehlschlag: loggen und verwerfen.
- Pushover Rate-Limit (10.000 Messages/Monat per App) wird bei Walters Volumen nicht erreicht.

## Sicherheit

- **Secrets:** beide Pushover-Credentials werden ausschließlich als `company_secrets`-Einträge gespeichert. Die Config hält nur deren UUID-Referenz. `ctx.secrets.resolve()` entschlüsselt zur Laufzeit. Capability `secrets.read-ref` ist im Manifest deklariert.
- **SSRF:** `api.pushover.net` ist eine öffentliche Domain; der `http.outbound`-Host-SSRF-Schutz greift nur gegen Private-IP-Ranges — kein Konflikt.
- **PII:** Issue-Titel und erste 200 Zeichen des Kommentars werden über Pushover gesendet. Pushover behält Nachrichten max. 30 Tage. Für Walters privates Dev-Setup akzeptabel; für Produktiv-PII-Szenarien ggf. später ntfy.sh self-hosted erwägen.
- **Trusted-Code-Modell:** Der Plugin-Worker läuft als Node-Prozess auf demselben Host wie Paperclip. Capabilities sind aktuell die einzige Sandbox.

## Tests

| Datei | Inhalt |
|---|---|
| `tests/transitions.test.ts` | Unit-Tests für alle 5 Trigger-Bedingungen, inkl. Negativ-Cases (kein prev-State, gleicher Status, falscher Assignee). |
| `tests/mentions.test.ts` | Mention-Parser: leerer Body, mehrfach-Mentions, falsche Schemata, Unicode-Anzeigename. |
| `tests/worker.spec.ts` | `createTestHarness({ manifest })` → `plugin.definition.setup(harness.ctx)` → `harness.emit("issue.updated", {...})` → assert Pushover-fetch-Mock erhielt erwarteten Payload. |

**Dry-Run-Modus:** Über `instanceConfig.dryRun = true`. Wenn aktiv, ersetzt `pushover-client.ts` den `ctx.http.fetch`-Call durch einen `ctx.logger.info`-Eintrag mit dem konstruierten Payload. Für initialen Live-Test.

## Rollout-Schritte (manuell, ausserhalb Plugin-Code)

1. Pushover Application "Paperclip Watch" anlegen → User Key + App API Token notieren.
2. Beide Secrets in Paperclip anlegen (über Paperclip-UI oder Insert in `company_secrets`-Tabelle).
3. Plugin lokal scaffolden, bauen:

   ```bash
   cd packages/plugins/pushover-watch
   pnpm install
   pnpm typecheck && pnpm test && pnpm build
   ```

4. Plugin in Paperclip per Local-Path installieren:

   ```bash
   curl -X POST http://127.0.0.1:3100/api/plugins/install \
     -H "Content-Type: application/json" \
     -d '{"packageName":"/absolute/path/to/packages/plugins/pushover-watch","isLocalPath":true}'
   ```

5. Instance-Config setzen (Secret-UUIDs + `companies`-Array prüfen).
6. Plugin enablen — Bootstrap-Phase läuft (keine Notifications).
7. Live-Test mit `dryRun: true`: Walter setzt ein Test-Issue in WHITESTAG mit CEO-Assignee auf `done` → erwartet Log-Eintrag mit konstruiertem Payload.
8. `dryRun: false` setzen — erstes Echt-Notification.

## Bekannte offene Punkte (zur Coding-Zeit zu klären)

1. **`approval.created`-Payload-Schema** — Bestätigen, dass `payload.type`, `payload.status`, `payload.title` direkt im Event sind. Falls nicht: zusätzlicher `ctx.http`-Call gegen `/api/approvals/<id>`.
2. **`ctx.issues.list` / `ctx.issues.getLatestComment` Verfügbarkeit** — laut SDK-Doc unter "issues and comments" vorhanden; exakte Methodensignaturen beim Coding gegen `@paperclipai/plugin-sdk/types` prüfen. Fallback: `ctx.http.fetch` gegen lokale Paperclip-API.
3. **Multi-Worker-Race-Conditions** — Plugin-Worker laufen aktuell single-instance; bei späterer Skalierung Locking ergänzen.
4. **User-Display-Name für T4** — Mention-Notification soll den Author des Kommentars anzeigen; `event.payload.authorAgentName` / `authorUserName` werden geprüft, Fallback `"jemand"`.
5. **State-Cleanup für abgeschlossene Issues** — `pushover-watch:last-seen` wächst monoton. Optional: periodischer Job (`jobs.schedule`-Capability) der Einträge zu `status=done|cancelled` älter als 30 Tage löscht. Out of scope für v0.1.0.
