---
title: Telegram-Jarvis — Fork zusammenführen
datum: 2026-08-17
typ: Design
status: Entwurf
zusammenfassung: Live-bot.py und Repo-bot.py sind zwei Wege auseinandergelaufen. Dieser Entwurf beschreibt die Zusammenführung als Voraussetzung dafür, dass der Telegram-Jarvis die Websuche bekommt.
---

# Telegram-Jarvis — Fork zusammenführen

## Ausgangslage

Der Sprach-Satellit recherchiert seit 17.08. über den lokalen Websuche-Dienst.
Der **Telegram-Jarvis hat gar keine Websuche** — er kennt weder `jarvis_brain`
noch `web_search` noch `web_key`. Nachrüsten scheitert nicht am Werkzeug,
sondern daran, dass `~/.paperclip/scripts/voice-echo-bot/` und
`tools/voice-echo-bot/` **zwei verschiedene Programme** sind.

Die verbreitete Annahme „live hinkt hinterher" ist falsch. Gemessen am
17.08.2026:

| | Repo | Live |
|---|---:|---:|
| `bot.py` | 272 Zeilen | 504 Zeilen |
| Tests | 174 (voice-echo-bot) | 135 (grün) |

**Beide Seiten sind getestet und grün.** Die Live-Tests
(`test_academy_bridge.py`, `test_seo_gate.py`, das dortige `test_bot.py`)
wurden nie ins Repo zurückgeholt — sie existieren nur unter `~/.paperclip`.

## Die Divergenz im Einzelnen

**Nur live vorhanden** (Produktivfunktionen, im Repo fehlend):

- `academy_bridge.py` + `test_academy_bridge.py` — academy-auto-Freigaben
- `seo_gate.py` + `test_seo_gate.py` — SEO/GEO-Freigabe-Gate
- in `bot.py`: `_handle_academy_callback`, `_handle_seo_callback`,
  `_handle_seo_note`, `_seo_cfg`, `_academy_intent_path`,
  `_academy_auto_dir`, `_do_lookup`, `_do_issue`, `_file_unparsed`,
  `parse_control`, `_now_ts`, `_first_name`

**Nur im Repo vorhanden:**

- `jarvis_brain.py`, `web_search.py`, `websuche_client.py` samt Tests
- `bot.py` ruft `jarvis_brain.respond()` statt eigener Inline-Werkzeuge

**Zwei-Wege-Divergenz bei geteilten Modulen** (Zeilen, die es nur auf einer
Seite gibt):

| Datei | nur Repo | nur live | Richtung |
|---|---:|---:|---|
| `llm.py` | 20 | 1 | Repo voraus (Fallback-Ausweichlogik vom 17.08.) |
| `tts.py` | 7 | 4 | Repo voraus |
| `telegram_api.py` | 2 | 20 | **live voraus** |
| `config.py` | 5 | 17 | **live voraus** |

Deshalb ist weder `rsync` live→Repo noch Repo→live zulässig: jede Richtung
löscht fertige, getestete Arbeit. Das in `tools/voice-echo-bot/DEPLOY.md`
dokumentierte `rsync` würde academy-auto und das SEO/GEO-Gate **still**
abschalten (kein Fehler, die verwaisten Module bleiben liegen).

## Ziel

Ein `bot.py` im Repo, das alle Produktivfunktionen der Live-Fassung trägt
**und** `jarvis_brain` nutzt — damit erbt der Telegram-Jarvis Vault-Lookup,
Issue-Anlage und Websuche aus derselben Quelle wie der Sprach-Satellit, und
Änderungen am Gehirn erreichen künftig beide.

## Vorgehen in vier Schritten

Jeder Schritt endet grün und ist für sich committbar. Nach Schritt 3 wird
**nicht** ausgeliefert, bevor Schritt 4 die Freigabe-Pfade belegt hat.

**Schritt 1 — Live-Wahrheit ins Repo holen (kein Verhalten ändert sich).**
`academy_bridge.py`, `seo_gate.py` und ihre Tests unverändert ins Repo
übernehmen. Reine Neuzugänge, sie können nichts brechen. Danach laufen die
Live-Tests im Repo mit.

**Schritt 2 — Geteilte Module per Hunk zusammenführen.**
`telegram_api.py` und `config.py` von live übernehmen, dabei die
Repo-Ergänzungen (2 bzw. 5 Zeilen) prüfen und erhalten. `llm.py` und
`tts.py` bleiben auf Repo-Stand; die eine abweichende Live-Zeile in `llm.py`
gegenprüfen. Beide Testsuiten müssen danach grün sein.

**Schritt 3 — `bot.py` zusammenführen.**
Basis ist die **Live**-Fassung (sie trägt mehr). Die Inline-Werkzeuge
(`parse_control`, `_do_lookup`, `_do_issue`, `_file_unparsed`) weichen dem
Aufruf von `jarvis_brain.respond()`; academy- und seo-Dispatcher bleiben
unangetastet. `web_key` und `web_erlaubt` werden durchgereicht.

Achtung Sperrschalter: `web_erlaubt` ist der PII-Notaus (siehe
`jarvis_brain.respond`). Der Telegram-Pfad kennt bisher keine
Ketten-Sperre nach einem Vault-Treffer — ob er eine braucht, ist zu
entscheiden, **bevor** die Websuche dort scharf geht.

**Schritt 4 — Freigabe-Pfade belegen, dann ausliefern.**
Vor dem Deploy müssen academy-Freigabe (`academy:approve|reject`) und
SEO/GEO-Freigabe (`seo:ok/no:<token>`) nachweislich funktionieren — beides
sind Knopfdruck-Pfade in Telegram, die kein Unit-Test abdeckt. Erst danach
`bot.py` live kopieren und den Bot neu starten.

## Was NICHT in diesem Bau steckt

- Quellen-URLs in der Telegram-Antwort. Dort wären sie anklickbar und damit
  sinnvoll (anders als im Sprachpfad, wo sie unterdrückt werden) — das ist
  aber eine Erweiterung, kein Teil der Zusammenführung.
- Der Sprach-Satellit. Er ist fertig und bleibt unberührt.

## Risiko

Das Vorhaben fasst zwei produktive Freigabe-Ketten an
(academy-auto, SEO/GEO). Der Schaden bei einem Fehler ist still: die Knöpfe
antworten einfach nicht mehr, ohne Fehlermeldung. Deshalb Schritt 4 als
eigenes Tor und keine Auslieferung „nebenbei" am Ende einer Sitzung.
