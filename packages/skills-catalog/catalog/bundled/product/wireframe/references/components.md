# Component primitives

Copy these snippets directly into your SVG. Each primitive is wrapped in a `<g transform="translate(0, 0)">` so you can position it by changing the translate values. All sizes follow the 8px grid and the type scale defined in `grid-system.md`.

## Conventions used below

- `W`, `H` placeholders mean "pick a multiple of 8 that fits your layout".
- `Label`, `Placeholder`, etc. mean "replace with the actual copy".
- The root `<svg>` is assumed to set: `font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"`.
- Always set `stroke="none"` on `<text>` elements.

---

## Inputs

### Button (filled)

```svg
<g transform="translate(0,0)">
  <rect width="120" height="40" rx="4" fill="#000" />
  <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#fff">Continue</text>
</g>
```

### Button (outlined / secondary)

```svg
<g transform="translate(0,0)">
  <rect width="120" height="40" rx="4" />
  <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Cancel</text>
</g>
```

### Button (icon-only square)

```svg
<g transform="translate(0,0)">
  <rect width="40" height="40" rx="4" />
  <!-- glyph: a plus -->
  <line x1="14" y1="20" x2="26" y2="20" />
  <line x1="20" y1="14" x2="20" y2="26" />
</g>
```

### Text input

```svg
<g transform="translate(0,0)">
  <rect width="320" height="40" rx="4" />
  <text x="12" y="25" font-size="14" stroke="none" fill="#666">Placeholder text</text>
</g>
```

### Search input (with magnifier)

```svg
<g transform="translate(0,0)">
  <rect width="480" height="40" rx="20" />
  <circle cx="20" cy="20" r="6" />
  <line x1="24" y1="24" x2="30" y2="30" />
  <text x="40" y="25" font-size="14" stroke="none" fill="#666">Search…</text>
</g>
```

### Textarea

```svg
<g transform="translate(0,0)">
  <rect width="480" height="120" rx="4" />
  <text x="12" y="24" font-size="14" stroke="none" fill="#666">Type your message…</text>
</g>
```

### Dropdown (collapsed)

```svg
<g transform="translate(0,0)">
  <rect width="200" height="40" rx="4" />
  <text x="12" y="25" font-size="14" stroke="none" fill="#000">Selected value</text>
  <!-- chevron -->
  <polyline points="180,17 188,25 180,33" fill="none" />
</g>
```

### Checkbox (unchecked / checked)

```svg
<!-- unchecked -->
<g transform="translate(0,0)">
  <rect width="20" height="20" rx="2" />
</g>

<!-- checked -->
<g transform="translate(0,0)">
  <rect width="20" height="20" rx="2" fill="#000" />
  <polyline points="4,11 9,16 16,6" stroke="#fff" fill="none" />
</g>
```

### Radio (unselected / selected)

```svg
<!-- unselected -->
<g transform="translate(0,0)">
  <circle cx="10" cy="10" r="9" />
</g>

<!-- selected -->
<g transform="translate(0,0)">
  <circle cx="10" cy="10" r="9" />
  <circle cx="10" cy="10" r="4" fill="#000" />
</g>
```

### Toggle (off / on)

```svg
<!-- off -->
<g transform="translate(0,0)">
  <rect width="40" height="20" rx="10" />
  <circle cx="10" cy="10" r="6" fill="#000" />
</g>

<!-- on -->
<g transform="translate(0,0)">
  <rect width="40" height="20" rx="10" fill="#000" />
  <circle cx="30" cy="10" r="6" fill="#fff" />
</g>
```

### Form field (label + input + help)

```svg
<g transform="translate(0,0)">
  <text x="0" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Email address</text>
  <g transform="translate(0,24)">
    <rect width="320" height="40" rx="4" />
    <text x="12" y="25" font-size="14" stroke="none" fill="#666">you@example.com</text>
  </g>
  <text x="0" y="84" font-size="12" stroke="none" fill="#666">We'll never share this with anyone.</text>
</g>
```

---

## Layout

### Card

```svg
<g transform="translate(0,0)">
  <rect width="384" height="200" rx="6" />
  <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">Card title</text>
  <text x="24" y="68" font-size="14" stroke="none" fill="#666">Supporting copy goes here.</text>
  <line x1="0" y1="160" x2="384" y2="160" />
  <text x="24" y="184" font-size="14" stroke="none" fill="#000">Footer action</text>
</g>
```

