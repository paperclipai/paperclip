# Coding Standards — AIOX Landing Page v2

## HTML

- HTML5 semântico: `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`
- Heading hierárquico: h1 → h2 → h3 (nunca pular)
- `lang="pt-BR"` no `<html>`
- `alt` em todas as imagens
- `aria-label` em botões/links sem texto descritivo

## CSS

- BEM-like: `.section__element--modifier`
- Seções separadas por comentários: `/* === HERO === */`
- Usar tokens CSS do `:root`, nunca hardcodar cores
- Mobile-first não obrigatório (desktop-first ok mas responsive obrigatório)
- `prefers-reduced-motion` para todas as animations

## JavaScript

- ES6+ (const/let, arrow functions, template literals)
- Nenhuma biblioteca externa
- Event listeners em `DOMContentLoaded`
- Nenhum `document.write`, nenhum `eval`
- `defer` em todos os `<script>` externos

## Commits (para @gage)

- Conventional commits: `feat: add hero section`, `fix: CLS issue in stats bar`
- Co-author: `Co-Authored-By: Paperclip <noreply@paperclip.ing>`

## QA Gate Checklist

Antes de marcar story como InReview:
- [ ] Nenhum erro no console
- [ ] Responsivo em 375px, 768px, 1280px
- [ ] Contraste WCAG AA
- [ ] Lighthouse Performance > 90
- [ ] Sem links quebrados
