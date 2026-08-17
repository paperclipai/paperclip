# Übergabe — Telegram-Fork zusammenführen (Stand 2026-08-17)

Startprompt für eine neue Sitzung. Der eigentliche Entwurf steht in
`docs/superpowers/specs/2026-08-17-telegram-fork-zusammenfuehrung-design.md`;
dieser Text ist nur der Einstieg.

## Prompt zum Kopieren

> Im Projekt Paperclip soll der Telegram-Jarvis die Websuche bekommen. Das geht
> erst, wenn der Fork zwischen Repo und Live-Stand zusammengeführt ist.
>
> Der Entwurf dafür liegt fertig vor:
> `docs/superpowers/specs/2026-08-17-telegram-fork-zusammenfuehrung-design.md`
>
> Bitte lies ihn zuerst, prüfe die dort genannten Zahlen gegen den aktuellen
> Stand nach (sie sind vom 17.08. und können veraltet sein) und setze ihn dann
> in seinen vier Schritten um — testgetrieben, jeder Schritt für sich grün und
> committbar.
>
> Ausgangslage in einem Satz: `~/.paperclip/scripts/voice-echo-bot/bot.py` (504
> Zeilen) und `tools/voice-echo-bot/bot.py` (272 Zeilen) sind zwei verschiedene
> Programme, beide getestet und grün — Repo 174 Tests, live 135.
>
> Drei Dinge, die dich sonst Zeit oder Schaden kosten:
>
> 1. Es ist eine ZWEI-WEGE-Divergenz. `llm.py` und `tts.py` sind im Repo
>    voraus, `telegram_api.py` und `config.py` live. Weder `rsync` live→Repo
>    noch Repo→live ist zulässig; jede Richtung löscht fertige Arbeit. Das in
>    `tools/voice-echo-bot/DEPLOY.md` dokumentierte rsync würde academy-auto
>    und das SEO/GEO-Freigabe-Gate still abschalten.
>
> 2. Die Live-Tests `test_academy_bridge.py` und `test_seo_gate.py` existieren
>    NUR unter `~/.paperclip` und wurden nie ins Repo zurückgeholt. Sie sind
>    der Grund, warum Schritt 1 (reine Neuzugänge ins Repo) risikolos ist.
>
> 3. `web_erlaubt` in `jarvis_brain.respond()` ist der PII-Notaus, nicht bloß
>    ein Schalter: Er sperrt die Websuche, nachdem Vault-Daten geflossen sind.
>    Der lokale Websuche-Dienst braucht keinen API-Key, deshalb hängt die
>    Sperre NICHT mehr am Schlüssel. Ob der Telegram-Pfad eine solche
>    Ketten-Sperre braucht, ist zu entscheiden, BEVOR die Websuche dort scharf
>    geht.
>
> Nicht ausliefern, bevor academy-Freigabe (`academy:approve|reject`) und
> SEO/GEO-Freigabe (`seo:ok/no:<token>`) nachweislich funktionieren — das sind
> Knopfdruck-Pfade in Telegram, die kein Unit-Test abdeckt, und ihr Ausfall
> wäre still.
>
> Arbeitsstand: Branch `feat/websuche-dienst`, `master` zeigt auf denselben
> Commit, alles gepusht nach `fork`. Der Sprach-Satellit ist fertig und soll
> unberührt bleiben.

## Weitere offene Punkte (nicht Teil des Prompts)

- **Rückweg beim Sprachmodell.** `sat_config.CHAT_MODEL` steht auf
  `gemma-4-31b-it-mlx` (live 3,1–7,9 s, liegt auf dem MacBook). Zurück auf
  `mistral-small-3.2-24b-instruct-2506@q4_k_m` (1,5–2,7 s, lokal auf der RTX)
  ist eine Zeile.
- **Upstream-Abgleich.** `master` ist 833 Commits hinter `origin/master`
  (`paperclipai/paperclip`); der Trockenlauf meldet 40 Konfliktdateien.
  Eigenes Vorhaben mit Testlauf danach.
- **Branch-Hygiene.** 11 lokale Branches stecken vollständig in der
  Feature-Arbeit und könnten weg; sechs weitere hängen an Worktrees und
  bleiben.
