---
name: kb-to-wiki/wiki-links
description: Obsidian-style wiki link processing in kb-to-wiki — syntax, preprocessing/postprocessing mechanism, display text extraction, and URL encoding. Load this when working with [[link]] syntax or debugging broken wiki links.
roles: [developer]
---

# KB-to-Wiki: Wiki Links

Obsidian-style `[[link]]` syntax — how it works and how to debug it.

## Syntax

```
[[path/to/file]]              → links to file, displays filename
[[path/to/file|Custom Text]]  → links to file, displays "Custom Text"
[[path/to/file.md]]           → .md extension stripped from display text
```

**Examples:**

| Wikilink | Displays As |
|---|---|
| `[[projects/anvil/anvil]]` | "anvil" |
| `[[topics/ai-tools/tool-roles]]` | "tool-roles" |
| `[[projects/anvil/anvil\|Anvil Project]]` | "Anvil Project" |

## How It Works (HTML Comment Placeholder Approach)

**Problem:** marked.js escapes underscores in custom placeholders like `__WIKI_LINK_0__`, breaking reconstruction.

**Solution:** Use HTML comment placeholders that pass through the parser untouched.

### Processing Pipeline

```
1. preprocessMarkdown()
   [[projects/anvil/anvil]] → <!-- WIKI_LINK_0 -->
   stores: { 0: { path: "projects/anvil/anvil", display: "" } }

2. marked.parse()
   <!-- WIKI_LINK_0 --> passes through untouched (HTML comments safe)

3. postprocessHTML()
   <!-- WIKI_LINK_0 --> → <a class="wiki-link" data-path="projects/anvil/anvil">anvil</a>
```

### Display Text Extraction

```javascript
// In postprocessHTML():
if (!displayText) {
    const parts = path.split('/');
    displayText = parts[parts.length - 1];  // last path component
    if (displayText.endsWith('.md')) {
        displayText = displayText.slice(0, -3);  // strip .md
    }
}
```

### HTML Escaping

Display text and attribute values are HTML-escaped to prevent injection:

```javascript
function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
```

## Debugging Broken Wiki Links

### Symptom: "Error loading file"

1. Check the `data-path` in browser DevTools — does it match the actual file path?
2. Check for URL encoding issues: path with spaces gets double-encoded
3. Check that the file exists in `--source` directory

### Symptom: Link text shows full path instead of filename

The display text extraction code (`postprocessHTML()`) is not running. Check:
- Is `postprocessHTML()` called after `marked.parse()`?
- Is the HTML comment placeholder (`<!-- WIKI_LINK_N -->`) surviving the parse?

### Symptom: Wiki links show as plain `[[path]]` text

The `preprocessMarkdown()` function isn't running before `marked.parse()`. Ensure:

```javascript
const processedMd = preprocessMarkdown(rawMarkdown);
const html = marked.parse(processedMd);
const finalHtml = postprocessHTML(html);
```

### Symptom: Link click loads wrong file

Check the `data-path` attribute — it should be the full path relative to `--source`, without leading slash. Example: `projects/anvil/anvil.md`.

## Click Handler

```javascript
document.addEventListener('click', (e) => {
    const link = e.target.closest('.wiki-link');
    if (link) {
        e.preventDefault();
        const path = link.dataset.path;
        loadFile(path);
    }
});
```

## URL Encoding in loadFile()

```javascript
async function loadFile(filePath) {
    const encodedPath = filePath.split('/').map(p => encodeURIComponent(p)).join('/');
    const res = await fetch('/api/files/' + encodedPath);
    // ...
}
```

Slashes are preserved; only path components are encoded.
