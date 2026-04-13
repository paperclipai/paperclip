---
name: kb-to-wiki/server
description: Dynamic HTTP server mode for kb-to-wiki — serves the wiki shell and loads markdown content on demand via API endpoints. Use this when running a live server to browse the wiki in a browser.
roles: [developer]
---

# KB-to-Wiki: Server Mode

Run a live HTTP server that dynamically loads markdown content via API.

## When to Use

- Browse the wiki in a browser with live navigation
- Debug wiki links or layout without regenerating static HTML
- Develop template changes and see them quickly

## Run

```bash
python /Users/angelhermon/.claude/skills/kb-to-wiki/scripts/kb-to-wiki.py \
  --source ~/knowledge-base \
  --output wiki.html \
  --title "My Knowledge Base" \
  --port 8000
```

Then open `http://localhost:8000`.

## API Endpoints

| Route | Returns |
|---|---|
| `GET /` or `GET /wiki.html` | HTML shell (template) |
| `GET /api/tree` | JSON file tree for sidebar navigation |
| `GET /api/files/{path}` | Raw markdown content for a specific file |

### `/api/tree` Response Shape

```json
{
  "name": "knowledge-base",
  "type": "folder",
  "children": [
    {
      "name": "projects",
      "type": "folder",
      "children": [
        { "name": "overview", "type": "file", "path": "projects/overview.md", "title": "Overview" }
      ]
    }
  ]
}
```

### `/api/files/{path}` Details

- Path is relative to `--source` directory
- Path components are URL-encoded; server URL-decodes before resolving
- Security: validates path stays within source dir (`Path.relative_to(source_dir)`)
- Returns raw markdown text; client renders with marked.js

## Architecture

```
Browser                      Python Server
  │                               │
  │  GET /api/tree                │
  ├──────────────────────────────►│ scan source dir, return JSON
  │◄──────────────────────────────┤
  │                               │
  │  GET /api/files/projects/x.md │
  ├──────────────────────────────►│ validate path, read file, return markdown
  │◄──────────────────────────────┤
  │                               │
  │  marked.js renders markdown   │
  │  postprocessHTML() converts   │
  │  wiki link placeholders       │
```

## Security

- Path validation: `file_path.relative_to(source_dir)` — prevents directory traversal
- Server binds to `127.0.0.1` only — not exposed on network interfaces
- Excludes hidden files and patterns from `--exclude`

## URL Encoding

Paths with spaces or special characters are URL-encoded by the client:

```javascript
const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
const res = await fetch('/api/files/' + encodedPath);
```

Server decodes with:

```python
from urllib.parse import unquote
rel_path = unquote(self.path[11:])  # strip "/api/files/" prefix, decode
```

## Port Configuration

```bash
python scripts/kb-to-wiki.py --source ~/knowledge-base --port 9998
# Open http://localhost:9998
```

Default port is 8000. Change with `--port`.
