Academy-Auto — lässt Claude Code Aufgaben in einem isolierten Worktree
umsetzen, prüft sie mit einem Gate und meldet den Stand als Jarvis-Digest.

## Zwei Läufe

| `--target` | Repo | Gate | Triage-Quellen | launchd |
|---|---|---|---|---|
| `academy` (Standard) | `whitestagai/ki-kompass` (Expo-App) | `npm test` + `npx tsc --noEmit` + `npm run lint` | todo, skip, tsc, lint, issue | 02:00 |
| `web` | `whitestagai/whitestag-academy-web` (Astro-Site) | `npm run build` | todo, skip, issue | 03:00 |

Beide haben **eigenen Worktree, eigene `pending.json`, eigenen Triage-State und
eigene Flag-Dateien** — sie dürfen sich nichts teilen, sonst überschreiben sie
sich gegenseitig.

**Warum der Web-Lauf keine tsc/lint-Kandidaten anbietet:** sein Gate baut nur.
Ein Kandidat, den das Gate nicht messen kann, ist unerledigbar — der Lauf setzt
ihn um, sieht keinen Fortschritt und verwirft ihn, jede Nacht aufs Neue. Genau
das passierte am 31.07. im `academy`-Lauf mit lint-Verstössen aus `tests/`,
die `expo lint src` nie gesehen hat. `scan_sources` muss deshalb **immer** zu
`gate_commands` passen.

Der Telegram-Rückkanal teilt sich **einen** `intent.json`-Pfad (der Bot kennt
nur einen). Zugeordnet wird über `ref_run_ts` — jeder Lauf schreibt einen
eindeutigen Zeitstempel in seine `pending.json`. Passt keiner, meldet der
Executor „überholt", statt im falschen Repo einen PR zu öffnen.

## Ausführen (manuell, Phase A)

    cd tools/academy-auto
    python -m academy_auto.orchestrator "Beschreibe hier die Aufgabe"

## Tests

    cd tools/academy-auto && python -m pytest tests/ -v

## Kill-Switch

    touch ~/.paperclip/academy-auto.pause   # hält jeden Lauf sofort an
    rm    ~/.paperclip/academy-auto.pause   # wieder freigeben

## Deploy (launchd, Phase B)

Paket nach ~/.paperclip/scripts/academy-auto/ kopieren (launchd kann
CloudStorage nicht lesen) und `send_digest`-Sender an den voice-echo-bot
verdrahten. launchd-Automatik + self-directed Triage kommen in Phase B.

## Betrieb (launchd)

Deploy — launchd kann CloudStorage/SynologyDrive nicht lesen, deshalb eine Kopie:

    rsync -a --delete --exclude __pycache__ tools/academy-auto/ ~/.paperclip/scripts/academy-auto/
    cp tools/academy-auto/de.whitestag.academy-auto.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/de.whitestag.academy-auto.plist

Läuft täglich 02:00. Log: `~/.paperclip/logs/academy-auto.log`

Schalter (Flag-Dateien, kein Code-Edit nötig):

    touch ~/.paperclip/academy-auto.dryrun   # Trockenlauf: laeuft komplett, committet NICHT
    rm    ~/.paperclip/academy-auto.dryrun   # scharf schalten
    touch ~/.paperclip/academy-auto.pause    # Not-Aus (hat Vorrang vor allem)

Lauf von Hand (statt auf 02:00 zu warten):

    zsh ~/.paperclip/scripts/academy-auto/run-nightly.sh

## Autonomer Betrieb: Risikostufen und Auto-Merge

Der Lauf arbeitet bis zu `max_tasks_per_run` Aufgaben ab (Standard 3) und
entscheidet je Aufgabe **deterministisch** — nicht per LLM —, ob sie ohne
Rückfrage nach `main` darf (`risk.py`):

