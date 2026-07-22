# Design: FS-Isolation für academy-auto (sandbox-exec)

**Datum:** 2026-07-22
**Status:** Design (genehmigt, Spec zur Review)
**Ziel:** Der headless Claude-Code-Implementierungsprozess wird OS-erzwungen so eingesperrt, dass er **physisch** nicht außerhalb des Worktrees schreiben und keine Secrets von Walter lesen kann — die Layer-1-Sicherheitsvoraussetzung vor jedem unbeaufsichtigten (launchd-)Betrieb.

## Kontext

academy-auto (Specs `2026-07-22-academy-autonome-agenten-design.md` + `…-triage-design.md`) lässt Claude Code headless im Worktree an der WHITESTAG.ACADEMY-App arbeiten. Bisherige Sicherheitsschichten wirken auf der **Commit-Ebene** (Scope-Zaun, Diff-Cap, Green-/Delta-Gate) — sie verhindern *schlechte Commits*, aber nicht, dass der laufende Agent (oder eine Prompt-Injection) außerhalb des Worktrees schreibt oder Secrets liest. Das mehrfache Final-Review markierte diese fehlende **physische** Isolation als Pflicht vor Automatik.

`sandbox-exec` (`/usr/bin/sandbox-exec`) ist auf dem Mac Studio vorhanden und wurde funktional verifiziert (Schreiben außerhalb eines Allow-Pfads wird real blockiert; `/tmp`→`/private/tmp`-Symlink beachten).

## Entscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Mechanismus | **sandbox-exec-Wrapper** um den `claude -p`-Implementierungsaufruf |
| Lese-Politik | **Read-Deny-Liste**: Lesen frei außer auf einer Secret-Sperrliste |
| Fehlverhalten | **Fail-closed**: Sandbox nicht startbar/Profil ungültig → Lauf gar nicht ausführen |

Verworfen: dedizierter Low-Priv-Nutzer (zu viel Setup auf Single-User-Mac); reine Claude-Code-Softgrenze (`--add-dir`/`--disallowedTools` — keine echte physische Isolation, Bash-Tool könnte ausbrechen).

## Architektur — wo es andockt

Nur der **schreibende Implementierungsaufruf** wird gekapselt. `runner.implement_task` baut `CLAUDE_CMD + [task_prompt]` (`claude -p --permission-mode acceptEdits`) mit `cwd=Worktree`; dieser Aufruf wird zu `["sandbox-exec", "-f", <profil>, *CLAUDE_CMD, task_prompt]`.

**Der Ranker (`rank._default_ranker`) wird NICHT gekapselt:** Er läuft mit `--tools "" --strict-mcp-config`, hat keine Datei-Tools und kann nichts anfassen — reine Wissensantwort, keine Sandbox nötig.

## Das Sandbox-Profil (write-allowlist + read-denylist)

SBPL nutzt *last-match-wins*:

```scheme
(version 1)
(allow default)                          ; Lesen, Netzwerk (Anthropic-API!), exec per Default
(deny file-write*)                       ; Schreiben grundsätzlich aus …
(allow file-write* (subpath "<WORKTREE>"))            ; … außer Worktree
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders")
                   (subpath "<HOME>/.npm") (subpath "<HOME>/Library/Caches")
                   (subpath "<HOME>/.expo") (subpath "<HOME>/.cache")
                   (subpath "<HOME>/.claude"))
(allow file-write-data (path "/dev/null") (path "/dev/tty") (path "/dev/dtracehelper")
                       (path "/dev/random") (path "/dev/urandom"))
(deny file-read* (subpath "<HOME>/.ssh") (subpath "<HOME>/.aws")
                 (subpath "<HOME>/.config/gcloud") (path "<HOME>/.whitestag.env")
                 (subpath "<HOME>/.n8n") (subpath "<HOME>/.paperclip")
                 (subpath "<HOME>/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC"))
(allow file-read* (subpath "<WORKTREE>"))   ; Worktree liegt unter ~/.paperclip → nach dem Deny wieder frei
```

**Zwei bewusste Ausnahmen:**
- `~/.claude` bleibt les- UND schreibbar: Claude braucht seine eigenen Auth-/Session-/Todo-Dateien. Diese schützen wir nicht — sie SIND der Agent (er hat ohnehin seine API-Credentials).
- Die gesamte `Claude Code MAC/`-Sammlung (Walters andere Projekte + das Paperclip-Repo mit `auth.json`) wird les-geblockt. Der Worktree ist ein eigenständiger Git-Checkout unter `~/.paperclip/academy-auto/worktree` und braucht die Quell-Sammlung nicht (eigenes `node_modules` nach `npm install`).

**Netzwerk** bleibt erlaubt (Claude braucht die Anthropic-API). Exfiltrations-Risiko ist niedrig, da die Read-Deny-Liste die Secrets ohnehin unlesbar macht und der Worktree-Quellcode ohnehin nach GitHub geht.

## Komponenten

