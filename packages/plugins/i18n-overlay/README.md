# i18n-overlay — GUI-Übersetzung für Paperclip

Übersetzt die Paperclip-Oberfläche zur Laufzeit über eine austauschbare
JSON-Sprachdatei. Startsprache ist Deutsch (`de.json`); weitere Sprachen
sind weitere JSON-Dateien nach demselben Schema.

## Was es macht

- Die Engine läuft im Browser und ersetzt sichtbare Oberflächen-Texte gegen
  Übersetzungen aus dem Wörterbuch.
- Übersetzt werden:
  - **Text-Knoten** per **Exakt-Treffer** (der getrimmte Knotentext muss
    1:1 ein Schlüssel in `text` sein), und
  - eine **Whitelist von Attributen** — `placeholder`, `title`, `aria-label`
    — per Exakt-Treffer gegen `attr`.
- **Nicht Übersetztes bleibt Englisch** (Fallback): fehlt ein Schlüssel oder
  ist die Übersetzung leer/identisch, wird der Originaltext unverändert
  gelassen.
- **Nutzerdaten werden nie angefasst.** Weil ausschließlich exakte
  Chrome-Strings (feststehende Oberflächen-Texte) gematcht werden, bleiben
  dynamische Inhalte wie Aufgabentitel, Projektnamen oder Kommentare
  unberührt — sie sind keine Wörterbuch-Schlüssel.
- **Skip-Liste:** Inhalte in `script`, `style`, `code`, `pre`, `textarea`
  und `[contenteditable="true"]` werden ausgelassen.

## Architektur in Kürze

Kern ist eine **framework-freie Engine** (`src/engine.ts`):

- Beim Start ein einmaliger Durchlauf des DOM-Baums (`translateTree`).
- Danach ein **`MutationObserver`**, der neu eingefügte Knoten,
  `characterData`-Änderungen und Attribut-Änderungen (gefiltert auf die
  Whitelist-Attribute) live nachübersetzt. Eigene Schreibvorgänge werden
  über eine `WeakMap` erkannt und ignoriert, damit keine Endlosschleife
  entsteht.
- Ein **Page-Lifetime-Singleton** (`ensureStarted`) stellt sicher, dass die
  Engine pro Seitenleben nur einmal startet; mehrfaches Mounten ist ein
  harmloser No-op.

Dieselbe Engine wird von **zwei Auslieferungswegen** geteilt.

## Zwei Auslieferungswege

### A) Paperclip-Plugin (Hauptweg)

Ein UI-Plugin, das eine unsichtbare Sidebar-Slot-Komponente
(`I18nOverlayMount`) mountet, die beim ersten Mount die Engine startet.

- **Bauen:**
  ```
  pnpm build
  ```
  Das ruft `tsc` und anschließend `scripts/build-ui.mjs` auf. esbuild
  bündelt Mount + Engine + das **inlinte Wörterbuch** selbst-enthaltend nach
  `dist/ui/index.js` (react und das Plugin-SDK bleiben als externe
  Bare-Specifier, die der Host-Loader shimt).
- **Installieren:** über Paperclips Plugin-Manager. Plugin-ID:
  `paperclip.i18n-overlay`.
- **Update-Festigkeit:** Läuft über das Plugin-System und fasst den
  Paperclip-Core nicht an — übersteht Paperclip-Updates.

### B) Userscript (Notnagel)

Ein eigenständiges Userscript für Tampermonkey/Violentmonkey, falls der
Plugin-Weg nicht verfügbar ist.

- **Bauen:**
  ```
  pnpm build:userscript
  ```
  Das ruft `esbuild.userscript.mjs` auf und schreibt
  `dist/paperclip-de.user.js` (Userscript-Header + gebündelte Engine +
  inlintes Wörterbuch).
- **Installieren:** Datei in Tampermonkey/Violentmonkey importieren.
- **Update-Festigkeit:** Maximal — fasst Paperclip nie an.
- **`@match`-Hinweis:** Das Userscript matcht standardmäßig nur
  `http://localhost:*/*` und `http://127.0.0.1:*/*` (der Default von
  `npx paperclipai onboard`). Ist Paperclip an LAN/Tailnet oder einen
  Hostnamen gebunden, eine zusätzliche `@match`-Zeile in
  `src/userscript/header.txt` ergänzen und mit `pnpm build:userscript`
  neu bauen.

## Wörterbuch pflegen / wachsen lassen

`src/dictionary/de.json` ist die **Quelle der Wahrheit**. Aufbau:

```json
{
  "$meta": { "language": "de", "version": 1 },
  "text": { "Projects": "Projekte", "Run routine": "Routine ausführen" },
  "attr": {}
}
```

- `text` — Map von Original-Oberflächentext auf Übersetzung (Exakt-Treffer
  auf Text-Knoten).
- `attr` — dieselbe Logik für die Whitelist-Attribute.

### Neue Strings einsammeln

```
pnpm harvest
```

