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

- Relay: V17 deaktivieren, V16 aktivieren (`/api/v1/workflows/<id>/activate`).
  Erst deaktivieren, dann aktivieren — sonst laeuft die alte activeVersionId weiter.
- Luna: `~/Obsidian/WHITESTAG-Vault/Paperclip/Luna/signaturen/abgeloest-20260804/`
  zurueckschieben und `luna_mail_render.py` aus git zuruecksetzen.

## Quelle und Live-Stand

Quelle ist `tools/signatur/` im Paperclip-Repo. Der Live-Pfad
`~/.paperclip/scripts/signatur/` entsteht nur durch `deploy.sh` — dort nie von
Hand editieren. Die `bereich-*.html` sind abgeleitet und gitignored; `deploy.sh`
erzeugt sie am Zielort neu.

## `patch_relay.py`: V17 aus V16 klonen

`patch_relay.py` legt den SMTP-Relay-Workflow als neue, zunaechst inaktive
Version an (`--dry-run` zum Pruefen, `--apply` zum Schreiben) und haengt dabei
`relay_signatur.js` als Code-Node "Attach Signature" zwischen
`Validation Error?` und `Build Binary Attachments` ein. Zusaetzlich patcht es
den bestehenden `Validate Request`-Node: der baute sein Ausgabeobjekt bisher
als Allowlist ohne `body.signatur` — ohne diesen Patch kommt Lunas
`signatur:"none"` (siehe `approval_send.py`) nie bei `signiere()` an, und
Lunas bereits client-seitig signierte Mails bekaemen vom Relay eine zweite
Signatur.

**Gotchas beim direkten SQLite-Schreiben in n8n 2.29** (alle 2026-08-10 beim
Testen gefunden, nicht in einer aelteren Fassung dieses Skripts):

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
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/SMTPRelayV17Signat/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
curl -sS -X POST "http://127.0.0.1:5678/api/v1/workflows/BXHc5kdNdZQNiuMr/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

Erst deaktivieren, dann aktivieren — sonst laeuft die alte `activeVersionId`
weiter. Die Reihenfolge ist in beide Richtungen identisch (V17→V16 wie
V16→V17): immer erst den aktiven Workflow deaktivieren, dann den Zielworkflow
aktivieren.
