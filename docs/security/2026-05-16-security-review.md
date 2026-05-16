# Security-Review Paperclip — 2026-05-16

**Branch unter Review:** `feat/pushover-watch-plugin` (Stand: commit `1bbd39da`)
**Vergleich gegen:** `master`
**Kategorien (von Walter gefordert):** Auth & Credentials · Injection & Input-Validation · Datenfluss & PII · Supply Chain & Dependencies

## Scope und Vorgehensweise

Der Audit hat sich auf die in diesem Branch **neu hinzugekommene Angriffsfläche** konzentriert, weil dort der Großteil der neuen Code-Pfade liegt:

- `packages/brain/` — neuer MCP-Server mit ACL, Auth, Audit, Drizzle-DB
- `packages/plugins/brain/` — Plugin-Wrapper um den Brain-MCP
- `packages/plugins/pushover-watch/` — Pushover-Credential-Handling, Mention-Parser, Trigger-Logik
- `scripts/document-opener/` — lokaler HTTP-Helper (Mac/Windows) zum Öffnen von Dateien
- `server/src/app.ts`, `server/src/dev-watch-ignore.ts` — Routing-/Cache-Anpassungen
- `ui/src/components/LocalDocumentLink.*`, `MarkdownBody.*`, `ui/src/context/DocumentOpenerContext.*`, `ui/src/lib/local-document.*`
- `obsidian-tagger/tagger.py`
- `packages/brain/launchd/`, `packages/brain/scripts/seed-acl.ts`

**Methodik:** Identifikations-Sub-Agent über den vollständigen Branch-Diff (≈1,7 MB) und die tatsächlichen Source-Files, anschließend pro Verdacht ein paralleler Filter-Sub-Agent, der nur Findings mit Confidence ≥ 8 durchlässt. Es wurden bewusst keine Hardening-Themen, kein DoS, keine Audit-Log-Lücken und kein "best practice"-Rauschen aufgenommen.

**Wichtige Einschränkung:** Der Audit liegt auf neuen Branch-Code-Pfaden. Bestehender Master-Code (Mail-Hub, Mistral-Adapter, Sekretärin-Routing, ältere Endpoints) ist **nicht** Teil dieser Analyse. Empfehlung: nach Fix von Finding #1 einen zweiten Pass auf Master-Code in derselben Methodik fahren.

## Zusammenfassung

| # | Severity | Datei | Kategorie | Status |
|---|---|---|---|---|
| 1 | **HIGH** | `packages/brain/src/mcp-server/dispatcher.ts` | Auth & Authz (Privilege Escalation) | **gefixt am 2026-05-16** |

Zwei weitere Verdachtspunkte wurden geprüft und als **kein eigenständiger Vulnerability** klassifiziert — sie sind weiter unten unter "Geprüft und entkräftet" dokumentiert.

---

## Finding 1 — Brain MCP: agentId-Impersonation durch Body-Override (HIGH)