### Section divider

```svg
<g transform="translate(0,0)">
  <line x1="0" y1="0" x2="1184" y2="0" stroke="#666" />
</g>
```

### Two-column split (60 / 40)

```svg
<g transform="translate(0,0)">
  <rect width="704" height="400" />
  <rect x="728" width="456" height="400" />
</g>
```

---

## Navigation

### Navbar (top)

```svg
<g transform="translate(0,0)">
  <rect width="1280" height="64" />
  <!-- logo placeholder -->
  <rect x="24" y="16" width="32" height="32" rx="4" fill="#e6e6e6" />
  <!-- nav items -->
  <text x="80" y="40" font-size="14" stroke="none" fill="#000">Dashboard</text>
  <text x="184" y="40" font-size="14" stroke="none" fill="#666">Projects</text>
  <text x="272" y="40" font-size="14" stroke="none" fill="#666">Reports</text>
  <text x="352" y="40" font-size="14" stroke="none" fill="#666">Settings</text>
  <!-- right side: avatar -->
  <circle cx="1240" cy="32" r="16" fill="#e6e6e6" />
</g>
```

### Sidebar nav

```svg
<g transform="translate(0,0)">
  <rect width="240" height="800" />
  <text x="24" y="40" font-size="20" font-weight="600" stroke="none" fill="#000">App</text>
  <!-- active item -->
  <rect x="0" y="80" width="240" height="40" fill="#e6e6e6" />
  <text x="24" y="105" font-size="14" stroke="none" fill="#000">Dashboard</text>
  <!-- inactive items -->
  <text x="24" y="153" font-size="14" stroke="none" fill="#666">Projects</text>
  <text x="24" y="201" font-size="14" stroke="none" fill="#666">Reports</text>
  <text x="24" y="249" font-size="14" stroke="none" fill="#666">Team</text>
  <text x="24" y="297" font-size="14" stroke="none" fill="#666">Settings</text>
</g>
```

### Tab bar

```svg
<g transform="translate(0,0)">
  <line x1="0" y1="48" x2="640" y2="48" />
  <!-- active tab -->
  <text x="24" y="32" font-size="14" font-weight="600" stroke="none" fill="#000">Overview</text>
  <line x1="16" y1="48" x2="104" y2="48" stroke-width="3" />
  <!-- inactive tabs -->
  <text x="136" y="32" font-size="14" stroke="none" fill="#666">Activity</text>
  <text x="232" y="32" font-size="14" stroke="none" fill="#666">Members</text>
  <text x="328" y="32" font-size="14" stroke="none" fill="#666">Settings</text>
</g>
```

### Breadcrumb

```svg
<g transform="translate(0,0)">
  <text x="0" y="14" font-size="14" stroke="none" fill="#666">Workspace</text>
  <text x="80" y="14" font-size="14" stroke="none" fill="#666">/</text>
  <text x="96" y="14" font-size="14" stroke="none" fill="#666">Projects</text>
  <text x="160" y="14" font-size="14" stroke="none" fill="#666">/</text>
  <text x="176" y="14" font-size="14" font-weight="600" stroke="none" fill="#000">Project name</text>
</g>
```

### Pagination

```svg
<g transform="translate(0,0)">
  <rect width="32" height="32" />
  <text x="16" y="21" font-size="14" text-anchor="middle" stroke="none" fill="#666">‹</text>
  <rect x="40" width="32" height="32" fill="#000" />
  <text x="56" y="21" font-size="14" text-anchor="middle" stroke="none" fill="#fff">1</text>
  <rect x="80" width="32" height="32" />
  <text x="96" y="21" font-size="14" text-anchor="middle" stroke="none" fill="#000">2</text>
  <rect x="120" width="32" height="32" />
  <text x="136" y="21" font-size="14" text-anchor="middle" stroke="none" fill="#000">3</text>
  <rect x="160" width="32" height="32" />
  <text x="176" y="21" font-size="14" text-anchor="middle" stroke="none" fill="#666">›</text>
</g>
```

---

## Content

