# Jarvis: Zeitbewusstsein und Websuche — Design

**Datum:** 2026-07-29
**Status:** freigegeben, Implementierung ausstehend
**Betrifft:** `tools/voice-echo-bot/` (geteiltes Gehirn), `tools/wake-satellite/`

## Ausgangslage

Jarvis konnte die Frage „wie spät ist es?" nicht beantworten und hat stattdessen
Uhrzeiten erfunden. Im Betriebslog des Satelliten steht der Beleg:

```
[timing] runde=2/3 … | text='Ich wundere mich, dass du mir immer falsche Uhrzei…'
[timing] runde=1/3 … llm(lookup)=0.6s | text='Hey Jarvis, finde die korrekte Uhrzeit für Cottbus'
```

Zwei getrennte Ursachen:

1. **Uhrzeit.** Der System-Prompt in `jarvis_brain.py` enthält kein Datum. Ein
   Sprachmodell hat kein Zeitgefühl und halluziniert dann. Das ist *kein*
   Internet-Problem — die Systemuhr genügt. Er versuchte sogar einen
   Vault-Lookup für die Uhrzeit (`llm(lookup)` oben), was zwangsläufig ins
   Leere lief.
2. **Kein Weltwissen.** Wetter, Nachrichten, Verkehr kann er nicht wissen und
   rät ebenfalls, statt es zu sagen.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Umfang | Zeit/Datum **und** Websuche |
