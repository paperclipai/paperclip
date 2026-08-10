# Websuche — Betriebs- und Installationsanleitung

Der lokale Websuche-Dienst besteht aus zwei Prozessen:

- **SearXNG** (Metasuchmaschine, aus dem Quellcode gebaut) auf `127.0.0.1:8888`
- **websuche** (unser HTTP-Dienst aus `tools/websuche/`) auf `127.0.0.1:7789`

Beide laufen als LaunchAgents (`de.whitestag.searxng`, `de.whitestag.websuche`).

## 1. SearXNG installieren

```bash
mkdir -p ~/.paperclip/dienste
cd ~/.paperclip/dienste
git clone https://github.com/searxng/searxng.git searxng
cd searxng
git rev-parse HEAD          # Commit notieren
```

**Gepinnter Commit:** `0a118066d8565c0cf80fbc5ea90f20c875bbcfe6`
(geklont am 10.08.2026; via `git checkout <hash>` fixiert, damit ein
späteres `git pull` eine bewusste Entscheidung bleibt).

```bash
/opt/homebrew/bin/python3.11 -m venv venv
./venv/bin/pip install -q -U pip setuptools wheel
./venv/bin/pip install -q -r requirements.txt
./venv/bin/pip install -q -e . --no-build-isolation
```

**Abweichung vom ursprünglichen Rezept:** `pip install -e .` allein
schlägt fehl (`ModuleNotFoundError: No module named 'msgspec'`), weil
`searx/__init__.py` beim Editable-Build bereits `msgspec` importiert,
das aber erst über `requirements.txt` installiert wird und wegen
Build-Isolation im isolierten Build-Environment nicht sichtbar ist.
Fix: zuerst `pip install -r requirements.txt`, danach `pip install -e .
--no-build-isolation`.

## 2. SearXNG konfigurieren

`~/.paperclip/dienste/searxng/settings-whitestag.yml`:

```yaml
use_default_settings: true
general:
  instance_name: "WHITESTAG Websuche"
search:
  formats:
    - html
    - json
server:
  bind_address: "127.0.0.1"
  port: 8888
  secret_key: "<per secrets.token_hex(32) erzeugter Wert>"
  limiter: false
  public_instance: false
```

`json` in `search.formats` schaltet die JSON-API frei, die
`backends.SearxngBackend` braucht — ohne sie liefert SearXNG nur HTML.
`limiter: false`, weil Bot-Schutz bei reinem Localhost-Zugriff nur eine
Fehlerquelle wäre. Der `secret_key` ist kein Zugangsgeheimnis (Instanz
nur auf Loopback erreichbar), aber SearXNG verweigert den Start mit dem
Platzhalter — echten Wert per
`python3 -c "import secrets; print(secrets.token_hex(32))"` erzeugen.

## 3. SearXNG von Hand prüfen

```bash
cd ~/.paperclip/dienste/searxng
SEARXNG_SETTINGS_PATH=$PWD/settings-whitestag.yml ./venv/bin/python -m searx.webapp &
sleep 5
curl -s "http://127.0.0.1:8888/search?q=test&format=json" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['results']),'Treffer')"
kill %1
```

Erwartet: eine Zahl größer null. Liefert `format=json` einen Fehler,
fehlt `json` in `search.formats`.

## Ausliefern und Laden

```bash
cd tools/websuche && zsh deploy.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/de.whitestag.searxng.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/de.whitestag.websuche.plist
sleep 8
launchctl print gui/$UID/de.whitestag.searxng | grep -E "state|last exit"
launchctl print gui/$UID/de.whitestag.websuche | grep -E "state|last exit"
```

Erwartet: beide `state = running`.

`deploy.sh` spiegelt `tools/websuche/` nach
`~/.paperclip/scripts/websuche/`, baut dort bei Bedarf ein eigenes venv
(keine kopierten venvs — die tragen absolute Pfade aus dem
Quellverzeichnis) und kopiert die beiden Plists nach
`~/Library/LaunchAgents/`.

## Rauchtest

```bash
cd tools/websuche && zsh rauchtest.sh
```

Prüft der Reihe nach: SearXNG erreichbar, Dienst erreichbar, CLI mit
drei Quellen inklusive Laufzeitmessung gegen die 25-Sekunden-Deadline,
und dass ein totes SearXNG-Backend das CLI mit Exit-Code ungleich null
statt einer leeren Trefferliste abbrechen lässt.

## Betrieb

**Logs:**
- `~/.paperclip/logs/searxng.log`
- `~/.paperclip/logs/websuche.log`

**Neustart des Dienstes** (z.B. nach Codeänderung + `deploy.sh`):

```bash
launchctl kickstart -k gui/$UID/de.whitestag.websuche
```

**SearXNG aktualisieren** (bewusst manuell, weil ein Upstream-Wechsel
Engines brechen kann):

```bash
cd ~/.paperclip/dienste/searxng
git fetch && git checkout <neuer Commit>
./venv/bin/pip install -q -e . --no-build-isolation
launchctl kickstart -k gui/$UID/de.whitestag.searxng
```

Danach den Rauchtest laufen lassen (`zsh rauchtest.sh`), bevor der
Dienst als aktualisiert gilt.

**SearXNG für einen Test sauber anhalten:** `launchctl kill SIGTERM
gui/$UID/de.whitestag.searxng` reicht nicht — beide Plists setzen
`KeepAlive = true`, launchd startet den Dienst binnen 2-3 Sekunden von
selbst neu, ein reines Signal simuliert also keinen echten Ausfall. Wer
das Backend wirklich stilllegen will (z.B. um zu prüfen, dass Aufrufer
korrekt auf einen toten Dienst reagieren), muss die Registrierung
aufheben:

```bash
launchctl bootout gui/$UID/de.whitestag.searxng
# ... Port 8888 ist jetzt tatsaechlich tot, KeepAlive greift nicht ...
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/de.whitestag.searxng.plist
```

`rauchtest.sh` macht das in Abschnitt 4 automatisch (inklusive Warteschleife
auf den tatsächlichen Port-Tod, Wiederherstellung per `bootstrap` und einem
`trap ... EXIT`, das den Dienst auch bei einem vorzeitigen Abbruch des
Skripts zurückholt) — als Vorlage für eigene Tests gegen den toten Dienst.

**Wichtig:** `~/.paperclip/scripts/websuche/` ist ein reiner Spiegel,
kein Repo. Änderungen dort direkt gehen beim nächsten `deploy.sh`
verloren (der Sync läuft mit `--delete`). Die Quelle ist immer
`tools/websuche/` in diesem Repo.