Neues Modul `academy_auto/sandbox.py`:
1. `build_profile(cfg) -> str` — erzeugt den SBPL-Text aus `cfg.worktree_path`, `Path.home()` und einer Config-getriebenen Secret-Denylist.
2. `wrap_command(cfg, cmd, profile_path) -> list[str]` — gibt `["sandbox-exec", "-f", str(profile_path), *cmd]` zurück.
3. `write_profile(cfg) -> Path` — schreibt das Profil in eine Temp-Datei, gibt den Pfad zurück.
4. `sandbox_available(cfg, runner=subprocess.run) -> bool` — prüft `sandbox-exec` vorhanden UND Profil kompiliert (trockener Mini-Lauf `sandbox-exec -f <profil> /usr/bin/true`); fail-soft (Exception → False).

Config-Erweiterung: `secret_read_paths: tuple[str, ...]` (die Denylist, damit sie ohne Codeänderung justierbar ist) + `sandbox_write_paths: tuple[str, ...]` (Caches).

## Integration in `runner.implement_task`

- Vor dem echten Lauf: `if not sandbox.sandbox_available(cfg): return RunOutcome(ok=False, output="Sandbox nicht startbar (fail-closed)")`.
- Sonst: Profil schreiben, `cmd = sandbox.wrap_command(cfg, CLAUDE_CMD + [task_prompt], profile_path)`, wie bisher mit `cwd=Worktree` ausführen.
- Der `runner`-Parameter bleibt injizierbar (Tests mocken sandbox + subprocess).

**Fail-closed-Wirkung:** `ok=False` läuft im Orchestrator in den bestehenden `impl_failed`-Pfad (Digest mit Hinweis + `_finalize`-Worktree-Reset). Kein ungeschützter Agent wird je gestartet.

## Fehlerbehandlung

- `sandbox-exec` fehlt / Profil kompiliert nicht → `sandbox_available` False → fail-closed (impl_failed).
- Profil-Schreiben schlägt fehl (Temp-Verzeichnis) → Exception fail-soft → als nicht-verfügbar behandeln → fail-closed.
- Ein legitimer Cache-Pfad fehlt im Allowlist (Claude/Node bricht ab) → der Lauf scheitert sichtbar (impl_failed/discarded), NICHT stiller Ausbruch; Nachjustieren über die Config-Listen.

## Testing

- `build_profile`: enthält `file-write*`-Allow für den Worktree, `file-read*`-Deny für `~/.ssh`/`~/.paperclip`/`Claude Code MAC`, KEIN Deny für `~/.claude` (String-/Struktur-Asserts).
- `wrap_command`: exakte `sandbox-exec -f <profil> <cmd>`-Struktur.
- `sandbox_available`: fehlendes `sandbox-exec` (Runner wirft) → False; erfolgreicher Dry-Run → True (gemockt).
- `implement_task` fail-closed: `sandbox_available` False → `RunOutcome(ok=False)`, claude NICHT aufgerufen (throw-Guard auf dem inneren Runner).
- **Echter Isolations-Smoke-Test** (nutzt das reale `sandbox-exec`): generiertes Profil gegen ein triviales `/bin/bash -c`-Kommando — Schreiben in den Worktree erlaubt, Schreiben nach `/private/tmp/<außerhalb>` blockiert, Lesen eines Dummy-„Secret"-Pfads unter der Denylist verweigert. Beweist echte Isolation, nicht nur korrekt aussehenden Profiltext.

## Phasing (YAGNI)

- **Phase 1:** `sandbox.py` (build_profile + wrap_command + write_profile + sandbox_available) mit Unit-Tests + echtem Isolations-Smoke-Test.
- **Phase 2:** Integration in `runner.implement_task` (fail-closed) + Config-Listen + Tests.
- **Phase 3:** Kalibrier-Smoke — ein echter Mini-`claude -p`-Lauf in der Sandbox gegen den echten Worktree, der prüft, dass Claude *arbeiten* kann (eine Datei im Worktree editieren) ohne auszubrechen; Allow-Listen nachjustieren.

## Bewusst außerhalb dieses Designs

launchd-Automatik + echte Telegram-Anbindung bleiben ein eigenes Teilprojekt. Diese FS-Isolation macht den Agenten *sicher einsperrbar*; sie schaltet nichts unbeaufsichtigt scharf. Auch die Härtung der zeilenbasierten Triage-keys (Commit-Pfad-Drift) bleibt separat.

## Offene Punkte für die Umsetzung

- Exakte Cache-Pfade, die ein echter `claude -p`-Lauf + Node/Expo im Worktree schreibt, in Phase 3 empirisch feststellen (Metro-, node-gyp-, npm-Caches) und in die Allowlist aufnehmen.
- Prüfen, ob Claude im `-p`-Modus außerhalb `~/.claude` schreibt (z.B. `$TMPDIR`) — ggf. Allowlist ergänzen.
- Entscheiden, ob `--bare` (kein Keychain/auto-memory) den Profilbedarf reduziert und trotzdem funktioniert.
