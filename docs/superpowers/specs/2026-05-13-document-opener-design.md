# Document Opener — Design Spec

**Date:** 2026-05-13
**Author:** Walter Schönenbröcher / Claude Code
**Status:** Approved (brainstorming complete, awaiting implementation plan)

## Problem

In Paperclip-Issues und -Kommentaren werden regelmäßig lokale Datei-Pfade referenziert
(Tagespläne, Konzepte, Word-Dokumente, Markdown-Notizen). Aktuell muss Walter den
Pfad aus dem Markdown kopieren und manuell im Finder/Explorer suchen, um die Datei
zu öffnen. Browser-Sicherheitsrichtlinien verbieten direkte `file://`-Links aus einer
Web-App.

## Goal

Wenn ein Markdown-Link in Paperclip auf einen lokalen Pfad zeigt, erscheinen zwei
kleine Inline-Icon-Buttons direkt nach dem Link:

- **„Öffnen"** — öffnet die Datei im plattform-eigenen Standard-Programm
- **„Im Finder/Explorer zeigen"** — markiert die Datei in Finder (macOS) bzw.
  selektiert sie im Explorer (Windows)

Beide Aktionen funktionieren auf macOS und Windows. Die Brücke zwischen Browser-UI
und Betriebssystem ist ein lokaler HTTP-Helper auf `127.0.0.1:19327`, der per
launchd (macOS) bzw. Task Scheduler (Windows) automatisch beim Login startet.

## Non-Goals

- Keine Linux-Unterstützung in dieser Iteration (kein einheitliches Reveal-Äquivalent)
- Keine iOS-/mobile-Unterstützung; Buttons werden dort einfach ausgeblendet
- Kein Datei-Browser/Picker, keine Inhalts-Vorschau, kein Schreib-/Lösch-Zugriff
- Keine Cross-Maschine-Öffnung — Helper öffnet nur Dateien, die auf der Maschine
  liegen, von der aus der Browser bedient wird
- Kein Custom-URL-Scheme (`pcfile://`); Auto-Detect absoluter Pfade reicht aus

## Architecture

```
┌──────────────────────────────────────┐         ┌───────────────────────────────┐
│  Paperclip-UI (Browser)              │         │  document-opener (Node)       │
│  Origin: Paperclip-Server            │         │  127.0.0.1:19327              │
│                                      │  HTTP   │                               │
│  MarkdownBody erkennt absoluten      │  ────►  │  POST /open    { path }       │
│  Pfad → rendert Link + 2 Icon-       │         │  POST /reveal  { path }       │
│  Buttons (Öffnen / Im Finder zeigen) │         │  GET  /health                 │
└──────────────────────────────────────┘         │                               │
                                                 │  Validiert Pfad gegen Roots,  │
                                                 │  ruft `open` / `explorer.exe` │
                                                 └────────────┬──────────────────┘
                                                              │
                                                  ┌───────────┴────────────┐
                                              macOS                     Windows
                                              launchd                   Task Scheduler
                                              LaunchAgent               (onlogon)
```

### Drei Komponenten

1. **Helper-Daemon** — Node-Skript, hört auf `127.0.0.1:19327`, validiert Pfade
   und ruft plattformspezifische Open-/Reveal-Befehle auf
2. **Auto-Start-Mechanismus** — launchd LaunchAgent (macOS) bzw. Task-Scheduler-Task
   (Windows); beide mit Restart-on-Crash
3. **UI-Integration** — Auto-Detect lokaler Pfade in `MarkdownBody.tsx`, zwei
   Inline-Icon-Buttons, fetch zum Helper

### Trust-Modell

- Helper bindet nur an `127.0.0.1` (nie `0.0.0.0`) — kein Zugriff von außerhalb
  der Maschine
- CORS strikt auf konfigurierte Paperclip-Origins beschränkt
- Content-Type `application/json` erzwingt CORS-Preflight; fremde Browser-Tabs
  können den Helper nicht per `no-cors`-Drive-by-Call ansprechen
- Path-Whitelist beschränkt zusätzlich, welche Verzeichnisse überhaupt geöffnet
  werden können — Defense-in-Depth, falls Origin-Check umgangen werden sollte
- Symlink-Resolution (`fs.realpathSync`) verhindert Whitelist-Escape via Symlink

## Components

### Helper-Daemon — `scripts/document-opener/server.ts`

Single-File Node-Skript, Zero-Dependency außer Node-Built-Ins. Läuft mit dem
System-Node aus dem `PATH`.

