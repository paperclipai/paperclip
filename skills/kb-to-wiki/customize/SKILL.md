---
name: kb-to-wiki/customize
description: Theming, dark mode, CSS variables, and template layout customization for kb-to-wiki. Load this when changing the look and feel, adding dark mode, or editing template.html.
roles: [developer]
---

# KB-to-Wiki: Customize

Theming, dark mode, and visual customization.

## Dark Mode

### Toggle Button

The toggle button is in the header in `template.html`:

```html
<button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span class="theme-icon" id="themeIcon">🌙</span>
</button>
```

### JavaScript

```javascript
function initTheme() {
    const savedTheme = localStorage.getItem('theme-preference');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    if (isDark) {
        document.body.classList.add('dark-theme');
        updateThemeIcon(true);
    }
}

function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme-preference', isDark ? 'dark' : 'light');
    updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
    document.getElementById('themeIcon').textContent = isDark ? '☀️' : '🌙';
}
```

Call `initTheme()` in the `<script>` on page load.

### Persistence

- **Key:** `localStorage['theme-preference']`
- **Values:** `'light'` or `'dark'`
- **Fallback:** `prefers-color-scheme` media query on first visit

### Default to Dark Mode

Change `initTheme()` to:

```javascript
const isDark = savedTheme ? savedTheme === 'dark' : true; // always dark if no preference saved
```

## CSS Variables

Light and dark themes use CSS variables defined on `:root` and `body.dark-theme`:

```css
:root {
    --bg-primary: #ffffff;
    --bg-secondary: #f8f9fa;
    --text-primary: #202122;
    --text-secondary: #54595d;
    --accent: #0645ad;
    --border: #a2a9b1;
}

body.dark-theme {
    --bg-primary: #1a1a1a;
    --bg-secondary: #2a2a2a;
    --text-primary: #e0e0e0;
    --text-secondary: #a0a0a0;
    --accent: #3366cc;
    --border: #444444;
}
```

To change a color in both modes, edit only the variable — no hunting through selectors.

## Layout

Wikipedia-style three-column layout:

```
┌─────────────────────────────────────────┐
│ Header (logo, search, theme toggle)     │
├──────────┬──────────────────┬───────────┤
│ Sidebar  │ Article          │ TOC       │
│ (nav)    │ (markdown)       │ (H2/H3)   │
│ 250px    │ max-width 800px  │ 200px     │
└──────────┴──────────────────┴───────────┘
```

### Adjusting Layout

In `template.html` `<style>` block:

```css
.sidebar { width: 250px; }         /* sidebar width */
.article-container { max-width: 800px; }  /* article reading width */
.toc-container { width: 200px; }  /* TOC width */
```

### Responsive Breakpoints

```css
@media (max-width: 1400px) { /* hide TOC */ }
@media (max-width: 1000px) { /* collapse sidebar */ }
@media (max-width: 768px)  { /* mobile: full-width content */ }
```

## Typography

Default uses Georgia serif (Wikipedia-style):

```css
body { font-family: Georgia, 'Times New Roman', serif; }
code { font-family: 'Courier New', monospace; }
```

Change to system sans-serif:

```css
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
```

## Custom CSS

Add custom rules after the existing `<style>` block in `template.html`, or add a `<link rel="stylesheet">` to an external file. Use CSS variables for theme-aware overrides.

## Template Variables (Jinja2)

The template receives these from the Python server at render time:

| Variable | Content |
|---|---|
| `{{ title }}` | Wiki title from `--title` flag |
| `{{ theme }}` | Initial theme (`light` or `dark`) |

Dynamic content (file tree, markdown) is loaded via API calls — not Jinja2 variables.