### Heading

```svg
<text x="0" y="28" font-size="28" font-weight="700" stroke="none" fill="#000">Page title</text>
```

### Section heading

```svg
<text x="0" y="20" font-size="20" font-weight="600" stroke="none" fill="#000">Section</text>
```

### Paragraph block (placeholder lines)

```svg
<g transform="translate(0,0)">
  <line x1="0" y1="8" x2="480" y2="8" stroke="#666" />
  <line x1="0" y1="24" x2="480" y2="24" stroke="#666" />
  <line x1="0" y1="40" x2="320" y2="40" stroke="#666" />
</g>
```

### List row (avatar + title + subtitle + chevron)

```svg
<g transform="translate(0,0)">
  <rect width="800" height="56" />
  <circle cx="32" cy="28" r="16" fill="#e6e6e6" />
  <text x="64" y="24" font-size="14" font-weight="600" stroke="none" fill="#000">Primary text</text>
  <text x="64" y="40" font-size="12" stroke="none" fill="#666">Secondary text</text>
  <polyline points="772,20 780,28 772,36" fill="none" />
</g>
```

### Table

```svg
<g transform="translate(0,0)">
  <!-- header -->
  <rect width="800" height="48" fill="#f4f4f4" />
  <text x="16" y="30" font-size="12" font-weight="600" stroke="none" fill="#000">Name</text>
  <text x="280" y="30" font-size="12" font-weight="600" stroke="none" fill="#000">Status</text>
  <text x="480" y="30" font-size="12" font-weight="600" stroke="none" fill="#000">Updated</text>
  <text x="680" y="30" font-size="12" font-weight="600" stroke="none" fill="#000">Owner</text>

  <!-- rows -->
  <g transform="translate(0,48)">
    <rect width="800" height="48" />
    <text x="16" y="30" font-size="14" stroke="none" fill="#000">Row title 1</text>
    <text x="280" y="30" font-size="14" stroke="none" fill="#666">Active</text>
    <text x="480" y="30" font-size="14" stroke="none" fill="#666">2h ago</text>
    <text x="680" y="30" font-size="14" stroke="none" fill="#666">Alex</text>
  </g>
  <g transform="translate(0,96)">
    <rect width="800" height="48" />
    <text x="16" y="30" font-size="14" stroke="none" fill="#000">Row title 2</text>
    <text x="280" y="30" font-size="14" stroke="none" fill="#666">Pending</text>
    <text x="480" y="30" font-size="14" stroke="none" fill="#666">5h ago</text>
    <text x="680" y="30" font-size="14" stroke="none" fill="#666">Sam</text>
  </g>
</g>
```

### Key-value pair

```svg
<g transform="translate(0,0)">
  <text x="0" y="14" font-size="12" stroke="none" fill="#666">Created</text>
  <text x="0" y="34" font-size="14" stroke="none" fill="#000">Mar 12, 2026</text>
</g>
```

### Metric tile

```svg
<g transform="translate(0,0)">
  <rect width="240" height="120" rx="6" />
  <text x="24" y="40" font-size="12" stroke="none" fill="#666">Active users</text>
  <text x="24" y="80" font-size="28" font-weight="700" stroke="none" fill="#000">1,284</text>
  <text x="24" y="104" font-size="12" stroke="none" fill="#666">+12% vs last week</text>
</g>
```

---

## Media

### Image placeholder (with diagonal cross)

```svg
<g transform="translate(0,0)">
  <rect width="240" height="160" fill="#e6e6e6" />
  <line x1="0" y1="0" x2="240" y2="160" stroke="#666" />
  <line x1="240" y1="0" x2="0" y2="160" stroke="#666" />
</g>
```

### Avatar (circular, with cross)

```svg
<g transform="translate(0,0)">
  <circle cx="24" cy="24" r="24" fill="#e6e6e6" />
  <line x1="7" y1="7" x2="41" y2="41" stroke="#666" />
  <line x1="41" y1="7" x2="7" y2="41" stroke="#666" />
</g>
```

### Video placeholder (image + play triangle)

