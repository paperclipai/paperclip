# Design: GEO-Citation-Check (SEO/GEO-Monitoring 5c)

**Datum:** 2026-07-18
**Status:** Freigegeben (Brainstorming), bereit für Implementierungsplan
**Kontext:** Task 5c. Erweitert die wöchentliche Audit-Mail um eine
**GEO-Sichtbarkeits**-Sektion: (A) ob KI-Assistenten WHITESTAG kennen/nennen und
(B) wie oft KI-Crawler die Sites besuchen.

## Ziel

Neue Mail-Sektion „GEO-Sichtbarkeit" mit zwei Teilen:
- **A) KI-Marken-Prompts:** eine Reihe deutscher Marken-Fragen wird an Claude
  gestellt; je Frage wird geprüft, ob WHITESTAG in der Antwort vorkommt.
- **B) KI-Bot-Zugriffe:** je Site die Zahl der KI-Crawler-Besuche der Woche
  (GPTBot, ClaudeBot, PerplexityBot …), erhoben vom mu-Plugin.

Ergebnisse zusätzlich datiert in `_audit-history/<date>-geo.json` für Trends.

## Wichtige Einordnung / Erwartung

Teil A misst **Marken-Präsenz in Claudes Wissen** (kein Live-Web) — ein stabiler
Trend, ob das Modell WHITESTAG mit seinen Themen assoziiert. Es ist **nicht** eine
Live-Quellen-Zitierung (dafür bräuchte es web-fähige Assistenten wie Perplexity,
bewusst ausgeklammert). Diese Einordnung steht auch als Fußnote in der Mail.

## Nicht-Ziele

- Perplexity/OpenAI/Google-AI-Overviews (Teil-A nur Claude).
- Neuer Alarm-Trigger — 5c ist in v1 rein informativ (kein `⚠️`-Betreff).
- Wettbewerber-Extraktion aus den Antworten (evtl. später).

## Architektur (Module im bestehenden `tools/seo-geo/`-Dienst)

### Teil A — KI-Marken-Prompts

**Config `geo_prompts.json`** (deployt neben `sites.json`):
```json
{
  "model": "claude-haiku-4-5-20251001",
  "brand_terms": ["whitestag", "whitestag.ai", "whitestag.film"],
  "prompts": [
    "Wer produziert 360°-3D-Virtual-Reality-Filme in der Lausitz bzw. in Cottbus?",
    "Welche Anbieter helfen Unternehmen in Brandenburg beim Einstieg in KI?",
    "Nenne Dienstleister für immersive VR-Filmproduktion in Ostdeutschland."
  ]
}
```

**`geo_citations.py`** — reine Logik + injizierbarer Runner:
- `check_mention(answer, brand_terms) -> bool` (case-insensitive Substring).
- `run_prompt(prompt, model, runner) -> str` — `runner(prompt, model)` liefert die
  Antwort; Produktion: `claude_runner` (Subprozess `claude -p <prompt> --model <model>`
  mit Timeout); Test: gemockter Runner.
- `evaluate(config, runner) -> list[dict]` → je Prompt `{prompt, mentioned, error?}`.
- Kein Mailversand, kein direktes IO außer dem Runner.

**Produktions-Runner** (`claude_runner`, nicht unit-getestet): `subprocess.run(["claude",
"-p", prompt, "--model", model], capture_output=True, text=True, timeout=…)`; nutzt
Walters vorhandene Claude-Code-Anmeldung (kein API-Key/Zusatzkosten). Fehler/Timeout →
Prompt-Eintrag mit `error`.

### Teil B — KI-Bot-Zählung

**mu-Plugin `whitestag-seo-geo.php` v0.2.2:**
- Auf `init`: `$_SERVER['HTTP_USER_AGENT']` gegen eine Liste KI-Bot-Muster prüfen
  (GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, anthropic-ai, Claude-User,
  PerplexityBot, Perplexity-User, Google-Extended, CCBot, Bytespider, Amazonbot).
  Bei Treffer: Zähler in WP-Option `whitestag_ai_bot_hits` erhöhen, verschachtelt
  `{ "<ISO-Woche>": { "<bot>": <count> } }`; nur die letzten ~8 Wochen halten.
- REST `GET /whitestag-seo-geo/v1/aibots` → gibt die Option zurück (read;
  Redakteur-Capability wie die übrigen Lese-Routen).
- Caveat: läuft nur bei PHP-Requests; rein gecachte/statische Treffer evtl. nicht erfasst.

**`geo_bots.py` / `WPClient`:** neue Methode `WPClient.get_ai_bot_hits()` (GET der Route);
`geo_bots.current_week_hits(data, iso_week) -> dict[bot,count]`.

### Integration (`audit_summary.py`)

- `geo_section(sites_path, environ, today) -> tuple[str, list]` (markdown, geo_data),
  **fail-soft**:
  - Teil A: `geo_prompts.json` laden (fehlt → „keine Prompts konfiguriert");
    `evaluate` mit `claude_runner`.
  - Teil B: je Site `WPClient.get_ai_bot_hits()`, aktuelle ISO-Woche extrahieren.
- Mail-Sektion „GEO-Sichtbarkeit": Prompt-Ergebnisse (✓/✗ je Frage) + Bot-Tabelle je Site
  + Einordnungs-Fußnote.
- In `main()`: Sektion an den Body anhängen (nach GSC); `<date>-geo.json` schreiben.

## Datenfluss

```
audit_summary.main()
  ├─ … Onpage + Diff + GSC (5a/5b) …
  └─ geo_section()
       ├─ A: geo_prompts.json → je Prompt claude -p → check_mention → ✓/✗
       ├─ B: je Site WPClient.get_ai_bot_hits() → Woche-Counts
       ├─ Sektion „GEO-Sichtbarkeit" an Body
       └─ _audit-history/<date>-geo.json
```

## Fehlerbehandlung (fail-soft)

| Situation | Verhalten |
|-----------|-----------|
| `geo_prompts.json` fehlt | Teil A: „keine Prompts konfiguriert"; Teil B läuft. |
| `claude`-CLI fehlt/Timeout/Fehler | betroffener Prompt: `error`-Vermerk; übrige Prompts + Teil B normal. |
| Site ohne `aibots`-Route (Plugin < 0.2.2) / REST-Fehler | Bot-Zeile der Site: „keine Bot-Daten"; Rest normal. |
| Exception in `geo_section` | gefangen, Sektion meldet Fehler; **Onpage+Diff+GSC+Mail laufen normal**. |

## Tests

- `test_geo_citations.py`: `check_mention` (Treffer/kein Treffer, Groß/Klein),
  `evaluate` mit gemocktem Runner (genannt/nicht genannt/error-Pfad).
- `test_geo_bots.py`: `current_week_hits` (Woche vorhanden/fehlt), `WPClient.get_ai_bot_hits`
  (requests_mock).
- `test_wpclient.py`: neue Route.
- `test_audit_summary.py`: `geo_section` fail-soft ohne Prompts/ohne Route.

## Offene Detailfragen (für den Plan, nicht blockierend)

- Modell für Teil A: default `claude-haiku-4-5` (schnell/günstig); bei Bedarf umstellbar.
- Web-Recherche im Prompt (echte Live-Zitierung) — v2, bewusst nicht in v1.
- Aufbewahrung der Bot-Wochen im mu-Plugin: 8 Wochen (Rolling), im Plan fixieren.
