# TOOLS.md — YouTube Ingest

## Available Tools

- **Paperclip API** — task management, issue creation, comments, tracker updates
- **Bash** — run yt-dlp, parse transcripts, file system operations
- **Read / Write** — store transcript files temporarily
- **WebFetch** — fetch playlist metadata if needed

## Key Commands

```bash
# Fetch transcript (standard)
yt-dlp --write-auto-sub --skip-download --sub-format vtt -o "%(title)s" <url>

# With cookies fallback
yt-dlp --write-auto-sub --skip-download --sub-format vtt --cookies cookies.txt -o "%(title)s" <url>

# Docker-safe
yt-dlp --write-auto-sub --skip-download --sub-format vtt --no-check-certificate --cookies cookies.txt -o "%(title)s" <url>
```

## Notes

Add notes here as you acquire and learn new tools.
