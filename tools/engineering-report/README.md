# engineering-report

Täglicher **Engineering-Report** an Walter (ws@whitestag.ai): kompakter
Überblick, woran das Engineering-Team der WHITESTAG-Company in den letzten 24 h
gearbeitet hat — plus die nächtliche **WHITESTAG.ACADEMY**-Workshop-Kette.

## Architektur (bewusst hybrid)

1. **Fakten deterministisch** holen — Board-Token → Paperclip-API
   (`GET /api/companies/{WHI}/issues?assigneeAgentId=…`). Sieht **alle**
   Engineering-Agenten (VP Engineering, Produktentwicklung, n8n-Ingenieur, CTO)
   plus die ACADEMY-Workshop-Kette (CEO → Online-Rechercheur → Lektorat). Kein
   Selbstbericht, kein Halluzinieren, keine fehlenden Agenten.
2. **Formulierung durch lokales LLM** — `gemma-4-31b-it-mlx` (LM Studio :1234)
   gießt die Fakten in lesbares Deutsch. Das LLM formuliert **nur** die
   übergebenen Fakten (inkl. `Kontext:`-Zeilen), erfindet nichts.
3. **Versand** via Mailhub-Webhook (`POST /webhook/mailhub/send`,
   `X-Mailhub-Secret`), Absender `cto@whitestag.ai`.

Fällt das LLM aus, wird die deterministische Rohfassung gemailt — nie ein
leerer oder falscher Report.

## Aufruf

    python3 engineering_report.py             # 24h, sendet
    python3 engineering_report.py --dry-run    # nur ausgeben
    python3 engineering_report.py --no-llm     # LLM überspringen (Rohfassung)
    python3 engineering_report.py --window-hours 168   # Wochen-Report

## Tests

    python3 -m pytest tools/engineering-report -q

## Deploy (launchd)

Live-Kopie liegt unter `~/.paperclip/scripts/engineering-report/` (launchd kann
CloudStorage/SynologyDrive nicht lesen). Nach Änderungen dorthin kopieren:

    cp tools/engineering-report/{engineering_report.py,run.sh} ~/.paperclip/scripts/engineering-report/

launchd-Job `de.whitestag.engineering-report` (täglich 09:00 Europe/Berlin).
Log: `/tmp/engineering-report*.log`.

Später auf **wöchentlich** umstellen: launchd auf Montag setzen +
`--window-hours 168`.