**Endpoints:**

| Methode | Pfad      | Body                       | Antwort                                    |
|---------|-----------|----------------------------|--------------------------------------------|
| `GET`   | `/health` | —                          | `200 {"ok":true,"version":"1","roots":[…]}` |
| `POST`  | `/open`   | `{"path":"/abs/path"}`     | `200 {"ok":true}` oder `4xx {"error":"…"}` |
| `POST`  | `/reveal` | `{"path":"/abs/path"}`     | `200 {"ok":true}` oder `4xx {"error":"…"}` |

**Plattform-Dispatch:**

```ts
function openArgs(path: string) {
  switch (process.platform) {
    case "darwin": return { cmd: "open",         args: [path] };
    case "win32":  return { cmd: "cmd",          args: ["/c", "start", "", path] };
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

function revealArgs(path: string) {
  switch (process.platform) {
    case "darwin": return { cmd: "open",         args: ["-R", path] };
    case "win32":  return { cmd: "explorer.exe", args: [`/select,${path}`] };
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}
```

**Path-Validation-Pipeline** (in dieser Reihenfolge):

1. **Tilde-Expansion** — `~/foo` → `os.homedir() + "/foo"`
2. **Environment-Expansion (Windows)** — `%USERPROFILE%`, `%APPDATA%`,
   `%LOCALAPPDATA%` werden expandiert; andere `%VARS%` bleiben unexpandiert und
   führen zu Validierungs-Failure
3. **Normalisierung** — `path.resolve()` rechnet `..` raus, normalisiert Slashes
4. **Realpath** — `fs.realpathSync()` folgt Symlinks; verhindert Symlink-Escape
5. **Existenz** — `fs.statSync()` muss erfolgreich sein
6. **Whitelist-Check** — Realpath muss mit (Realpath einer Whitelist-Root + Separator)
   beginnen. Vergleich case-insensitive auf `win32`, case-sensitive auf `darwin`.
7. **Verletzung** → `403 {"error":"path outside allowed roots"}`

**Befehlsausführung:**

```ts
child_process.execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => { … })
```

`execFile` statt `exec` — kein Shell-Escaping nötig, weil Pfade als
Argumente-Array übergeben werden.

### Config — `~/.paperclip/document-opener.json`

```json
{
  "port": 19327,
  "roots": [
    "~/SynologyDrive/2026",
    "/Volumes/WHITESTAG-ARCHIV/Obsidian"
  ],
  "allowedOrigins": [
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    "https://company.whitestag.ai"
  ]
}
```

**Verhalten:**

- Beim Start einmalig gelesen. Config-Änderungen werden durch Service-Neustart
  übernommen (`launchctl kickstart -k …` auf macOS,
  `schtasks /end + /run` auf Windows). Kein Live-Reload — vereinfacht das
  Konzept und macht die Plattformen identisch.
