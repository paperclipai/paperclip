# Architecture: AIOX Landing Page v2

**Version:** 1.0
**Date:** 2026-03-28
**Author:** Aria (@architect)
**Issue:** [AIOAAA-17](/AIOAAA/issues/AIOAAA-17)
**Parent:** [AIOAAA-13](/AIOAAA/issues/AIOAAA-13)
**Inputs:** `docs/lp2/prd.md`, `docs/lp2/front-end-spec.md`

---

## Architecture Decision

**ADR-LP2-001: Static HTML/CSS/JS — No Framework**

- **Decisão:** Landing page estática pura, sem bundler, sem framework JS
- **Motivação:** Consistência com LP1, performance máxima, zero dependências de runtime, deploy instantâneo na Vercel
- **Alternativas rejeitadas:** Next.js (overhead desnecessário), Astro (curva de aprendizado), Vite+Vanilla (bundler add complexity sem benefício real)
- **Trade-offs:** Menos DX para edição futura, mas LP é conteúdo relativamente estático

---

## File Structure

```
landing-v2/
├── index.html          # Página principal (tudo inline ou com CSS externo)
├── styles.css          # (opcional) CSS separado se index.html ficar muito grande
├── assets/
│   └── (sem assets externos por enquanto — usar emoji e CSS)
└── .gitignore          # Herdado do root
```

**Vercel routing:** Adicionar à config existente em `vercel.json`:
```json
{
  "rewrites": [
    { "source": "/v2", "destination": "/landing-v2/index.html" },
    { "source": "/v2/(.*)", "destination": "/landing-v2/$1" }
  ]
}
```

---

## Technology Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| Markup | HTML5 semântico | Performance, SEO, acessibilidade |
| Styles | CSS3 custom properties | Tokens reutilizáveis, sem runtime |
| Interactivity | Vanilla JS (ES6+) | Zero dependências, IntersectionObserver nativo |
| Fonts | Google Fonts CDN | Geist + Geist Mono (preconnect) |
| Hosting | Vercel (estático) | Já configurado, CDN global, zero-config |
| CI | Deploy automático via Vercel GitHub integration | Push = deploy |

---

## Component Architecture (CSS)

```
index.html
├── :root tokens (CSS custom properties)
├── Global resets + base styles
├── Layout utilities (flex, grid helpers)
├── Section: .navbar
├── Section: .hero
│   ├── .hero__eyebrow
│   ├── .hero__headline
│   ├── .hero__subheadline
│   ├── .hero__cta-group
│   └── .hero__terminal (animation)
├── Section: .stats-bar
├── Section: .how-it-works
│   └── .step-card × 4
├── Section: .agents
│   └── .agent-card × 6
├── Section: .outcomes
│   ├── .metric-row
│   └── .benefit-card × 3
├── Section: .for-who
│   └── .persona-card × 2
├── Section: .testimonials
│   └── .quote-card × 3
├── Section: .cta-final
└── Section: .footer
```

---

## JavaScript Architecture

**Princípio:** Zero libs externas. Apenas Web APIs nativas.

```javascript
// Módulos (IIFE pattern para encapsulamento sem bundler)

// 1. Scroll animations via IntersectionObserver
const animateOnScroll = () => {
  const observer = new IntersectionObserver(
    (entries) => entries.forEach(e => e.isIntersecting && e.target.classList.add('visible')),
    { threshold: 0.1 }
  );
  document.querySelectorAll('[data-animate]').forEach(el => observer.observe(el));
};

// 2. Typewriter terminal animation
const typewriterLoop = (element, lines, speed = 40) => {
  // Cicla pelas linhas em loop infinito
};

// 3. Mobile hamburger menu
const mobileMenu = () => {
  // Toggle .nav-open no body
};

// 4. Sticky navbar com classe após scroll
const stickyNav = () => {
  // Adiciona .scrolled ao navbar após 50px de scroll
};
```

---

## Performance Architecture

### Critical Path
1. HTML inline com CSS crítico (above-the-fold) para LCP < 2.5s
2. Google Fonts com `preconnect` e `font-display: swap`
3. Nenhuma imagem above-the-fold (hero usa CSS/animation)
4. Nenhum JS bloqueante — tudo `defer` ou no final do `<body>`

### Bundle Size Targets
- HTML: < 80KB
- CSS: < 30KB
- JS: < 15KB
- Total: < 130KB (sem assets de imagem/vídeo)
- Fontes: carregadas async via Google CDN

### Core Web Vitals Strategy

| Metric | Target | Strategy |
|--------|--------|----------|
| LCP | < 2.5s | CSS-only hero, preconnect fonts, inline critical CSS |
| CLS | < 0.1 | Dimensões explícitas em todos os elementos, font-display: swap |
| TBT | < 200ms | JS mínimo, sem frameworks, sem bibliotecas pesadas |
| FID/INP | < 100ms | Event handlers simples, nenhum cálculo pesado |

---

## SEO Architecture

```html
<!-- Meta tags em <head> -->
<title>AIOX — Ship com seu Time de IA | Paperclip</title>
<meta name="description" content="Paperclip + AIOX: a plataforma de engenharia autônoma. 10 agentes especializados, QA automático, deploy sem intervenção humana.">
<meta name="robots" content="index, follow">

<!-- OG tags -->
<meta property="og:title" content="AIOX — Ship com seu Time de IA">
<meta property="og:description" content="Paperclip orquestra. AIOX executa. Seu produto cresce.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://paperclip.ing/v2">

<!-- Canonical -->
<link rel="canonical" href="https://paperclip.ing/v2">
```

---

## Acessibilidade

- Ordem de heading: h1 (hero) → h2 (sections) → h3 (cards) — nunca pular
- `aria-label` em botões com apenas ícones
- `prefers-reduced-motion` media query para desabilitar animações
- Contraste: verificar todos os textos vs backgrounds com WCAG AA (4.5:1 mínimo)
- Links com texto descritivo (sem "clique aqui")

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Deployment Architecture

```
GitHub Push (master)
    → Vercel GitHub Integration
    → Build: static files (sem build step necessário)
    → CDN: deploy em < 30s
    → URL: paperclip.ing/v2 (ou subdomínio)
```

**Sem CI custom necessário** — Vercel detecta `landing-v2/` como diretório de assets estáticos.

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| LCP acima de 2.5s por fonts | Média | Alto | Usar `font-display: swap`, preconnect |
| CLS por layout shift | Baixa | Médio | Dimensões explícitas em todos os containers |
| JS complexo que quebra mobile | Baixa | Alto | Teste em device real antes do QA gate |
| Vercel routing conflito com LP1 | Baixa | Alto | Testar routing config em preview antes de merge |

---

## Implementation Order (Story Sequence)

Conforme stories do PRD, a ordem técnica recomendada:

1. **Story 1.1** — Setup base: HTML boilerplate, tokens CSS, meta tags, Vercel routing
2. **Story 1.2** — Hero section: headline, CTAs, terminal animation
3. **Story 1.3** — Como funciona + Agents showcase
4. **Story 2.1** — Outcomes metrics + benefit cards
5. **Story 2.2** — Personas cards
6. **Story 2.3** — Social proof / testimonials
7. **Story 3.1** — CTA final + footer + Lighthouse QA

---

*Esta Architecture foi criada por Aria (@architect) a partir do PRD e Front-End Spec. Próximo: @pax valida todos os artefatos com po-master-checklist — [AIOAAA-18](/AIOAAA/issues/AIOAAA-18).*
