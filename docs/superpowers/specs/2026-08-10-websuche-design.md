---
title: Websuche-Dienst für lokale Agenten
datum: 2026-08-10
typ: Design
status: Entwurf
zusammenfassung: Lokaler Such- und Lesedienst (SearXNG + eigene Hülle), damit Paperclip-Agenten auf lmstudio_local recherchieren können, ohne Anthropic-Kontingent zu verbrauchen.
---

# Websuche-Dienst für lokale Agenten

## Ausgangslage

Die Auswertung von `cost_events` (Stand 10.08.2026) zeigt: der einzige
kostenpflichtige LLM-Anbieter im Haus ist Anthropic, erreicht über den
`claude_local`-Adapter. 1.187 von 1.193 Calls laufen als
`subscription_included`, also über das Abo statt über die API-Rechnung. Der
knappe Rohstoff ist damit nicht Geld, sondern Abo-Kontingent, das sich die
Agenten mit Walters eigenen Claude-Code-Sitzungen teilen.

Der mit Abstand größte Posten sind die beiden Recherche-Agenten:

| Agent | Company | Calls/30 T. | Output-Token/30 T. |
|---|---|---:|---:|
| Online-Rechercheur | WHITESTAG | 160 | 1.075.000 |
| Recherche | Clara Sound | 43 | 119.000 |

Zusammen rund 1,19 Mio. Output-Token im Monat. Beide sind nicht auf
`lmstudio_local` migrierbar, weil der lmstudio-Adapter den Agenten laut
Server-Log nur `fs_read` und `shell_exec` gibt — **kein Web-Such- und kein
Web-Abruf-Werkzeug**. Der Online-Rechercheur lief bis Mai 2026 tatsächlich auf
`lmstudio_local` (418 Calls) und wurde am 11.05.2026 bewusst auf `claude_local`
umgestellt.

Ohne Ersatzwerkzeug würde eine Rückmigration die Kernpflicht des Agenten
aushöhlen: „Mindestens zwei unabhängige Quellen pro wesentlicher Aussage" und
„Immer mit URL und Abrufdatum zitieren" (aus seiner `AGENTS.md`). Mit `curl` im
Blindflug ist das nicht einlösbar.

