# i18n-Overlay — GUI-Übersetzung für Paperclip per Sprach-Dateien

**Datum:** 2026-06-12
**Status:** Design freigegeben
**Branch:** `feat/i18n-overlay-plugin`

## Ziel

Die Paperclip-GUI über austauschbare JSON-Sprach-Dateien lokalisieren (Start:
Deutsch), so dass die Lösung

1. **datei-basiert** ist (neue Sprache = neue JSON-Datei),
2. auf **jedem Rechner (Mac + Windows)** installierbar ist,
3. **Paperclip-Updates übersteht**, ohne den Core-Code zu forken.

## Ausgangslage / Randbedingungen (verifiziert)

- Die GUI ist eine **statische React-SPA** (`ui/dist`, ~306 `.tsx`-Dateien) mit
  **fest einkodierten englischen Strings** und **keiner i18n-Infrastruktur**
  (kein i18next/react-intl).
- Auf Zielrechnern läuft Paperclip über **`npx paperclipai onboard`** — also ein
  **vorgebautes, minifiziertes Bundle** ohne Quellcode/Build vor Ort. Den Core
  zu patchen/forken scheidet damit praktisch aus; jedes Update überschreibt alles.
- Plugin-Slot-UIs werden als **ES-Module ins selbe Dokument** geladen (React via
  `globalThis.__paperclipPluginBridge__`, **kein iframe** — iframe nur für separate
  „Launcher"). Ein Plugin in einem Dauer-Slot läuft damit im Host-DOM und **kann**
  per `MutationObserver` die gerenderte GUI übersetzen.
- Es existiert ein verwaister `paperclip-i18n/`-Ordner (nur `node_modules` mit
  `@babel/parser`+`traverse`, nicht in Git) — Überrest eines abgebrochenen Versuchs.
  Wird zu `packages/plugins/i18n-overlay/` aufgeräumt/ersetzt.

## Getroffene Entscheidungen

- **Sprach-Umfang:** Deutsch jetzt, Engine aber sprach-agnostisch gebaut — neue
  Sprache = nur eine weitere JSON-Datei. Kein Sprach-Umschalter-UI in v1.
- **Liefer­weg:** Echtes Paperclip-Plugin als Hauptweg (Install/Update über den
  Plugin-Manager) **plus** dieselbe Engine als Userscript-Build (update-fester
  Notnagel), ohne Code-Duplikat.
- **Abdeckung v1:** Wachsendes Wörterbuch mit **Englisch-Fallback** — nur exakte
  Strings; nicht Übersetztes bleibt sichtbar Englisch. Interpolation/Plurale später.

## Architektur & Komponenten

Neues Paket: `packages/plugins/i18n-overlay/`. Vier Bausteine, **eine geteilte Engine**.

### 1. Übersetzungs-Engine — `src/engine.ts`
Framework-frei (reines TS, **kein React**), damit identisch in Plugin und Userscript
lauffähig.
- Lädt ein Wörterbuch, läuft das DOM einmal durch, ersetzt **exakt passende**
  (getrimmte) Text-Knoten + Whitelist-Attribute (`placeholder`, `title`, `aria-label`).
- `MutationObserver` auf `document.body` (`childList`, `characterData`, `subtree`)
  übersetzt neu gerenderte/­geänderte Knoten live; Verarbeitung gebündelt
  (Microtask/rAF), nur neue/geänderte Knoten — kein Voll-Rescan.
- **Schleifen-Schutz:** `WeakSet` verarbeiteter Knoten + Guard-Flag, das die
  eigenen Schreibvorgänge des Observers ausklammert.
- **Skip-Liste:** `<script>`, `<style>`, `<input>/<textarea>`-Werte, `contenteditable`,
  Code-Blöcke.
- **Sicherheits-Eigenschaft:** Nur exakte Treffer werden ersetzt → Nutzer­daten
  (Aufgaben­titel, Agenten-Namen, freie Texte) matchen das Chrome-Wörterbuch nie
  und bleiben unangetastet.
- **Konfiguration:** Liste der zu übersetzenden Attribute, Skip-Selektoren.
- Öffentliche API (Vorschlag): `createTranslator(dictionary, options) → { start(), stop() }`.

### 2. Wörterbuch-Format — `src/dictionary/de.json`
Sprach-agnostisch; die Engine nimmt jedes konforme Wörterbuch:
```json
{
  "$meta": { "language": "de", "version": 1 },
  "text": { "Run routine": "Routine ausführen", "No project": "Kein Projekt" },
  "attr": { "Search issues…": "Aufgaben suchen…" }
}
```
`text` = exakte Text-Knoten-Treffer, `attr` = Attribut-Werte. `$meta` rein informativ.

### 3. Plugin-Hülle — `src/manifest.ts`, `src/worker.ts`, `src/ui/index.tsx`
Minimal: UI-Modul in einem Dauer-Slot (`globalToolbarButton`, Anzeige z.B. „🌐 DE"),
das beim Mounten `createTranslator(de.json).start()` aufruft. Worker quasi leer
(alles client-seitig). Wörterbuch als Asset im Plugin-Bundle. Install/Update über
Paperclips Plugin-Manager. (Späterer `settingsPage`-Slot mit Umschalter ist
architektonisch vorgesehen, aber nicht Teil von v1.)

### 4. Userscript-Build — `src/userscript/`
Dieselbe Engine + Wörterbuch inline, mit `// ==UserScript==`-Header und `@match`
auf die Paperclip-URL → `dist/paperclip-de.user.js`. Zweites Build-Target, **kein
Code-Duplikat** (importiert dieselbe `engine.ts`).

### 5. Ernte-Werkzeug — `tools/harvest.ts` (nur Dev)
Babel-basiert; zieht aus `ui/src/**/*.tsx` Kandidaten-Strings (JSX-Text-Kinder +
bekannte Attribut-Props wie `placeholder`/`title`/`aria-label`/`label`), schreibt
sie als leere Einträge in `de.template.json`. **Merge-fähig:** Re-Run nach einem
Paperclip-Update zeigt neue/geänderte Strings als Diff; vorhandene Übersetzungen
bleiben erhalten. Seeding-Hilfe, nicht erschöpfend — die Laufzeit-Engine deckt den
Rest per Fallback ab.

## Datenfluss

1. **Dev (hier):** `harvest` → Start-Wortschatz (Menüs, Buttons, Navigation,
   Settings) → manuell übersetzen.
2. **Build:** Engine + `de.json` → Plugin-Artefakt **und** Userscript.
3. **Zielrechner:** Plugin über Plugin-Manager importieren (oder Userscript hinzufügen).
4. **Laufzeit:** Host rendert Englisch → Engine ersetzt Treffer → Nutzer sieht
   Deutsch, Rest bleibt sichtbar Englisch.

## Fehlerverhalten & Risiken

- **Update ändert UI-Strings:** Eintrag matcht nicht mehr → String bleibt Englisch
  (degradiert *sicher*, nie falsch). Harvest-Re-Run bringt Änderungen ans Licht.
- **Reversibel:** rein visuell zur Laufzeit; Plugin deaktivieren / Userscript aus →
  wieder Englisch. Keine Daten verändert.
- **DOM-Sharing-Risiko:** ① hängt daran, dass Slot-UIs sich das Host-DOM teilen
  (heute verifiziert). Falls künftige Paperclip-Versionen Slot-UIs in iframes
  kapseln, bricht ① — dann greift der Userscript-Notnagel ②.
- **Performance:** Observer verarbeitet nur Deltas, gebündelt; messbar in Tests.

## Tests

- **Engine (jsdom):** Treffer-Text/Attribute werden übersetzt; Nutzer­daten bleiben
  unangetastet; keine Endlosschleife; dynamisch hinzugefügte Knoten werden erfasst;
  Skip-Liste greift.
- **Harvest:** Beispiel-`.tsx` → erwartete extrahierte Strings; Merge erhält
  bestehende Übersetzungen.
- **Manueller Smoke-Test:** Plugin im Dev-Paperclip laden, Sichtprüfung.

## Bewusst nicht in v1 (YAGNI)

- Kein Sprach-Umschalter-UI (kommt später als `settingsPage`-Slot).
- Keine Interpolation/Plural-Regeln („3 von 5" bleibt erst Englisch).
- Kein Inject-Proxy-Ansatz.
- Keine server-seitigen Änderungen.