- Fehlende oder leere Config → Helper startet trotzdem, lehnt aber alle Requests
  mit `503 {"error":"not configured"}` ab (sichtbar in der UI als
  „Document-Opener nicht aktiv")
- Defaults: `port = 19327`, `allowedOrigins = ["http://localhost:3100",
  "http://127.0.0.1:3100", "https://company.whitestag.ai"]`
- `roots` ist Pflichtfeld
- Windows-Pfade in `roots`: JSON-escaped (`"C:\\Users\\Walter\\Documents"`) oder
  mit Forward-Slashes (`"C:/Users/Walter/Documents"`); beide werden akzeptiert

**Config-Verzeichnis pro Plattform:**

- macOS: `~/.paperclip/document-opener.json` (= `$HOME/.paperclip/…`)
- Windows: `%USERPROFILE%\.paperclip\document-opener.json` (Node's `os.homedir()`
  liefert beides korrekt)

### Auto-Start — macOS LaunchAgent

`~/Library/LaunchAgents/ing.paperclip.document-opener.plist`

Spiegelt das Pattern von `ing.paperclip.dev.plist`:

- `Label` = `ing.paperclip.document-opener`
- `RunAtLoad` = `true`
- `KeepAlive` = `true` (Restart bei Crash)
- `EnvironmentVariables`:
  - `PATH` = `$HOME/.nvm/versions/node/v22.22.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  - `HOME` = `/Users/walterschoenenbroecher.de`
- `StandardOutPath` = `~/Library/Logs/paperclip-document-opener/stdout.log`
- `StandardErrorPath` = `~/Library/Logs/paperclip-document-opener/stderr.log`
- `ProgramArguments` = `[<absoluter Pfad zu node>, "<repo>/scripts/document-opener/dist/server.js"]`
  (absoluter Pfad wird vom Installer aus `process.execPath` substituiert)

Aktivierung: `launchctl bootstrap gui/$UID <plist>` (entspricht dem Pattern der
bestehenden Paperclip-Services).

### Auto-Start — Windows Task Scheduler

Task `\Paperclip\DocumentOpener`, registriert via `schtasks /create /xml task.xml`.

`task.xml` enthält:

- `<Triggers><LogonTrigger>` — startet bei Login
- `<Actions><Exec>` — `Command = <absoluter Pfad zu node.exe>`,
  `Arguments = "<repo>\scripts\document-opener\dist\server.js"`
  (Pfade vom Installer substituiert)
- `<Settings><RestartOnFailure>` — `Interval = PT1M`, `Count = 999`
- `<Principals>` mit `RunLevel = LeastPrivilege` (kein Admin nötig)
- `<StartWhenAvailable>true</StartWhenAvailable>` — startet nach, falls Login
  während Maschine aus

Logs nach `%LOCALAPPDATA%\Paperclip\document-opener\logs\stdout.log` (Helper
schreibt selbst, Task Scheduler erfasst keine stdout).

### Installer — `scripts/document-opener/install.js`

Ein Node-Skript, detektiert Plattform zur Laufzeit:

```
node scripts/document-opener/install.js
  ├─ Default-Config schreiben, falls fehlt
  ├─ Build: tsc/esbuild server.ts → dist/server.js
  ├─ Detect Node-Binary: process.execPath (absoluter Pfad zum laufenden Node)
  │    macOS:   z.B. /Users/walter/.nvm/versions/node/v22.22.0/bin/node
  │    Windows: z.B. C:\Program Files\nodejs\node.exe
  ├─ Templates patchen — substitute {{NODE_BIN}}, {{SCRIPT}}, {{HOME}}, {{LOGS}}:
  │    macOS:   templates/ing.paperclip.document-opener.plist.template
  │    Windows: templates/document-opener-task.xml.template
  ├─ Installation:
  │    macOS:   cp plist → ~/Library/LaunchAgents/
  │             launchctl bootstrap gui/$UID <plist>
  │    Windows: schtasks /create /xml <task.xml> /tn "\Paperclip\DocumentOpener" /f
  │             schtasks /run /tn "\Paperclip\DocumentOpener"
  └─ Health-Check: poll 127.0.0.1:19327/health bis OK oder 10s Timeout
       fail → exit 1 mit Log-Pfad-Hinweis
```

**Wichtig:** Installer nutzt `process.execPath`, damit der korrekte Node-Binary-Pfad
im Template landet — sonst weiß launchd/Task Scheduler nicht, welches Node zu nutzen
ist (PATH wird in beiden Mechanismen nicht aus der User-Shell geerbt).

**Idempotent** — re-running ersetzt nur Helper-Code + Task/plist, lässt Config
unangetastet.

### UI — Local-Path-Detection

**Neue Datei `ui/src/lib/local-document.ts`:**

```ts
const LOCAL_PATH_PATTERNS = [
  /^\/Users\//,            // macOS user home
  /^\/Volumes\//,          // macOS mounted volumes
  /^~\//,                  // tilde (any OS)
  /^file:\/\/\//,          // file:// URLs (all platforms)
  /^[a-zA-Z]:[\\/]/,       // Windows drive: C:\ or C:/
  /^\\\\[^\\]/,            // Windows UNC: \\server\share
];

export function isLocalFileHref(href: string): boolean {
  return LOCAL_PATH_PATTERNS.some((re) => re.test(href));
}

export function normalizeLocalPath(href: string): string {
  // strip file:// prefix; decode URL-encoded chars
  // file:///C:/foo → C:/foo (strip leading slash before drive letter)
  // file:///Users/foo → /Users/foo
  …
}

export async function openDocument(path: string): Promise<void> { … }
export async function revealDocument(path: string): Promise<void> { … }

export function useDocumentOpenerStatus(): "ready" | "unavailable" {
  // React-Hook, pollt /health alle 30s
  …
}
```

**Änderung in `ui/src/components/MarkdownBody.tsx` (Line ~558, `a`-Renderer):**

Vor dem Fallback-Branch wird ein neuer Check eingeschoben:

```tsx
if (href && isLocalFileHref(href)) {
  return (
    <LocalDocumentLink href={href}>
      {linkChildren}
    </LocalDocumentLink>
  );
}
```

`LocalDocumentLink` ist eine neue Komponente, die den Link-Text plus zwei kleine
Icon-Buttons rendert:

- Lucide `FileText` (16px) — `aria-label="Öffnen"`, `onClick=openDocument`
- Lucide `FolderOpen` (16px) — `aria-label="Im Finder zeigen"` (macOS) bzw.
  `"Im Explorer zeigen"` (Windows; via `navigator.platform`), `onClick=revealDocument`
- Beide `disabled` wenn `useDocumentOpenerStatus()` === `"unavailable"`,
  mit Tooltip „Document-Opener nicht aktiv"

Der Link-Text selbst bleibt regulärer `<a>` ohne Click-Handler — Click auf Text
macht im Browser nichts spezielles (oder zeigt `href` in Status-Bar). Aktionen
laufen ausschließlich über die Icons.

## Data Flow

### Happy Path

```
User klickt [Öffnen]-Icon neben "[Tagesplan](/Users/walter/.../Tagesplan.md)"
  → openDocument("/Users/walter/.../Tagesplan.md")
  → fetch POST http://127.0.0.1:19327/open
       Headers: { "Content-Type": "application/json" }
       Body:    { "path": "/Users/walter/.../Tagesplan.md" }
  → Browser sendet CORS-Preflight (OPTIONS) wegen Content-Type
  → Helper antwortet Preflight: Access-Control-Allow-Origin: <Paperclip-Origin>
  → Browser sendet POST
  → Helper:
       expand ~ → resolve → realpath → check Whitelist → execFile("open", [path])
  → 200 { "ok": true }
  → UI: kein Toast (Datei öffnet sich sichtbar im Standard-Programm)
```

`/reveal` identisch, nur mit `open -R` (macOS) bzw. `explorer.exe /select,…` (Windows).

### Health-Polling

`useDocumentOpenerStatus` macht beim Mount und alle 30s `fetch GET /health` mit
2s Timeout. Bei Network-Error oder Non-2xx → `"unavailable"`. Bei 2xx → `"ready"`.
Status global cached via React-Context, damit nicht jeder `MarkdownBody`-Mount
ein eigenes Polling startet.

## Error Handling

| Szenario                              | Helper-Antwort                                   | UI-Verhalten                                          |
|---------------------------------------|--------------------------------------------------|-------------------------------------------------------|
| Helper nicht erreichbar               | — (fetch failure)                                | Toast: „Document-Opener nicht aktiv". Buttons grayed. |
| Origin nicht in Allowlist             | CORS-Preflight fails                             | Browser blockt — Diagnose nur über DevTools.          |
| Pfad nicht in Whitelist               | `403 {"error":"path outside allowed roots"}`     | Toast: „Pfad nicht freigegeben: `<path>`."            |
| Pfad nicht existent                   | `404 {"error":"file not found"}`                 | Toast: „Datei nicht gefunden: `<path>`."              |
| Symlink zeigt aus Whitelist raus      | `403` (realpath-Check)                           | Wie Whitelist-Fall.                                   |
| `open` / `explorer.exe` returncode ≠0 | `502 {"error":"open failed: <stderr>"}`          | Toast: „Öffnen fehlgeschlagen: `<stderr>`."           |
| Config fehlt                          | `503 {"error":"not configured"}` auf allen Routes | Toast: „Document-Opener nicht konfiguriert."          |
| `execFile`-Timeout (>5s)              | `504 {"error":"timeout"}`                        | Toast: „Öffnen-Timeout."                              |

Toast-Mechanismus: bestehender Sonner-Toaster aus dem Projekt
(`toast.error(...)` aus `ui/src/lib/toast.ts` — falls existent, sonst neu anlegen).

## Testing

### Helper — `scripts/document-opener/server.test.ts`

vitest, im Repo-Root laufbar via `pnpm vitest run scripts/document-opener`.

**Path-Validation-Matrix (POSIX + Windows):**

| Fall                          | POSIX                          | Windows                              |
|-------------------------------|--------------------------------|--------------------------------------|
| Gültig, innerhalb Root        | `/Users/walter/x.md`           | `C:\Users\Walter\x.md`               |
| `..`-Escape (resolve fängt)   | `/Users/walter/../etc/passwd`  | `C:\Users\Walter\..\Windows\…`       |
| Symlink-Escape (realpath)     | Mocked symlink                 | Mocked symlink                       |
| Nicht-existent (statSync)     | `/Users/walter/nope.md`        | `C:\nope.md`                         |
| Außerhalb Roots               | `/etc/hosts`                   | `C:\Windows\system32\drivers\etc\…`  |
| Tilde-Expansion               | `~/x.md`                       | `~\x.md`                             |
| Env-Expansion (Windows only)  | —                              | `%USERPROFILE%\x.md`                 |
| URL-encoded                   | `/Users/walter/foo%20bar.md`   | `C:/Users/Walter/foo%20bar.md`       |

**Origin-Check:**

- erlaubter Origin → `Access-Control-Allow-Origin: <origin>` header
- fremder Origin → kein ACAO-Header; Preflight wird vom Browser geblockt
- Tests prüfen Header direkt, kein echter Browser nötig

**Smoke:**

- `GET /health` ohne Config → `503`
- `GET /health` mit Config → `200` + `roots` im Body
- `execFile` gemockt — kein echtes `open` / `explorer.exe` in Tests

`process.platform`-Tests laufen über `vi.stubGlobal`/`Object.defineProperty`.

### UI — `ui/src/lib/local-document.test.ts`, `ui/src/components/MarkdownBody.test.tsx`

- `isLocalFileHref`:
  - Positive: alle 6 Pattern (POSIX-User, Volumes, Tilde, file://, Windows-Drive, UNC)
  - Negative: `http://`, `https://`, `mailto:`, `pcfile://`, Issue-Refs
    (`/issues/PCL-123`), Mention-Chips
- `normalizeLocalPath`:
  - `file:///Users/foo%20bar/x.md` → `/Users/foo bar/x.md`
  - `file:///C:/foo%20bar/x.md` → `C:/foo bar/x.md`
  - `~/foo.md` bleibt `~/foo.md` (Expansion passiert serverseitig)
- `MarkdownBody` mit lokalem Pfad-Link rendert zwei Buttons mit korrekten
  `aria-label`s
- `useDocumentOpenerStatus`: Mock-fetch → `"unavailable"` macht beide Buttons
  `disabled` und setzt Tooltip

## Open Questions / Decisions Made

| Frage                                    | Entscheidung                                          |
|------------------------------------------|-------------------------------------------------------|
| Klick-Aktion?                            | Zwei Buttons (Öffnen + Im Finder/Explorer zeigen)     |
| Wie Links erkennen?                      | Auto-Detect absolute Pfade (kein Custom-Schema)       |
| Pfad-Scope?                              | Whitelist-Wurzeln in Config (Defense-in-Depth)        |
| Wie läuft der Helper?                    | launchd (macOS) / Task Scheduler (Windows)            |
| UI-Platzierung?                          | Inline-Icons direkt nach dem Link                     |
| Cross-Platform-Scope?                    | macOS + Windows als Erst-Klassen-Plattformen          |
| Single-Script vs. Workspace-Package?     | Standalone `scripts/document-opener/`                 |
| Helper am Paperclip-Server-Origin?       | Nein — eigener Helper auf `127.0.0.1:19327`           |
| Linux?                                   | Out of scope (kein sauberes Reveal-Äquivalent)        |

## File-Inventar

**Neu:**

- `scripts/document-opener/server.ts` — Helper-Daemon
- `scripts/document-opener/install.js` — Plattform-aware Installer
- `scripts/document-opener/server.test.ts` — Helper-Tests
- `scripts/document-opener/templates/ing.paperclip.document-opener.plist.template`
- `scripts/document-opener/templates/document-opener-task.xml.template`
- `scripts/document-opener/README.md` — Installations- + Troubleshoot-Doku
- `scripts/document-opener/package.json` — nur für `tsc`/`esbuild`-Build-Step
- `scripts/document-opener/tsconfig.json`
- `ui/src/lib/local-document.ts` — Path-Detection + fetch-Helpers + Hook
- `ui/src/lib/local-document.test.ts`
- `ui/src/components/LocalDocumentLink.tsx` — Link + 2 Icon-Buttons
- `ui/src/context/DocumentOpenerProvider.tsx` — globaler Health-Status

**Modifiziert:**

- `ui/src/components/MarkdownBody.tsx` — neuer Branch im `a`-Renderer
- `ui/src/components/MarkdownBody.test.tsx` — Test für neuen Branch
- `ui/src/App.tsx` (oder wo Provider gemounted werden) — DocumentOpenerProvider

**Konfig:**

- `~/.paperclip/document-opener.json` — User-Config (nicht im Repo)