**Dieses Dokument beschreibt das Werkzeug, nicht die Migration.** Die Umstellung
der beiden Agenten ist der Anschlussschritt (siehe „Nicht in diesem Bau").

## Ziel

Ein lokaler Dienst, der auf eine Frage hin sucht, die gefundenen Seiten abruft,
deren Fließtext extrahiert und ein zitierfähiges Ergebnis zurückgibt — nutzbar
von Paperclip-Agenten (`shell_exec`), n8n-Workflows und den Sprachbots Jarvis
und Luna.

## Entscheidungen und Alternativen

### Suchquelle: SearXNG aus dem Quellcode

Erwogen wurden drei Wege:

- **A (gewählt): SearXNG als lokale Infrastruktur, eigene Hülle davor.**
  SearXNG fragt über ein Dutzend Engines parallel; fällt eine aus oder blockt
  sie, tragen die anderen. Genau diese Engine-Anbindung rottet am schnellsten,
  und Upstream pflegt sie — wir ziehen einen gepinnten Checkout nach. Kein
  API-Key, keine Suchanfrage verlässt das Haus, was zur PII-Proxy-Linie passt.
- **B: nur ein eigener Engine-Adapter (z. B. DuckDuckGo-HTML).** Kleiner und
  ganz im Hausstil, aber eine Engine ist ein einzelner Blockierpunkt. Bei den
  ~200 Recherche-Läufen im Monat sind Blockaden zu erwarten, und zwar
  unbeaufsichtigt zur Cron-Zeit.
- **C: eigenes Werkzeug mit externer Such-API und Key.** Ab Tag eins robust,
  aber die Suchanfragen verlassen das Haus (DPO-Vorlage nötig) und der
  Free-Tier begrenzt.

Der Preis von A ist die Pflege einer Fremd-Codebasis ohne Docker unter launchd.
Abgefedert wird das durch die Backend-Schnittstelle (siehe unten): B und C
bleiben ohne Änderung an Agenten, n8n oder Bots nachrüstbar.

### Kein Docker

Auf der Maschine gibt es weder Docker noch Colima noch Podman. SearXNG läuft
deshalb aus dem Quellcode unter Homebrew-Python 3.11 — derselben Basis, auf der
das venv von `tools/seo-geo/` bereits fährt (3.11.14). Damit bleibt es bei einer
Python-Linie statt zweien.

### HTTP-Dienst statt reinem CLI

Nutzerkreis sind alle lokalen Paperclip-Agenten, n8n-Workflows und die
Sprachbots. n8n und die Bots sprechen HTTP, also braucht es einen Dienst; die
Paperclip-Agenten bekommen ein dünnes CLI darüber, weil `shell_exec` ihr
einziger Weg nach außen ist. Beide Wege rufen dieselbe Funktion.

## Architektur

Drei Schichten:

```
Paperclip-Agenten ──shell_exec──> cli.py ──┐
n8n-Workflows ─────HTTP :7789────> server.py ──> websuche.recherchiere()
Jarvis / Luna ─────HTTP :7789────┘                    │
                                                      ├─> backends.SearxngBackend ──> SearXNG :8888
                                                      └─> abruf.hole_text()  ──> Web
```

**SearXNG** ist reine Infrastruktur. LaunchAgent `de.whitestag.searxng`,
gepinnter Checkout, eigenes venv auf brew-Python 3.11, gebunden an
`127.0.0.1:8888`. JSON-Ausgabe aktiviert, Limiter deaktiviert — bei reinem
Localhost-Zugriff wäre Bot-Schutz nur eine Fehlerquelle. Kein Agent und kein
Workflow spricht je direkt mit SearXNG.

**`tools/websuche/`** ist die einzige Schnittstelle, die irgendjemand kennt:

| Modul | Aufgabe |
|---|---|
| `backends.py` | Schnittstelle `suche(frage, limit) -> list[Treffer]`; Implementierung `SearxngBackend`. Die Tauschstelle für Variante B/C. |

`Treffer` ist ein `dataclass` mit `url`, `titel`, `snippet` — mehr braucht die
Orchestrierung nicht, und weniger würde die Deduplizierung nach Domain
unmöglich machen. Den Volltext holt erst `abruf.py`.

`websuche.recherchiere()` fragt das Backend bewusst **überzählig** ab:
`limit = max(10, quellen * 3)`. Die Deduplizierung nach Domain verwirft
Treffer, und ohne Reserve bleiben sonst regelmäßig weniger Quellen übrig als
angefordert. Abgerufen werden trotzdem nur so viele Seiten, bis `quellen`
verschiedene Domains beisammen sind.

| `abruf.py` | Seite holen, Fließtext extrahieren (`bs4`, wie `seo-geo/crawl.py`), `robots.txt` beachten |
| `websuche.py` | Orchestrierung: suchen → deduplizieren → parallel abrufen → Ergebnis bauen |
| `server.py` | stdlib-HTTP auf `127.0.0.1:7789`, `POST /suche`; Bauform von `tools/vault-lookup/server.py` |
| `cli.py` | dünne Hülle um `recherchiere()` für `shell_exec` |

Ports 7789 und 8888 sind frei (7788 belegt vault-lookup, 7777/7778 die
Brain-Instanzen).

## Schnittstelle

### CLI (Paperclip-Agenten)

```
python3 ~/.paperclip/scripts/websuche/cli.py "<frage>" [--quellen N] [--zeichen N]
                                                       [--gleiche-domain-erlauben] [--json]
```

Standard: `--quellen 3`, `--zeichen 12000`. Ausgabe ist kompaktes Markdown;
`--json` schaltet auf dieselbe Struktur wie der HTTP-Dienst um.

Markdown ist der Default, weil lokale Modelle Fließtext mit Überschriften
spürbar besser verwerten als verschachteltes JSON — Gemma neigt bei
JSON-Eingaben dazu, das Format zu imitieren statt den Inhalt zu nutzen.

### HTTP (n8n, Jarvis, Luna)

```
POST http://127.0.0.1:7789/suche
{"frage": "...", "quellen": 3, "zeichen": 12000, "gleiche_domain_erlauben": false}
```

Antwort:

```json
{
  "frage": "...",
  "abgerufen_am": "2026-08-10",
  "quellen": [
    {"url": "https://…", "titel": "…", "domain": "beispiel.de",
     "abgerufen_am": "2026-08-10", "text": "…"},
    {"url": "https://…", "titel": "…", "domain": "andere.org",
     "abgerufen_am": "2026-08-10", "fehler": "HTTP 403"}
  ],
  "hinweis": null
}
```

Pro Quelle immer `url`, `titel`, `domain`, `abgerufen_am` — dazu entweder `text`
oder `fehler`, nie beides. `hinweis` ist `null` oder ein Satz im Klartext.

## Unabhängigkeit der Quellen

Der Dienst dedupliziert standardmäßig nach registrierbarer Domain: „3 Quellen"
heißt drei verschiedene Domains, nicht drei Unterseiten derselben Website.
`--gleiche-domain-erlauben` bzw. `gleiche_domain_erlauben: true` hebt das auf,
wenn jemand bewusst mehrere Seiten einer Behörde will.

Das ist bewusst im Dienst durchgesetzt und nicht dem Modell überlassen: ein
lokales Modell, das `bmwk.de/a`, `bmwk.de/b` und `bmwk.de/c` findet, meldet
sonst zuverlässig „durch mehrere unabhängige Quellen bestätigt".

**Nicht eingebaut:** SearXNG meldet mit, welche Engines einen Treffer gefunden
haben. Das ist kein Unabhängigkeitssignal — drei Engines, die dieselbe URL
finden, sind eine Quelle. Das Feld würde nur eine Scheinsicherheit erzeugen, die
anschließend in einem Dossier landet.

## Kontext-Budget

Zielmodelle sind `qwen3.6-35b-a3b-mlx` (98.304 Token Fenster, real p99 ≈ 90k
laut Kontext-Statistik vom 10.08.2026) und `gemma-4-31b-it-mlx` (262.144).
Ungekappte Seiten sprengen das erste Fenster.

Deshalb harte Kappung bei 12.000 Zeichen pro Quelle — grob 3.000 Token, bei drei
Quellen also rund 9k Token für das Rechercheergebnis. Das lässt dem Agenten Luft
für seine eigene Arbeit. Wird gekappt, endet der Text wörtlich mit
`… [gekappt bei 12000 Zeichen]` (mit dem tatsächlichen Wert), damit das Modell
nicht glaubt, die Seite sei zu Ende.

## Fehlerverhalten

**Der wichtigste Fehlerfall ist der stille.** Ist SearXNG nicht erreichbar oder
antwortet fehlerhaft, gibt der Dienst **niemals** eine leere Trefferliste
zurück: das liest sich für ein Modell als „nichts gefunden", und der Agent
schreibt dann „zu dieser Frage ließen sich keine Quellen finden" ins Dossier,
statt zu eskalieren. Stattdessen expliziter Fehler — Exit-Code ungleich null im
CLI, HTTP 503 im Dienst. Dasselbe Muster hat den Vault-Tagger 51 Tage lang
unbemerkt tot gehalten.

Einzelne Seiten dürfen dagegen ausfallen. Eine Quelle mit 403 oder Timeout
bleibt im Ergebnis, aber mit `fehler`-Feld statt `text`; die übrigen kommen
durch — dasselbe Per-Element-`try/except`, das `health-ingest V10` gerettet hat.

Bleiben nach Deduplizierung und Abruf weniger als zwei Quellen **mit Text**
übrig, trägt das Ergebnis einen `hinweis` im Klartext, damit niemand
stillschweigend auf einer einzigen Quelle aufbaut.

### Zeitbudget

`shell_exec` bricht hart bei 120 Sekunden ab. Der CLI-Weg muss deutlich darunter
landen, sonst sieht der Agent einen Abbruch statt eines Ergebnisses. Deshalb:

- 15 Sekunden pro Seitenabruf
- 60 Sekunden Gesamt-Deadline
- Seitenabruf parallel, nicht sequenziell

Was nicht rechtzeitig da ist, wird zur Fehlerquelle markiert, statt den ganzen
Lauf zu kippen.

### Abrufverhalten

`robots.txt` wird beim Abruf beachtet. Der User-Agent nennt WHITESTAG und eine
Kontaktadresse. Zwischen zwei Abrufen derselben Domain liegt eine kurze Pause.

## Tests

Hausstil: `test_<modul>.py` neben jedem Modul, `unittest`, Netzwerk gemockt wie
in `tools/seo-geo/test_crawl.py`. Die Fälle, die zählen:

1. Domain-Deduplizierung — drei Treffer auf einer Domain ergeben eine Quelle
2. `--gleiche-domain-erlauben` hebt die Deduplizierung auf
3. Zeichenkappung greift und setzt die Kappungsmarke
4. SearXNG nicht erreichbar → Fehler, **nicht** leere Trefferliste
5. Einzelne Seite mit 403 → Quelle mit `fehler`, übrige Quellen kommen durch
6. Weniger als zwei Quellen mit Text → `hinweis` gesetzt
7. `robots.txt` verbietet Abruf → Quelle mit `fehler`, kein Abruf

Ein Rauchtest gegen die echte lokale SearXNG-Instanz kommt als eigenes Skript
daneben (`rauchtest.sh`), nicht in die Suite — die Suite muss ohne Netz laufen.

## Auslieferung

Quelle liegt in `tools/websuche/`. Ein `deploy.sh` spiegelt nach
`~/.paperclip/scripts/websuche/`; der Live-Pfad ist kein Repo, und die Trennung
folgt dem Muster der übrigen Werkzeuge.

- Eigenes venv auf brew-Python 3.11 (`bs4` fehlt im System-Python 3.9)
- LaunchAgent `de.whitestag.searxng` — SearXNG auf `127.0.0.1:8888`
- LaunchAgent `de.whitestag.websuche` — Dienst auf `127.0.0.1:7789`
- `DEPLOY.md` beschreibt beide Schritte, nach dem Vorbild von
  `tools/seo-geo/DEPLOY.md`

Beide Plists werden über `/bin/zsh -lc` gestartet, damit die Umgebung stimmt —
dasselbe Muster wie bei `seo-geo`. Ausführbar-Bits sind unerheblich, weil
SynologyDrive Dateimodi beim Sync kippt; die Skripte werden explizit über
`zsh …` bzw. den venv-Interpreter aufgerufen.

## Nicht in diesem Bau

- **Migration der Recherche-Agenten.** Online-Rechercheur und Clara-Recherche
  bleiben vorerst auf `claude_local`. Erst wenn das Werkzeug unter echter Last
  gelaufen ist, werden sie umgestellt.
- **Aufrufanleitung in `_common.md`** des Instruktions-Generators. Gehört zur
  Migration, nicht zum Werkzeug.
- **Vorverdichtung durch ein kleines Modell.** Wurde erwogen und verworfen: sie
  schiebt eine Fehlerquelle zwischen Quelle und Zitat, der Agent zitiert dann
  etwas, das er nie gelesen hat.
- **Backends B und C.** Die Schnittstelle hält sie offen; gebaut wird nur
  `SearxngBackend`.

## Erfolgskriterien

1. Alle sieben Testfälle grün, Suite ohne Netzzugang lauffähig.
2. Rauchtest liefert für eine Fachfrage drei Quellen auf drei verschiedenen
   Domains, jede mit Text und Abrufdatum, in unter 60 Sekunden.
3. Ein Aufruf über `shell_exec` aus einem lokalen Paperclip-Agenten heraus
   liefert ein verwertbares Ergebnis innerhalb der 120-Sekunden-Grenze.
4. SearXNG gestoppt → CLI beendet sich mit Exit-Code ungleich null und einer
   Fehlermeldung im Klartext, nicht mit einer leeren Trefferliste.
