# Lokales Fork-Setup (btiknas)

## Remotes

| Name          | URL                                                              | Zweck                              |
|---------------|------------------------------------------------------------------|------------------------------------|
| `origin`      | git@ssh.dev.azure.com:v3/btiknas/paperclip/paperclip            | Privater Fork (push hierhin)       |
| `upstream`    | https://github.com/paperclipai/paperclip.git                    | Upstream (nur lesen, Rebase-Basis) |
| `github-fork` | https://github.com/btiknas/paperclip.git                        | Alter GitHub-Fork (inaktiv)        |

## Upstream-Änderungen holen (regelmäßig)

```bash
git fetch upstream
git rebase upstream/master
git push origin master
```

---

## Bugfix einreichen (Path 1 — klein & fokussiert)

```bash
# 1. Upstream aktualisieren
git fetch upstream && git rebase upstream/master

# 2. Branch vom aktuellen master anlegen
git checkout -b fix/kurze-beschreibung

# 3. Ändern, testen, committen
git commit -m "fix: kurze Beschreibung"

# 4. Auf eigenen Fork pushen
git push origin fix/kurze-beschreibung

# 5. PR auf GitHub öffnen: btiknas/paperclip → paperclipai/paperclip
gh pr create --repo paperclipai/paperclip --base master
```

Anforderungen: alle Tests grün, Greptile-Score 5/5, PR-Template ausgefüllt.

---

## Feature einreichen (Path 2 — größere Änderung)

### Schritt 1 — Discord-Abstimmung (vor dem Code)

Im `#dev`-Kanal das Feature beschreiben (Problem, Ansatz, betroffene Dateien).
Warten bis grobe Zustimmung da ist — dann erst implementieren.

Beispiel bereits eingereicht (02.05.2026):
> **Per-Provider Rate-Limit Blocking with Model Granularity**
> Discord: https://discord.com/channels/1478750559191302299/1479167065524011200

### Schritt 2 — Branch anlegen (nach Zustimmung)

```bash
# Erst Upstream aktualisieren — immer vom aktuellen master aus starten
git fetch upstream
git rebase upstream/master
git push origin master

# Feature-Branch anlegen
git checkout -b feat/provider-rate-limit-blocking
```

### Schritt 3 — Implementieren & committen

```bash
# Änderungen entwickeln, testen
git commit -m "feat(rate-limits): per-provider model-granular blocking"

# Zwischenstände auf den Fork pushen (sichert deinen Fortschritt)
git push origin feat/provider-rate-limit-blocking
```

### Schritt 4 — PR erstellen: Fork → Upstream

Der PR geht von deinem Feature-Branch im Fork in den `master` des Upstream-Repos:

```
btiknas/paperclip:feat/provider-rate-limit-blocking
        ↓
paperclipai/paperclip:master
```

```bash
gh pr create --repo paperclipai/paperclip --base master \
  --title "feat(rate-limits): per-provider model-granular blocking" \
  --body "$(cat .github/PULL_REQUEST_TEMPLATE.md)"
```

### Schritt 5 — Nach dem Merge

Sobald der PR gemergt ist, holt du den Stand zurück in deinen Fork:

```bash
git fetch upstream
git rebase upstream/master   # dein Feature ist jetzt drin
git push origin master
git branch -d feat/provider-rate-limit-blocking
git push origin --delete feat/provider-rate-limit-blocking
```

### Wenn Upstream sich während der Entwicklung ändert

```bash
git fetch upstream
git rebase upstream/master   # Konflikte lösen, dann: git rebase --continue
git push origin feat/provider-rate-limit-blocking --force-with-lease
```

---

## PR-Template-Pflichtfelder

- **Thinking Path** — von Projektziel runter zur konkreten Änderung
- **What Changed**
- **Verification** — manuelle Testschritte, Screenshots/Video bei UI-Änderungen
- **Risks**
- **Model Used** — z.B. `Claude Sonnet 4.6 — claude-sonnet-4-6`
- **Checklist** — Tests grün, Greptile 5/5, alle Greptile-Kommentare beantwortet