| Stufe | Bedingung | Was passiert |
|---|---|---|
| **GRÜN** | ausschließlich `src/` und `tests/`, Diff ≤ `auto_merge_max_lines` (300) | push → PR → **merge**, dann weiter mit der nächsten Aufgabe |
| **GELB** | Build/Abhängigkeiten (`package.json`, `tsconfig.json`, `app.json`, `eslint.config.js` …), Infrastruktur (`.github/`, `ios/`, `android/`, `scripts/`, `supabase/`), oder Diff > 300 | commit, **Lauf endet**, Telegram-✅ nötig |
| **ROT** | Secrets, Signing-Keys, Supabase-Migrationen | schon vorher vom Scope-Zaun (`scope.py`) **verworfen**, nicht gefragt |

Die gelbe Stufe beendet den Lauf, weil der Branch danach ohnehin durch die
Freigabe-Sperre blockiert ist.

**Sicherheitsnetz nach jedem Auto-Merge** (`landing.py`): der Worktree wird auf
den frisch gemergten `main` zurückgesetzt und das Gate **dort erneut**
gemessen. Rot → die ganze Spanne wird automatisch revertiert und gepusht.
Nötig ist das, weil sich `main` zwischen Baseline und Merge bewegt haben kann
(ein von Walter gemergter gelber PR, ein Handcommit): zwei je für sich grüne
Änderungen können zusammen rot ergeben.

Schlägt ein Merge fehl oder wird revertiert, endet der Lauf — der Zustand von
`main` ist dann nicht mehr der, auf dem die Baseline stand.

Der 08:00-Digest ist im Regelfall ein **Bericht** („Automatisch gemergt: 2 …"),
keine Rückfrage. Knöpfe erscheinen nur, wenn wirklich etwas wartet.

## Freigabe-Sperre (`awaiting_approval`)

Solange auf `agents/academy-auto` Arbeit liegt, die **noch nicht in `main`
gemergt** ist, setzt der Lauf komplett aus und meldet `awaiting_approval`.

Grund: `prepare_worktree` startet jeden Lauf mit
`git reset --hard <base_branch>`. Zwei Zustände sind davon betroffen:

1. **Noch nicht freigegeben.** Der Reset verschiebt den Branch-Zeiger und macht
   den Commit unerreichbar (nur noch im Reflog). Der normale Takt geht auf —
   02:00 Lauf, 08:00 Digest, Entscheidung am selben Tag —, aber jede Abweichung
   (Lauf von Hand, Urlaub, übersehener Digest) hätte die Arbeit gekostet.
2. **Freigegeben, aber PR noch offen.** Nach ✅ steht der Commit auf origin und
   ein PR ist offen. Liefe jetzt ein neuer Lauf, würde er vom zurückgesetzten
   Branch aus committen — und das `git push -f origin <branch>` des Executors
   bei der nächsten Freigabe würde den **Inhalt des offenen PRs ersetzen**.

Erkennung in `approval.py` ist deshalb bewusst simpel: allein
`<base_branch>..<branch>`. Der Push-Zustand ist irrelevant, origin wird gar
nicht abgefragt. **Erst der Merge gibt die Pipeline wieder frei** — damit hängt
immer höchstens ein offener Agenten-PR in der Luft. Jede unklare git-Antwort
gilt als „offen": eine ausgelassene Nacht ist sichtbar, vernichtete Arbeit
nicht.

Wichtig: Im Sperrfall wird `pending.json` **nicht** überschrieben. Die Datei
trägt die `run_ts`, auf die die Telegram-Buttons zeigen (`executor` prüft
`ref_run_ts`); ein neuer Datensatz würde die Freigabe entwerten. Der 08:00-
Digest wiederholt deshalb denselben Stand mit funktionierenden Buttons, bis
entschieden ist.

Steckengeblieben? So sieht man, worauf gewartet wird:

    git -C ~/Developer/WHITESTAG.ACADEMY log --oneline main..agents/academy-auto
    gh pr list --repo whitestagai/ki-kompass --state open

Auflösen: in Telegram ✅/❌ drücken (öffnet bzw. verwirft den PR) und den
offenen PR **mergen**. Danach ist `main..agents/academy-auto` leer und der
nächste Lauf startet wieder.