**Datei:** [packages/brain/src/mcp-server/index.ts:68](../../packages/brain/src/mcp-server/index.ts#L68), [:85](../../packages/brain/src/mcp-server/index.ts#L85), [:102](../../packages/brain/src/mcp-server/index.ts#L102)
**Beteiligt:** [packages/brain/src/mcp-server/auth.ts:14-17](../../packages/brain/src/mcp-server/auth.ts#L14-L17), [packages/brain/src/mcp-server/acl.ts:9-12](../../packages/brain/src/mcp-server/acl.ts#L9-L12)
**Severity:** **HIGH**
**Kategorie:** Authentication & Authorization → Privilege Escalation / Authorization Bypass
**Confidence:** 10/10

### Beschreibung

Nach erfolgreicher Bearer-Token-Authentifizierung leitet `auth.ts` einen festen `defaultAgentId` aus dem verwendeten Token ab (`PAPERCLIP` → `"paperclip"`, walter-Token → `"walter"`, n8n-Token → `"n8n"`). Der Dispatcher in `index.ts` macht aus diesem token-gebundenen Wert allerdings nur einen *Fallback*:

```ts
const agentId = a.agentId ?? defaultAgentId;
```

Dieses Muster wird in **allen drei Tool-Branches** (`search_vault`, `get_note`, `list_scope`) angewendet. Die Zod-Schemata (`SearchArgsSchema`, `GetNoteArgsSchema`, `ListScopeArgsSchema`) deklarieren `agentId: z.string().optional()` ohne Refinement, ohne `.strict()`, ohne Gleichheits-Check gegen den Bearer-Principal. Der aus dem Request-Body gelieferte `agentId` fließt direkt in `getAgentScope()` / `getAclForAgent()` und somit in die DB-Queries.

`seed-acl.ts` zeigt unterschiedlich breite Scopes pro Agent (CEO sieht `AI/` + `Dokumente/`; walter zusätzlich `Marketing/`, `Pressemitteilungen/`, `Biographie/` u.a.). Damit ist Cross-Agent-Privilege-Escalation kein theoretisches Konstrukt, sondern liefert konkret zusätzlichen Lese-Zugriff.

### Exploit-Szenario

Ein Subsystem hält ausschließlich den `BRAIN_N8N_TOKEN` (legitime n8n-Workflows). Ein kompromittierter Workflow oder ein lateral-bewegter Angreifer mit Zugriff auf diesen Token schickt:

```http
POST / HTTP/1.1
Host: <brain-host>:7777
Authorization: Bearer <BRAIN_N8N_TOKEN>
Content-Type: application/json

{"tool":"get_note","args":{"agentId":"walter","path":"Marketing/Pressemitteilungen/<sensitive>.md"}}
```

Die ACL-Prüfung läuft auf Scope von `"walter"` — n8n erhält den vollständigen Inhalt. Der `brain.access_log`-Eintrag (`audit.agentId`) protokolliert "walter", nicht "n8n" — die Forensik verliert die echte Bearer-Identität. Damit ist gleichzeitig die in [packages/brain/README.md](../../packages/brain/README.md) versprochene DSGVO-Auskunftsverwertbarkeit des Audit-Logs gebrochen (siehe Anmerkung unten).

### Empfehlung (Fix) — ursprünglicher Plan: zu eng

Der initiale Vorschlag (`agentId` aus Schemas entfernen, `agentId = defaultAgentId` erzwingen) wurde während der Umsetzung verworfen: Das **Paperclip-Brain-Plugin** ([`packages/plugins/brain/src/worker.ts:49`](../../packages/plugins/brain/src/worker.ts#L49)) setzt `agentId` legitim per Body, um innerhalb des einen Paperclip-Tokens je nach `runCtx.agentId` zwischen ACL-Scopes (CEO, CFO, CMO, walter, …) umzuschalten. Der harte Fix hätte das Plugin lautlos auf leere Ergebnisse degradiert (`"PAPERCLIP"` ist in [seed-acl.ts](../../packages/brain/scripts/seed-acl.ts) nicht geseedet → leerer Scope).

### Umgesetzter Fix — Token-gebundene agentId-Allowlist

Drei Änderungen, zusammen 2026-05-16 gemerged:

1. **`auth.ts`**: Tokens mappen jetzt auf `TokenIdentity = { defaultAgentId, allowedAgentIds: string[] }` statt einer einzelnen String-Identität. `BRAIN_CLAUDE_CODE_TOKEN` und `BRAIN_N8N_TOKEN` sind hart auf `["walter"]` bzw. `["n8n"]` beschränkt und können nicht erweitert werden. Nur `BRAIN_PAPERCLIP_TOKEN` lässt sich per **`BRAIN_PAPERCLIP_ALLOWED_AGENTS=CEO,CFO,CMO,CTO,CPO,walter`** (komma-separiert) erweitern — das ist die einzige Stelle, an der Multi-Agent-Routing legitim ist.
2. **`dispatcher.ts`**: Vor jedem Tool-Call validiert `resolveAgentId()`, dass `args.agentId` (oder Fallback `defaultAgentId`) in `identity.allowedAgentIds` enthalten ist. Andernfalls **403** mit `requestedAgentId` im Audit-Log und `audit.agentId = defaultAgentId` (der echte Bearer-Principal, nicht der versuchte Wert) — damit ist das Audit-Log gegen die Forgery von Finding A (geprüft und entkräftet) gehärtet.
3. **`com.whitestag.brain-mcp.plist`** + Deployment-README: `BRAIN_PAPERCLIP_ALLOWED_AGENTS` als neues Pflicht-Env mit sinnvollem Default-Wert (`CEO,CFO,CMO,CTO,CPO,walter`) dokumentiert.

### Verifikation des Fixes

Neue Tests in [`packages/brain/test/dispatcher.test.ts`](../../packages/brain/test/dispatcher.test.ts) — 11 Cases, alle grün:

- `n8n`-Token mit `args.agentId="walter"` → **403** (cross-token impersonation geblockt)
- `walter`-Token mit `args.agentId="n8n"` → **403**
- `PAPERCLIP`-Token mit `args.agentId="n8n"` → **403** (nicht in Allowlist)
- `PAPERCLIP`-Token mit `args.agentId="CEO"` → **200**, ACL als `CEO` durchgereicht (in-token Multi-Agent funktioniert)
- Fallback ohne `agentId` im Body → `defaultAgentId` wird verwendet

Plus Update in [`packages/brain/test/auth.test.ts`](../../packages/brain/test/auth.test.ts) (8 Cases): Token-Identity-Shape, Env-Parsing der Allowlist, walter/n8n bleiben hart auf ihre Identität gepinnt.

**Smoke-Test gegen den laufenden MCP nach Deploy:**
```bash
# Muss 403 zurückgeben:
curl -i -X POST http://localhost:7777 \
  -H "Authorization: Bearer $BRAIN_N8N_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_scope","args":{"agentId":"walter"}}'

# Muss 200 zurückgeben (Paperclip-Token, CEO ist in Allowlist):
curl -i -X POST http://localhost:7777 \
  -H "Authorization: Bearer $BRAIN_PAPERCLIP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tool":"list_scope","args":{"agentId":"CEO"}}'
```

### Deployment-Hinweis

Beim Update der Brain-Services muss vor `launchctl unload/load` der neue Env `BRAIN_PAPERCLIP_ALLOWED_AGENTS` in die installierte Plist unter `~/Library/LaunchAgents/com.whitestag.brain-mcp.plist` übernommen werden. Default-Wert: `CEO,CFO,CMO,CTO,CPO,walter`. Wenn weitere Paperclip-Agenten ACL-Scope brauchen, hier ergänzen.

---

## Geprüft und entkräftet

Diese Punkte wurden während des Audits erwogen und von einem unabhängigen Filter-Sub-Agent als **kein eigenständiges, exploitable Finding** eingestuft. Sie werden hier dokumentiert, damit nachvollziehbar ist, dass sie nicht übersehen wurden — aber sie gehören nicht in den Severity-Triage-Stack.

### A. Brain Audit-Log-Forgery (Folgesymptom von Finding #1)

`audit.agentId` schreibt den vom Caller gelieferten `agentId` statt des Bearer-Principals (`packages/brain/src/mcp-server/index.ts:73-78`, `audit.ts:17-25`). Der README markets den Log als DSGVO-Auskunftsverwertbar — diese Zusage ist tatsächlich verletzt. **Aber:** Das Symptom verschwindet, sobald Finding #1 nach Empfehlung 3 gefixt ist. Es ist kein separat exploitable Vulnerability — der Forger braucht bereits einen gültigen Token, und sein Datenzugriff ist (nach Fix von Finding #1) durch die Token-eigene ACL begrenzt. Korrekte Triage: Quality/Compliance-Defect, nicht Security-Finding.

### B. Document-Opener (`scripts/document-opener/`) Origin-only-Auth

Der lokale Helper bindet korrekt an `127.0.0.1:19327`, nutzt `execFile` (kein Shell-Injection-Risiko), validiert Pfade per `realpathSync` gegen erlaubte Roots. Die Auth basiert nur auf dem `Origin`-Header (Allowlist enthält `https://company.whitestag.ai` per Default). Browser können den Origin-Header nicht fälschen — eine bösartige Website kann den Helper also nicht aus dem Browser heraus erreichen. Die theoretischen Angriffspfade (XSS auf `company.whitestag.ai`, Subdomain-Takeover, Service Worker, kompromittierte Browser-Extension) sind separate Vulnerabilities anderer Systeme und nicht hier zu zählen. Der harmlose Quirk `if (!origin) return true; // server-to-server, allow` ([server.ts:17](../../scripts/document-opener/src/server.ts#L17)) erweitert keine Privilegien, weil ein lokaler Non-Browser-Caller ohnehin Code-Execution-Rechte hat.

**Empfehlenswertes Hardening (nicht in Severity-Stack):**
- Extension-Allowlist für `open` (kein `.app`/`.command`/`.sh`/`.bat`/`.exe`/`.lnk`/`.scr`)
- Engerer Default-Root als `~/Documents` (z.B. `~/Documents/Paperclip/`) oder explizite Operator-Opt-in
- Shared-Secret zusätzlich zum Origin-Check

### C. Andere geprüfte Pfade ohne Findings

- **`packages/plugins/brain/src/worker.ts:45-49`** — der Plugin-Wrapper überschreibt `agentId` mit dem `runCtx.agentId`, blockt die Body-Override-Pfad. Der direkte HTTP-Pfad gegen den MCP bleibt (Finding #1).
- **Drizzle-Queries** (`packages/brain/src/db/queries.ts`, `packages/brain/src/mcp-server/tools.ts`) nutzen parameterized template literals — kein SQL-Injection-Vektor.
- **Pushover-Client** (`packages/plugins/pushover-watch/src/pushover-client.ts`) nutzt `URLSearchParams` mit ordentlicher Encoding — kein Header-/Body-Injection-Vektor. `clickbackBaseUrl` kommt aus Config, nicht aus Request-Daten.
- **Mention-Parser** (`packages/plugins/pushover-watch/src/mentions.ts`) extrahiert nur `[a-zA-Z0-9_-]+` — kein Injection.
- **`MarkdownBody.tsx`** verwendet react-markdown mit `safeMarkdownUrlTransform`; `<a href>` wird durch Reacts URL-Sanitisierung gefiltert, kein neuer XSS-Vektor.
- **Mermaid-Block in `MarkdownBody.tsx`** mit `dangerouslySetInnerHTML` ist preexisting, nicht in diesem Branch geändert.
- **launchd-/Task-Scheduler-Templates** substituieren nur operator-kontrollierte Variablen.
- **`obsidian-tagger/tagger.py`** ist CLI, Eingaben sind lokale Files und LM-Studio auf `127.0.0.1` — nicht netzwerk-exponiert.

### D. Supply Chain

`pnpm-lock.yaml` hat substantielle Updates, aber konkrete CVE-Hinweise auf bestimmte Pakete sind ohne Vergleich zu einer Vulnerability-Datenbank nicht aussagekräftig. Empfehlung: `pnpm audit --prod` plus Renovate/Dependabot auf dem Branch laufen lassen — das gehört in einen eigenen Workflow, nicht in einen Code-Review-Pass.

---

## Empfohlene Folge-Schritte

1. **Sofort** Finding #1 fixen (Branch nicht in Produktion bringen, bevor das gefixt ist — die n8n- und walter-Tokens dürfen sich nicht gegenseitig impersonieren können). Geschätzter Aufwand: < 30 Minuten Code-Änderung + Test.
2. Zweiter Audit-Pass auf Master-Code (Mail-Hub, Mistral-Adapter, Sekretärin-Routing) in derselben Methodik — wurde diesmal bewusst weggelassen, um den Branch-Diff vollständig zu prüfen.
3. Hardening-Sweep auf `scripts/document-opener/` mit den unter (B) genannten Maßnahmen — kein Vulnerability, aber sinnvolle Defense-in-Depth.
4. `pnpm audit --prod` und Lockfile-Diff gegen Master als eigene Supply-Chain-Pass.
