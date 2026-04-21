# Chatverlauf 2026-04-21 — Spracheingabe Mac + PC (SuperWhisper-Modes)

## Ausgangslage

Die Paperclip-CEO-Bridge (n8n-Workflow V3) und der Luna-Workflow V10 sind live.
Webhook-Endpoints `/webhook/paperclip/command` und `/webhook/luna/voice` laufen
auf n8n (`192.168.2.191:5678`). Ein erster SuperWhisper-Setup-Guide existiert
bereits (`docs/guides/superwhisper-paperclip.md`), beschreibt aber nur den
Paperclip-Mode.

Walter wollte jetzt die **Spracheingabe-Seite** auf Mac und Windows umsetzen —
Brainstorming, Design, Spec.

## Was wurde gemacht

### Brainstorming (superpowers:brainstorming)

Fragen geklärt:
1. **Ausgangslage:** Noch nichts installiert auf Mac und Windows
2. **Scope:** Voller Setup — drei Modes: Diktieren + Paperclip + Luna
3. **LLM-Cleanup:** Ja, über LM Studio lokal pro Gerät
4. **Architektur-Ansatz:** A (drei native SuperWhisper-Modes pro Gerät) —
   abgegrenzt gegen B (Sprach-Routing-Präfix) und C (Commander-Mode)
5. **LM-Studio-Modelle auf Mac:** Qwen2.5 32B MLX, Gemma 4 26B a4b,
   Mistral Small 3.2 24B
6. **LM-Studio-Modell auf Windows:** Qwen3.6 35B a3b

### Design-Entscheidungen

- **Pro Gerät lokales LM Studio** statt cross-device-Netz-Hop:
  - Mac: Gemma 4 26B a4b (MoE, ~4B aktiv, schnell, gutes Deutsch)
  - Windows: Qwen3.6 35B a3b (MoE, ~3B aktiv)
- **LM Studio bleibt auf Loopback** (kein `0.0.0.0`-Binding nötig)
- **Hotkeys:**
  - Diktieren: `Fn` (Mac) / `Win+Alt+Space` (Windows)
  - Paperclip: `⌘⇧P` (Mac) / `Ctrl⇧P` (Windows)
  - Luna: `⌘⇧L` (Mac) / `Ctrl⇧L` (Windows)
- **Cleanup-Prompts** pro Mode unterschiedlich (Diktier-Glättung,
  Imperativ-Formulierung für Paperclip, Konversations-Glättung für Luna)
- **Custom Vocabulary** gemeinsam + mode-spezifisch (WHITESTAG, WHI-X, Luna
  als Eigenname etc.)
- **Fallback-Plan** für den Fall, dass SuperWhisper auf Windows keine
  Custom-Webhook-Modes / AI-Actions unterstützt: Wispr Flow → PowerShell-
  Eigenbau → Cleanup-Umweg über Mac-LM-Studio
- **Akzeptanzkriterien** und Latenz-Budget (Diktieren ≤3s, Paperclip/Luna ≤7s)

## Geänderte/Erstellte Dateien

- `docs/superpowers/specs/2026-04-20-spracheingabe-mac-pc-design.md` — **neu**,
  committed als `733cfceb`

## Offene Punkte

1. **User-Freigabe für die Spec** — Walter hat sie noch nicht durchgelesen/
   bestätigt. Nächster Schritt beim Wiedereinstieg: Freigabe einholen.
2. **writing-plans-Skill** steht noch aus — nach Freigabe erzeugt er den
   konkreten Implementierungsplan (Tasks, Reihenfolge, Tests).
3. **Installations-Risiken in der Spec** (in Implementation zu verifizieren):
   - Exakter SuperWhisper-Platzhalter (`{{llmOutput}}` vs `{{cleaned}}` vs
     `{{text}}`)
   - Windows-Parität für Custom-Webhook + AI-Action
   - SuperWhisper-Lizenzpolitik (1 oder 2 Lizenzen für 2 Geräte)
4. **Nicht-committete Workflow-Dateien** aus vorheriger Session (nur informativ,
   kein Blocker für diesen Strang):
   - `Paperclip CEO - Voice & Telegram V3.json`
   - `Luna Voice + Telegram V10.json`

## Wiedereinstieg

Beim nächsten Mal:
1. Spec lesen: `docs/superpowers/specs/2026-04-20-spracheingabe-mac-pc-design.md`
2. Freigabe an Claude → `superpowers:writing-plans` aufrufen
3. Nach Plan-Freigabe: Installation Mac-Seite, danach Windows-Seite
