# Tech Stack — AIOX Landing Page v2

## Stack Completo

| Layer | Tech | Versão | Notes |
|-------|------|--------|-------|
| Markup | HTML5 | — | Semântico, sem framework |
| Styles | CSS3 custom properties | — | Tokens em :root |
| Scripts | Vanilla JS ES6+ | — | Zero libs externas |
| Fonts | Google Fonts | — | Geist, Geist Mono |
| Hosting | Vercel | — | Static deploy |
| CI | Vercel GitHub integration | — | Push = deploy |

## Dependências Externas

```html
<!-- Fonts CDN (único recurso externo) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

## Design Tokens

```css
:root {
  --bb-lime: oklch(93.4% .2264 121.95);
  --bg-void: #000000;
  --bg-base: #0a0a0a;
  --bg-surface: oklch(16.93% .0041 285.95);
  --bg-elevated: oklch(18.4% .0081 118.61);
  --text-primary: oklch(99.52% .0235 106.82);
  --text-secondary: oklch(69.27% 0 0);
  --border: oklch(28.58% .0036 286.17);
  --border-strong: #D1FF0033;
  --lime-glow: #D1FF0040;
}
```