`tools/harvest.ts` läuft per Babel über `ui/src/**/*.tsx` (relativ zum
Repo-Root), sammelt JSX-Textkandidaten und Attribut-Strings
(`placeholder`, `title`, `aria-label`, `label`) und trägt **neue**
Schlüssel mit **leerem Wert** in `de.json` ein. Bestehende Übersetzungen
bleiben unangetastet. Test-/Story-Dateien (`.test.`, `.stories.`) werden
übersprungen; JSX-Text wird Whitespace-normalisiert. Am Ende meldet das
Tool, wie viele Schlüssel noch unübersetzt (leer) sind.

> `pnpm harvest` setzt einen Dev-Checkout voraus, in dem `ui/src/**/*.tsx`
> existiert. Fehlt das Verzeichnis, bricht das Tool mit einer Meldung ab.

### Workflow

1. `pnpm harvest` — neue Schlüssel mit leerem Wert einsammeln.
2. Leere Werte in `de.json` übersetzen.
3. Neu bauen: `pnpm build` und/oder `pnpm build:userscript`.

> **Wichtig:** Das Wörterbuch wird zur **Build-Zeit** in beide Bundles
> eingebettet. Eine geänderte `de.json` wirkt erst **nach einem Rebuild**.
> Grund ist die Plugin-UI-Loader-Beschränkung: Der Host lädt die Plugin-UI
> als Blob; relative Importe und rohe JSON-Importe sind in diesem Pfad nicht
> ladbar — deshalb wird das Wörterbuch inlinet. „Austauschbare Sprachdatei"
> gilt damit auf Dev-/Build-Ebene, nicht zur Laufzeit.

## Bekannte Grenzen / Risiken

- **String-Matching gegen die fertige GUI ist fragil.** Ändert eine neue
  Paperclip-Version einen Oberflächentext, passt der Wörterbuch-Eintrag
  nicht mehr — dann bleibt der String einfach Englisch. Das **degradiert
  sicher** (nie falsch, nur unübersetzt). Nach Paperclip-Updates `pnpm
  harvest` erneut laufen lassen, um neue/geänderte Strings zu sehen.
- **Keine Interpolation/Plurale in v1.** Zusammengesetzte Strings wie
  „3 of 5" sind kein Exakt-Treffer und bleiben Englisch.
- **Plugin-Weg (A) hängt am geteilten Host-DOM.** Slot-UIs teilen sich heute
  das Host-DOM, deshalb kann die Engine die ganze Oberfläche sehen. Würde
  ein künftiges Paperclip Slot-UIs in iframes kapseln, bräche Weg A — dann
  greift der Userscript-Notnagel (Weg B).
- **Reversibel.** Plugin deaktivieren bzw. Userscript ausschalten → die
  Oberfläche ist wieder Englisch. Es werden keine Daten verändert.

## Entwicklung / Tests

```
pnpm test        # Vitest + jsdom: Engine + Harvest (14 Tests)
pnpm typecheck   # tsc --noEmit
pnpm build       # Plugin-Bundle nach dist/ui/index.js
pnpm build:userscript   # dist/paperclip-de.user.js
pnpm harvest     # neue Strings aus ui/src/**/*.tsx einsammeln
pnpm clean       # dist/ löschen
```

### Dateistruktur

```
src/
  engine.ts             framework-freie Übersetzungs-Engine + Singleton
  dictionary/de.json    Wörterbuch (Quelle der Wahrheit)
  manifest.ts           Plugin-Manifest (ID paperclip.i18n-overlay, Sidebar-Slot)
  worker.ts             Plugin-Worker-Entrypoint
  index.ts              Plugin-Entrypoint
  ui/
    Mount.tsx           unsichtbarer Sidebar-Mount, startet die Engine
    index.ts            UI-Entry (von build-ui.mjs gebündelt)
  userscript/
    entry.ts            Userscript-Entry (startet die Engine)
    header.txt          Userscript-Header (@match etc.)
scripts/build-ui.mjs    bündelt die Plugin-UI nach dist/ui/index.js
esbuild.userscript.mjs  baut dist/paperclip-de.user.js
tools/harvest.ts        Babel-Harvest der UI-Strings
test/                   Vitest-Suites (Engine + Harvest)
```

## Manueller Smoke-Test (vom Nutzer auszuführen)

Diese Schritte sind **in-app gegen ein laufendes Paperclip** durchzuführen
und nicht Teil der automatisierten Tests.

### Plugin-Modus

1. Paperclip im Dev starten — im Repo-Root `pnpm dev`.
2. Im Plugin-Manager das Plugin `paperclip.i18n-overlay` für eine Company
   aktivieren.
3. Die GUI neu laden.
4. Prüfen:
   - Seed-Strings erscheinen deutsch — z.B. in der Sidebar
     „Projects" → „Projekte", „Run routine" → „Routine ausführen".
   - Nicht übersetzte Strings bleiben englisch.
   - Nutzerinhalte (z.B. Aufgabentitel) sind unangetastet.

### Userscript-Modus

1. `dist/paperclip-de.user.js` in Tampermonkey/Violentmonkey installieren.
2. Paperclip neu laden.
3. Dieselben Seed-Strings wie oben prüfen (deutsch da, Rest englisch,
   Nutzerinhalte unberührt).
