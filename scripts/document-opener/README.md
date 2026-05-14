# @paperclipai/document-opener

Local HTTP helper that lets the Paperclip web UI open or reveal files on the
user's machine. Solves the browser-security restriction that forbids `file://`
links from web pages.

## What it does

Runs as an auto-started background service on `127.0.0.1:19327`. The Paperclip
UI detects absolute file paths in Markdown links and renders two icon buttons
next to each one:

- **Öffnen** → POST `/open` → `open <path>` (macOS) or `cmd /c start "" <path>` (Windows)
- **Im Finder zeigen** / **Im Explorer zeigen** → POST `/reveal` → `open -R <path>` (macOS) or `explorer.exe /select,<path>` (Windows)

## Install

```bash
pnpm --filter @paperclipai/document-opener run install:agent
```

This builds `dist/main.js`, writes a default config to
`~/.paperclip/document-opener.json`, installs the platform-specific auto-start
mechanism (launchd plist or Task Scheduler task), and runs a health-check.

**After install, edit `~/.paperclip/document-opener.json`** — the `roots` array
must list the directories the helper is allowed to open. Example:

```json
{
  "port": 19327,
  "roots": [
    "/Users/walter/SynologyDrive/2026",
    "/Volumes/Archive/Obsidian"
  ],
  "allowedOrigins": [
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    "https://company.whitestag.ai"
  ]
}
```

Restart the helper after editing the config:

- **macOS:** `launchctl kickstart -k gui/$(id -u)/ing.paperclip.document-opener`
- **Windows:** `schtasks /end /tn \Paperclip\DocumentOpener && schtasks /run /tn \Paperclip\DocumentOpener`

## Security model

- Helper binds to `127.0.0.1` only — never reachable from the network
- CORS is strict: only the three configured `allowedOrigins` get an `Access-Control-Allow-Origin` header back
- `Content-Type: application/json` requirement forces a CORS preflight, so a malicious page cannot fire-and-forget a POST
- Paths are validated against `roots`: `realpathSync` resolves symlinks, then a prefix check ensures the real path lies inside an allowed root
- Whitelist comparison is case-insensitive on Windows, case-sensitive on macOS

## Logs

- **macOS:** `~/Library/Logs/paperclip-document-opener/{stdout,stderr}.log`
- **Windows:** `%LOCALAPPDATA%\Paperclip\document-opener\logs\` (helper writes; Task Scheduler does not capture stdout)

## Uninstall

- **macOS:**
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ing.paperclip.document-opener.plist
  rm ~/Library/LaunchAgents/ing.paperclip.document-opener.plist
  ```
- **Windows:**
  ```cmd
  schtasks /delete /tn \Paperclip\DocumentOpener /f
  ```

## Troubleshooting

- **UI buttons grayed out** → helper is unreachable. Check `curl http://127.0.0.1:19327/health` and the log files.
- **`403 path outside allowed roots`** → add the directory to `roots` in the config and restart the helper.
- **`502 open failed`** → the OS-level `open` command failed; check the helper logs for stderr.