| Auslösung | Das Modell entscheidet selbst, wann es sucht (wie bei `LOOKUP`) |
| Anbieter | Tavily — Konto existiert bereits (n8n „News Agent V18") |
| Absicherung | Harte Turn-Sperre nach Vault-Zugriff **plus** Protokollierung |
| Architektur | Drittes Steuer-Token `WEB:`, Tavily direkt aus Python |

### Verworfene Alternativen

- **Suche über einen n8n-Webhook.** Der Key bliebe in n8n, aber der
  Sprachdialog hinge an einem zweiten Dienst, bekäme einen Netzwerk-Hüpfer
  mehr Latenz und ließe sich schlechter testen.
- **Suche als Nachbesserung** (erst antworten, dann prüfen, ob Echtzeitwissen
  gefehlt hat). Kostet immer zwei LLM-Durchgänge und erkennt den Bedarf
  unzuverlässiger als die direkte Entscheidung.
- **PII-Proxy für Suchanfragen.** Greift nicht und kann prinzipiell nicht
  greifen — siehe unten.

## Warum der PII-Proxy hier nicht hilft

Zwei unabhängige Gründe:

1. **Er ist nicht im Pfad.** `llm.py:19` ruft `http://127.0.0.1:1234/v1/chat/completions`
   direkt auf — LM Studio, lokal. Der Proxy ist ein Gate für Aufrufe an
   *Cloud*-LLMs; Jarvis' Modell läuft im Haus.
2. **Er ist ein LLM-Gate, kein Ausgangsfilter.** Routen: `/anonymize`,
   `/deanonymize`, `/safe-call`, `/health`. Ein Tavily-Aufruf ist kein
   LLM-Call und liefe daran vorbei.

Grundsätzlicher: Pseudonymisierung passt zu LLM-Prompts, weil das Modell mit
`PERSON_1` weiterarbeiten kann und die Antwort zurückübersetzt wird. Bei einer
**Suchanfrage** ist der echte Begriff genau das, wonach gesucht wird —
`PERSON_1` findet nichts. Die Websuche braucht deshalb eine eigene Absicherung.

## Komponenten

### 1. Zeit im System-Prompt

`respond()` ergänzt den System-Prompt bei **jedem Aufruf** um die aktuelle Zeit
(Wochentag, Datum, Uhrzeit, Europe/Berlin). Bewusst pro Aufruf statt als
Modulkonstante: der Satellit ist ein Dauerprozess, eine beim Start eingefrorene
Uhr wäre nur eine langsamere Form derselben Falschauskunft. Die Zeitquelle ist
injizierbar, damit Tests deterministisch bleiben.

### 2. `web_search.py` (neu, in `tools/voice-echo-bot/`)

Tavily-Client nach dem Muster von `llm.py` / `vault_client.py`:

- stdlib `urllib`, keine neue Laufzeit-Abhängigkeit
- `search(query, api_key, max_results=3, timeout=15) -> dict`
- `include_answer` aktiviert — Tavily liefert eine verdichtete Antwort plus
  Quellen, statt einer Trefferliste, die niemand vorlesen will
- eigene `WebSearchError` bei jedem Transport-/Formatproblem, analog
  `LlmError` / `VaultError`
- HTTP-Opener injizierbar → Tests ohne Netz

### 3. Steuer-Token `WEB:` in `jarvis_brain.py`

- `WEB_RE` analog zu `LOOKUP_RE` / `ISSUE_RE`
- `parse_control` liefert `{"kind": "web", "query": …}`
- `_do_web(messages, query, chat_model)`: suchen → Ergebnis als gekürztes JSON
  in einen Folge-Prompt → zweiter `llm.chat` formuliert die knappe Antwort
- Fehlerfall (kein Netz, Tavily down): ehrliche Meldung statt Raten
- Kein Treffer: ebenfalls ehrlich
- `respond()` gibt `{"kind": "web", "answer": …}` zurück
- `satellite.py:83`: `"web"` kommt zur Liste der Antwortarten, die ins
  Gedächtnis wandern

### 4. Absicherung

**Harte Regel (Code, nicht Prompt):** Die Websuche wird nur im ersten Schritt
einer Anfrage ausgeführt. Hat in diesem Turn bereits ein Vault-Lookup
stattgefunden, wird ein `WEB:`-Token nicht mehr ausgeführt. Damit können in
derselben Anfrage gewonnene Vault-Daten nicht in einen Suchbegriff wandern.

Verhalten im Sperrfall: Das Token wird per `_strip_control_lines` aus der
Antwort entfernt und der übrige Text normal ausgegeben — dasselbe Verhalten,
das heute schon für nachgereichte `LOOKUP`-Token nach einem Vault-Zugriff gilt.
Es gibt keine Fehlermeldung an den Nutzer; die Sperre ist unsichtbar.

**Protokoll:** Jeder Suchbegriff geht vor dem Absenden als `[web] query='…'`
ins Log (Satellit: `~/.paperclip/logs/wake-satellite.log`).

**Bekannte Restlücke — bewusst offen gelassen.** Beim Telegram-Bot steht die
Historie von 8 Turns pro Chat dauerhaft im Kontext (`bot.py:37`,
`MAX_HISTORY_MESSAGES = 16`). Fragt man erst nach einer Adresse aus dem Vault
und danach nach dem Wetter „dort", kann das Modell den Ort in den Suchbegriff
übernehmen. Das ist der Sinn von Gesprächskontext, kein Fehler. Vollständig
ausschließen ließe es sich nur, indem Vault-Antworten gar nicht ins Gedächtnis
kommen — was Nachfragen wie „und seine Telefonnummer?" zerstört. Am Mikrofon
ist die Lücke klein: dort verfällt die Historie nach jeder Wake-Kette
(`satellite.py`, `handle_interaction` startet ohne History, max. 3 Runden).

### 5. Key-Beschaffung

Der Tavily-Key liegt AES-verschlüsselt in der n8n-Credential `Tavily`
(id `umKYjuwVI8fk1DBN`), entschlüsselbar mit dem n8n-Encryption-Key. Er wird
als `TAVILY_API_KEY` nach `~/.paperclip/voice-echo-bot.env` übertragen
(Rechte 600). **Erfordert ausdrückliche Freigabe vor dem Zugriff** — alternativ
trägt Walter ihn selbst aus der n8n-Oberfläche ein.

Fehlt der Key, wird das Werkzeug **gar nicht erst im System-Prompt angeboten**:
`respond()` hängt den `WEB:`-Abschnitt nur an, wenn ein Key vorliegt. Damit
kann das Modell kein Token setzen, das ohnehin scheitern würde. Sollte trotzdem
eines durchkommen, greift derselbe Pfad wie bei einem Tavily-Ausfall (ehrliche
Meldung, kein Crash).

## Tests

Alle ohne echte Netzaufrufe:

| Bereich | Fälle |
|---|---|
| `web_search` | Erfolg, HTTP-Fehler, kaputtes JSON, Timeout |
| `parse_control` | `WEB:` erkannt, Groß-/Kleinschreibung, Leerzeichen-Varianten |
| `_do_web` | ehrliche Meldung ohne Netz, ehrliche Meldung ohne Treffer |
| Absicherung | nach Vault-Lookup wird `WEB:` nicht ausgeführt; Suchbegriff wird protokolliert |
| Zeit | Prompt enthält die aktuelle Zeit; zwei Aufrufe zu verschiedenen Zeiten ergeben verschiedene Prompts |
| Satellit | `kind: "web"` landet im Gedächtnis |
| Kein Key | Websuche schaltet ab, ohne zu crashen |

## Betroffene Dateien

| Datei | Änderung |
|---|---|
| `tools/voice-echo-bot/web_search.py` | neu |
| `tools/voice-echo-bot/jarvis_brain.py` | Zeit im Prompt, `WEB:`-Token, `_do_web`, Sperre, Protokoll |
| `tools/voice-echo-bot/test_jarvis_brain.py` | Tests |
| `tools/voice-echo-bot/test_web_search.py` | neu |
| `tools/wake-satellite/satellite.py` | `"web"` in die Gedächtnis-Arten |
| `tools/wake-satellite/test_satellite.py` | Test dazu |
| `tools/wake-satellite/deploy.sh` | `web_search.py` in die Kopierliste |
| `~/.paperclip/voice-echo-bot.env` | `TAVILY_API_KEY` (nicht im Repo) |

## Deploy-Fallen

1. **`deploy.sh`** kopiert eine feste Dateiliste. Ohne Ergänzung um
   `web_search.py` fehlt das Modul live und der Satellit stirbt beim Import.
2. **Telegram-Bot mit eigenem Live-Pfad.** `~/.paperclip/scripts/voice-echo-bot/`
   ist ein separates Deployment, bei dem Repo und Live-Stand schon einmal
   auseinandergelaufen sind. Vor dem Ausrollen `diff` gegen das Repo, sonst
   überschreibt der Deploy dort ungesicherte Änderungen.
3. **Beide Jarvis-Varianten teilen `jarvis_brain.py`.** Jede Änderung wirkt auf
   Sprach-Satellit *und* Telegram-Bot; beide müssen deployed und neu gestartet
   werden.

## Nicht Teil dieses Designs

- Wetterdienst als eigene Quelle (Tavily deckt Wetterfragen mit ab)
- Quellenangabe in der Sprachausgabe (Links vorzulesen ist nutzlos; im
  Telegram-Kanal später denkbar)
- Der beobachtete `SwitchAudioSource -s AirPlay`-Fehlschlag (eigenes Thema)