```svg
<g transform="translate(0,0)">
  <rect width="320" height="180" fill="#e6e6e6" />
  <line x1="0" y1="0" x2="320" y2="180" stroke="#666" />
  <line x1="320" y1="0" x2="0" y2="180" stroke="#666" />
  <circle cx="160" cy="90" r="32" fill="#fff" />
  <polygon points="150,76 150,104 178,90" fill="#000" stroke="none" />
</g>
```

---

## Overlay

### Modal (with backdrop)

```svg
<!-- backdrop dims the canvas; render this inside an SVG that already has the underlying screen -->
<rect x="0" y="0" width="1280" height="800" fill="#000" fill-opacity="0.4" stroke="none" />

<g transform="translate(320, 200)">
  <rect width="640" height="400" rx="6" />
  <text x="24" y="48" font-size="20" font-weight="600" stroke="none" fill="#000">Confirm action</text>
  <line x1="0" y1="72" x2="640" y2="72" />
  <text x="24" y="112" font-size="14" stroke="none" fill="#000">Body copy goes here describing what's about to happen.</text>
  <line x1="0" y1="328" x2="640" y2="328" />
  <!-- footer actions -->
  <g transform="translate(384, 348)">
    <rect width="120" height="40" rx="4" />
    <text x="60" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#000">Cancel</text>
  </g>
  <g transform="translate(512, 348)">
    <rect width="104" height="40" rx="4" fill="#000" />
    <text x="52" y="25" font-size="14" text-anchor="middle" stroke="none" fill="#fff">Confirm</text>
  </g>
</g>
```

### Toast

```svg
<g transform="translate(0,0)">
  <rect width="320" height="56" rx="6" fill="#000" />
  <text x="24" y="34" font-size="14" stroke="none" fill="#fff">Saved successfully</text>
  <text x="280" y="34" font-size="14" stroke="none" fill="#fff">×</text>
</g>
```

### Tooltip

```svg
<g transform="translate(0,0)">
  <rect width="160" height="32" rx="4" fill="#000" />
  <text x="80" y="20" font-size="12" text-anchor="middle" stroke="none" fill="#fff">Helpful explanation</text>
  <polygon points="76,32 80,40 84,32" fill="#000" stroke="none" />
</g>
```

### Dropdown menu (open state)

```svg
<g transform="translate(0,0)">
  <rect width="200" height="160" rx="4" />
  <text x="16" y="28" font-size="14" stroke="none" fill="#000">Menu item one</text>
  <text x="16" y="60" font-size="14" stroke="none" fill="#000">Menu item two</text>
  <text x="16" y="92" font-size="14" stroke="none" fill="#000">Menu item three</text>
  <line x1="0" y1="108" x2="200" y2="108" />
  <text x="16" y="136" font-size="14" stroke="none" fill="#000">Sign out</text>
</g>
```

---

## Annotation layer

Use these for callouts and reviewer notes. Render them in a final `<g data-region="annotations">` so reviewers can hide them by toggling the group.

### Numbered callout

```svg
<g transform="translate(0,0)">
  <circle cx="0" cy="0" r="12" fill="#fff" stroke="#d33" stroke-dasharray="4 2" />
  <text x="0" y="4" font-size="12" font-weight="700" text-anchor="middle" stroke="none" fill="#d33">1</text>
</g>
```

### Dashed region highlight

```svg
<rect x="0" y="0" width="240" height="120" fill="none" stroke="#d33" stroke-dasharray="6 3" />
```

### Arrow connector (between two screens)

```svg
<g transform="translate(0,0)">
  <line x1="0" y1="0" x2="120" y2="0" stroke="#000" />
  <polygon points="120,0 110,-6 110,6" fill="#000" stroke="none" />
</g>
```

---

## Common composition mistakes (avoid)

- **Text with halo:** forgetting `stroke="none"` on `<text>`. The text inherits the parent stroke.
- **Off-grid coordinates:** values like `x="37"` instead of `x="40"`. Snap everything to multiples of 8.
- **Solid fills sneaking in:** anything other than `#fff`, `#e6e6e6`, `#f4f4f4`, or `#000` is a mistake.
- **Multiple typefaces:** stick to one font-family across the whole file.
- **Annotation colour bleeding into UI:** `#d33` only ever appears inside the annotation `<g>`.
- **Missing `viewBox`:** without it, the SVG won't scale when embedded in different containers.
