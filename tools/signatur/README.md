# Mail-Signaturen

Bausteine: `bereich-<key>.html`, erzeugt von `signatur_build.py` aus
`bereiche.json` + `vorlage.html` + `logos/`.
Bereiche: ai, film, tv, academy, app, de. sorbART wurde am 04.08.2026
stillgelegt.

## Etwas ändern

1. `bereiche.json` bzw. `logos/` anpassen (neues Logo: `logos_bauen.py`)
2. `python3 signatur_build.py`
3. Fertig — Relay und Luna lesen die Dateien zur Laufzeit.

Wird `relay_signatur.js` geändert, muss `signatur.py` mitgeändert werden und
umgekehrt. `test_relay_signatur.mjs` prüft nur die JS-Seite für sich; der
automatisierte Abgleich BEIDER Implementierungen (byte-genauer Vergleich des
erzeugten Signatur-HTML über `equiv_probe.mjs`) steht in
`test_cross_impl_signatur.py` — der lässt sich überspringen (laut, nicht
still), wenn `node` fehlt, sonst nie ohne diesen Test committen.

## Rollback

- Relay: aktive Version deaktivieren, Vorgaengerversion aktivieren
  (`/api/v1/workflows/<id>/activate`). Erst deaktivieren, dann aktivieren —
  sonst laeuft die alte activeVersionId weiter. Aktuell (V18): V18
  deaktivieren, `SMTPRelayV17Signat` aktivieren.
- Luna: `~/Obsidian/WHITESTAG-Vault/Paperclip/Luna/signaturen/abgeloest-20260804/`
  zurueckschieben und `luna_mail_render.py` aus git zuruecksetzen.

## Quelle und Live-Stand

Quelle ist `tools/signatur/` im Paperclip-Repo. Der Live-Pfad
`~/.paperclip/scripts/signatur/` entsteht nur durch `deploy.sh` — dort nie von
Hand editieren. Die `bereich-*.html` sind abgeleitet und gitignored; `deploy.sh`
erzeugt sie am Zielort neu.

## `patch_relay.py`: naechste Relay-Version aus der aktiven Version bauen

`patch_relay.py` klont den SMTP-Relay-Workflow als neue, zunaechst inaktive
Version (`--dry-run` zum Pruefen, `--apply` zum Schreiben) und wendet dabei
den jeweils aktuell ausstehenden Patch an. Quelle, Ziel-ID und Ziel-Name sind
CLI-Parameter mit sinnvollen Standardwerten fuer den naechsten Schritt — das
Skript ist kein Einmal-Werkzeug fuer eine bestimmte Versionsspanne mehr:

```bash
python3 patch_relay.py --dry-run   # Standard: SMTPRelayV17Signat -> V18
python3 patch_relay.py --apply

# fuer eine andere Quelle/Ziel-Kombination, z.B. den naechsten Schritt V18->V19:
python3 patch_relay.py --apply \
  --source-id SMTPRelayV18LogGuard --new-id SMTPRelayV19xxx \
  --new-name "SMTP Relay V19 — xxx"
```

**Historie der Patches** (jeweils gefunden beim Testen, nicht immer in der
urspruenglichen Spec — dieselbe Reihe wie unten):

- **V16→V17**: haengt `relay_signatur.js` als Code-Node "Attach Signature"
  zwischen `Validation Error?` und `Build Binary Attachments` ein und patcht
  `Validate Request` (baute sein Ausgabeobjekt als Allowlist ohne
  `body.signatur` — ohne den Patch kommt Lunas `signatur:"none"`, siehe
  `approval_send.py`, nie bei `signiere()` an, und Lunas bereits
  client-seitig signierte Mails bekaemen vom Relay eine zweite Signatur).
  Steht als `fuege_signatur_knoten_ein()` weiterhin im Code (Dokumentation +
  Tests), wird vom aktuellen Standardlauf aber nicht mehr aufgerufen — gegen
  V17 als Quelle wuerde das sofort mit `AssertionError` abbrechen, weil die
  Anker nicht mehr im Ausgangszustand sind.
- **V17→V18** (aktuell): drei Patches auf denselben geklonten Nodes.
  1. `Validate Request` reicht jetzt auch `body.bereich` durch (vorher wie
     `signatur` oben: verworfen, weil nicht in der Allowlist). Ohne diesen
     Patch faellt `bereich` in `relay_signatur.js` immer auf
     `VORGABE_BEREICH="ai"` zurueck, egal was der Aufrufer schickt — heute
     folgenlos, weil kein Aufrufer im Repo `bereich` setzt, aber es haette
     die im Abnahmeprotokoll geforderte, auf den bereich `de` begrenzte
     Fehlerprobe verhindert (ohne Durchreichung waere die einzige ueber den
     Webhook erreichbare Datei `bereich-ai.html` — die meistgenutzte, nicht
     die am wenigsten genutzte).
  2. `Build Log Line` liest `__signaturFehler` jetzt vom
     `Attach Signature`-Node statt von `Validate Request` (dessen Zustand
     VOR dem Signatur-Node liegt und das Feld darum nie sehen konnte) und
     haengt im Fehlerfall ein `⚠️ SIGNATUR FEHLGESCHLAGEN: …`-Segment an
     dieselbe Logzeile an. Ohne Fehler bleibt die Zeile byte-identisch zum
     Vorzustand.
  3. `Attach Signature` bekommt `onError: "continueRegularOutput"`. Der
     n8n-Aufrufrahmen um `signiere()` (RAHMEN-Konstante: `require('fs')` +
     der `.map()`-Aufruf) liegt ausserhalb von dessen `try`/`catch` und
     hatte kein `onError` gesetzt — schlaegt der Rahmen selbst fehl (nicht
     `signiere()`, das faengt schon alles ab), riss das bisher den ganzen
     Workflow und damit den einzigen Mailweg ab.

**Gotchas beim direkten SQLite-Schreiben in n8n 2.29** (2026-08-10 beim
V16→V17-Testlauf gefunden):

- `workflow_entity.versionId` ist `NOT NULL` — ein reines `INSERT ... SELECT`
  ohne explizite `versionId` schlaegt fehl.
- Jeder Workflow in dieser Instanz hat eine passende `workflow_history`-Zeile
  (`workflow_history.versionId == workflow_entity.versionId`), auch inaktive
  Workflows ohne `activeVersionId`. Fehlt sie, bleibt der Workflow ein reiner,
  unveroeffentlichter Entwurf.
- Ohne eine Zeile in `shared_workflow` (`workflowId`, `projectId`,
  `role='workflow:owner'`) gehoert der neue Workflow keinem Projekt: er
  taucht in `GET /api/v1/workflows` (Liste) auf, aber `GET .../<id>`
  (Einzelabruf) liefert 404 — und vermutlich auch `activate`/`deactivate`.

`patch_relay.py` legt alle drei Zeilen jetzt selbst an. Nach jedem
`--apply` ist ein Neustart von n8n noetig (`launchctl kickstart -k
gui/$(id -u)/com.whitestag.n8n` — **nicht** `~/Desktop/n8n.sh`, das startet
zusaetzlich mehrere unabhaengige Dienste und oeffnet Browser-Tabs), damit die
direkt in die SQLite geschriebene Version sichtbar wird.

## Rollback (praezisiert)

```bash
source ~/.whitestag.env
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/SMTPRelayV18LogGuard/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/SMTPRelayV17Signat/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Erst deaktivieren, dann aktivieren — sonst laeuft die alte `activeVersionId`
weiter. Die Reihenfolge ist in beide Richtungen identisch: immer erst den
aktiven Workflow deaktivieren, dann den Zielworkflow aktivieren.
