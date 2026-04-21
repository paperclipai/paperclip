# Chatverlauf 2026-04-19 — Cloudflare-Umzug und Access

## Ausgangslage

Walter hatte am 17.04. ein Whitepaper zu Cloudflare Tunnel als ngrok-Ersatz erstellen lassen. Am 19.04. wurde der eigentliche Umzug vollzogen: Cloudflare-Account angelegt, Free-Plan aktiviert, Nameserver bei Hetzner auf Cloudflare umgestellt. Beim Einrichten des ersten Tunnels blieb er an der Hostname-Route-Konfiguration hängen (Private statt Public Hostname gewählt).

## Was wurde gemacht

### 1. Cloudflare-Status analysiert
- Nameserver-Umstellung verifiziert: `.ai`-TLD-Delegation schon auf `audrey.ns.cloudflare.com` / `yahir.ns.cloudflare.com` durch
- Lokale Resolver-Caches zeigten noch Hetzner-NS → kein Blocker
- Tunnel `n8n-bridge` war bereits **HEALTHY**, Connector (`cloudflared` auf Mac Studio) verbunden
- Public Hostname Route `n8n.whitestag.ai → localhost:5678` war implizit bereits angelegt — HTTP/2 200 durch End-to-End-Test bestätigt

### 2. Cloudflare Access für Paperclip eingerichtet
- Team-Domain bestätigt: `whitestag.cloudflareaccess.com`
- Self-hosted Application `company` angelegt für `company.whitestag.ai`
- Identity Provider: One-Time PIN (default aktiv)
- Session Duration: 24 Stunden
- Policy "Walter only": Nur `ws@whitestag.ai` darf einloggen (über OTP an die Mailbox)

### 3. Paperclip tunnel-ready gemacht
- `PAPERCLIP_ALLOWED_HOSTNAMES` um `company.whitestag.ai` erweitert
- Stolperstein: Erster `kill`-Restart hat den alten Node-Prozess nicht erwischt (Bash-Wrapper-Problem), zweiter Restart via `lsof -tiTCP:3100 | xargs kill` hat sauber funktioniert
- Public Hostname Route `company.whitestag.ai → localhost:3100` im Tunnel angelegt
- End-to-End-Test: `HTTP/2 302` mit `location: https://whitestag.cloudflareaccess.com/cdn-cgi/access/login/company.whitestag.ai` — Access intercepts korrekt

### 4. n8n hinter dem Tunnel sauber konfiguriert
- `N8N_EDITOR_BASE_URL=https://n8n.whitestag.ai` (damit UI-Deep-Links nicht mehr auf `localhost` zeigen)
- `N8N_PROXY_HOPS=1` (damit X-Forwarded-For korrekt ausgewertet wird)
- n8n neu gestartet, neue Env-Vars im laufenden Prozess verifiziert

### 5. Entscheidungen
- **n8n ohne Access-Schutz**: Bewusst gegen OTP vor n8n entschieden, weil Telegram und andere Webhook-Absender kein OTP eingeben können. Stattdessen nur n8n-Passwort + dringende Empfehlung eines starken Passworts.
- **Ngrok-Cleanup**: In parallelem Chat; hier nur koordiniert.

### 6. Separater Chat gerettet
- Chat "Paperclip Telegram + Luna" konnte wegen Image-Größen-Fehler nicht weiter ausgeführt werden
- JSONL unter `~/.claude/projects/.../da7e1744-a4d0-4a2f-a8db-d8be06be0944.jsonl` gefunden (10 MB, 352 Turns)
- Als lesbares Markdown (132 KB) gespeichert: `2026-04-19 Chatverlauf Paperclip Telegram + Luna.md`

## Geänderte Dateien

| Datei | Änderung |
|---|---|
| `~/Desktop/n8n.sh` | Zeile 16–17: neue Env-Vars `N8N_EDITOR_BASE_URL`, `N8N_PROXY_HOPS` |
| `~/Desktop/n8n.sh` | Zeile 320: `PAPERCLIP_ALLOWED_HOSTNAMES` um `company.whitestag.ai` erweitert |

## Neue Dateien

| Datei | Inhalt |
|---|---|
| `2026-04-19 Chatverlauf Paperclip Telegram + Luna.md` | Gerettetes Transkript des parallelen Chats (132 KB) |
| `2026-04-19 Chatverlauf Cloudflare-Umzug und Access.md` | Dieser Verlauf |

## Cloudflare-Konfiguration (neu)

| Ressource | Wert |
|---|---|
| Cloudflare Account | `ws@whitestag.ai` (Free Plan) |
| Zero Trust Team | `whitestag` (`whitestag.cloudflareaccess.com`) |
| Tunnel | `n8n-bridge` (ID `affbc0a9-a835-4de3-bd71-54a95712201c`) |
| Connector | Mac Studio `MacStudioM4-8.fritz.box` (Origin `91.45.62.151`) |
| Öffentliche Routen | `n8n.whitestag.ai → localhost:5678`<br>`company.whitestag.ai → localhost:3100` |
| Access Application | `company` für `company.whitestag.ai` (OTP für `ws@whitestag.ai`) |

## Offene Punkte

- **Ngrok-Cleanup abschließen** — im parallelen Chat, aber noch nicht verifiziert
- **Bestehende Workflows auf alte ngrok-URLs scannen** — wurde heute zurückgestellt (z. B. `n8n-Proben/`, `Luna Voice + Telegram V10.json`)
- **`TELEGRAM_BOT_TOKEN` aus `n8n.sh` auslagern** — liegt aktuell im Klartext auf dem Desktop (DSGVO-sauberer wäre `~/.whitestag-secrets.env` mit `chmod 600`)
- **n8n-Passwort-Härte prüfen** — da `n8n.whitestag.ai` jetzt öffentlich erreichbar ist, sollte das Passwort >20 Zeichen + einzigartig sein
- **Optional später**: Cloudflare Access mit Pfad-Bypass für Webhook-Routen — falls Risikogefühl sich ändert
