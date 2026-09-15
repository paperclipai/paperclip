# Front-End Specification: AIOX Landing Page v2

**Version:** 1.0
**Date:** 2026-03-28
**Author:** Uma (@ux-design-expert)
**Issue:** [AIOAAA-16](/AIOAAA/issues/AIOAAA-16)
**Parent:** [AIOAAA-13](/AIOAAA/issues/AIOAAA-13)
**Input:** `docs/lp2/prd.md`

---

## Design System

### Tokens (herdar da LP1)

```css
:root {
  /* Brand */
  --bb-lime: oklch(93.4% .2264 121.95);     /* #D1FF00 — CTA, highlights */
  --bb-dark: oklch(11.49% 0 0);              /* near-black */
  --bb-cream: oklch(96.39% .0158 106.69);   /* light text */
  --bb-muted: oklch(79.52% 0 0);            /* secondary text */

  /* Backgrounds */
  --bg-void: #000000;
  --bg-base: #0a0a0a;
  --bg-surface: oklch(16.93% .0041 285.95);
  --bg-elevated: oklch(18.4% .0081 118.61);

  /* Text */
  --text-primary: oklch(99.52% .0235 106.82);
  --text-secondary: oklch(69.27% 0 0);
  --text-muted: oklch(42.76% 0 0);

  /* Borders */
  --border: oklch(28.58% .0036 286.17);
  --border-strong: #D1FF0033;
  --ring: #D1FF0080;

  /* Glow */
  --lime-glow: #D1FF0040;
}
```

### Typography

| Element | Font | Weight | Size (Desktop) | Size (Mobile) |
|---------|------|--------|----------------|----------------|
| H1 (hero) | Geist | 700 | 64-80px | 36-44px |
| H2 (section) | Geist | 600 | 40-48px | 28-32px |
| H3 (card) | Geist | 600 | 24px | 20px |
| Body | Geist | 400 | 16-18px | 15-16px |
| Caption/badge | Geist Mono | 500 | 12-14px | 12px |

### Spacing System

- Base unit: 8px
- Section padding: 80px top/bottom (desktop), 48px (mobile)
- Max content width: 1200px
- Card gap: 24px
- Element gap: 16px

### Breakpoints

- Desktop: 1280px (base design)
- Tablet: 768px
- Mobile: 375px

---

## Layout Overview

```
┌─────────────────────────────────────────┐
│ NAVBAR (sticky, blur backdrop)          │
│ Logo | Nav links | CTA button           │
├─────────────────────────────────────────┤
│ HERO SECTION                            │
│ Eyebrow badge                           │
│ H1: "Ship com seu Time de IA"           │
│ Subheadline (2 linhas)                  │
│ [CTA Primário] [GitHub]                 │
│ Hero visual / animation                 │
├─────────────────────────────────────────┤
│ SOCIAL PROOF BAR                        │
│ Stars | Agentes | Workflows | Stories   │
├─────────────────────────────────────────┤
│ COMO FUNCIONA (4 steps)                 │
│ Step 1 → Step 2 → Step 3 → Step 4      │
├─────────────────────────────────────────┤
│ AGENTS SHOWCASE (6 cards)              │
├─────────────────────────────────────────┤
│ OUTCOMES (metrics + 3 benefit cards)    │
├─────────────────────────────────────────┤
│ PARA QUEM É (2 persona cards)           │
├─────────────────────────────────────────┤
│ TESTIMONIALS / SOCIAL PROOF             │
├─────────────────────────────────────────┤
│ CTA FINAL                               │
├─────────────────────────────────────────┤
│ FOOTER                                  │
└─────────────────────────────────────────┘
```

---

## Section Specifications

### 1. Navbar

**Layout:** Horizontal, sticky ao scroll
**Background:** `--bg-void` com `backdrop-filter: blur(12px)` quando scrolled
**Height:** 64px
**Content:**
- Left: Logo "Paperclip × AIOX" (text ou SVG)
- Center: Links: Docs | GitHub | Discord
- Right: "Começar grátis" button (lime background, dark text)

**Border:** 1px solid `--border` no bottom

**Mobile:** Hamburger menu (✕/≡ toggle), links em drawer lateral ou dropdown

---

### 2. Hero Section

**Layout:** Centralizado, full-width, min-height: 100vh
**Background:** `--bg-void` com grid sutil ou gradient radial lime-glow no centro

**Stack (vertical, centered):**
1. **Eyebrow badge:** `Open Source • Claude Code Native • Story-Driven` — pill com borda lime, font mono 13px
2. **H1:** 2 linhas, gradient text (branco → lime): `"Ship 3x mais rápido"` / `"com seu Time de IA"`
3. **Subheadline:** `"Paperclip orquestra. AIOX executa. Seu produto cresce."` — 18px, text-secondary
4. **CTAs:** flex-row, gap 16px
   - Primary: Pill button, background lime, text dark, `font-weight: 700` — "Começar gratuitamente →"
   - Secondary: Outline button, border lime/30, text cream — "⭐ GitHub"
5. **Trust badges:** row de 3 badges em mono: `story-driven` | `qa-gate automático` | `deploy via agente`
6. **Hero Visual:** Abaixo dos CTAs, ~600px width
   - Mockup animado: janela de terminal mostrando um ciclo SM → Dev → QA → Deploy em typewriter animation

**Animations:**
- Fade-in stagger (100ms delay entre cada elemento)
- Terminal typewriter loop (3s cycle, 1s pause)

---

### 3. Social Proof Bar

**Layout:** Full-width, dark band (`--bg-surface`)
**Content:** 4 stats em grid 4-col (2-col mobile)

| Stat | Label |
|------|-------|
| 10+ | Agentes especializados |
| 60+ | Componentes AIOX |
| 5 | Workflows prontos |
| 100% | Story-driven |

**Style:** Número em H2 lime, label em caption text-secondary

---

### 4. Como Funciona

**Layout:** Grid 4-col com connecting line/arrows (desktop), vertical stack (mobile)
**Section title:** H2 centered: `"Do backlog ao deploy. Em ciclos."`

**4 Steps:**

| # | Ícone | Título | Descrição |
|---|-------|--------|-----------|
| 01 | 📋 | PM define | Morgan cria PRD e épicos a partir de seus objetivos |
| 02 | 📝 | SM cria stories | River fragmenta em stories testáveis, prontas para dev |
| 03 | ⚙️ | Dev implementa | Dex implementa story por story com QA automático |
| 04 | 🚀 | DevOps entrega | Gage faz push, abre PR, monitora o deploy |

**Step card:**
- Background: `--bg-elevated`
- Border: `--border`
- Número: Geist Mono, lime, 12px, uppercase
- Ícone: 32px emoji ou SVG
- Título: H3, 20px
- Descrição: body, 15px, text-secondary

**Connector:** horizontal line com arrow (desktop), vertical dotted line (mobile)

---

### 5. Agents Showcase

**Layout:** Grid 3-col (desktop), 2-col (tablet), 1-col (mobile)
**Section title:** H2: `"Seu time especializado. Sem contratar ninguém."`

**6 Agent Cards:**

| Agente | Emoji | Role | Capability |
|--------|-------|------|------------|
| @morgan | 📊 | Product Manager | Define épicos, escreve PRDs, valida requirements |
| @river | 🌊 | Scrum Master | Cria stories, mantém backlog, sprint planning |
| @dex | ⚡ | Developer | Implementa código, testes, self-healing com CodeRabbit |
| @quinn | 🔍 | QA Engineer | QA Gate 7-check, QA Loop até 5 iterações |
| @gage | 🚀 | DevOps | Git push exclusivo, PR, CI/CD, deploy |
| @aria | 🏗️ | Architect | System design, tech decisions, complexity assessment |

**Card style:**
- Background: `--bg-surface`
- Border: `--border` (hover: `--border-strong`)
- Top accent: 2px `--bb-lime` no left border ou top
- Avatar: emoji 40px em circle `--bg-elevated`
- Name: `@name` em mono lime
- Role: H3 branco
- Capability: body text-secondary, 2-3 linhas

---

### 6. Outcomes Section

**Layout:** Stack vertical com metrics row no topo, benefit cards abaixo

**Metrics Row (4 cols):**

| Número | Unidade | Descrição |
|--------|---------|-----------|
| 3x | mais PRs | por sprint com AIOX |
| 0 | bugs críticos | que passam pelo QA Gate |
| 5 | auto-iterações | QA Loop auto-healing |
| 100% | rastreável | audit trail completo |

**Benefit Cards (3 cols):**

| Card | Ícone | Título | Descrição |
|------|-------|--------|-----------|
| Velocidade | ⚡ | Ship 3x mais rápido | Stories prontas para dev em horas, não dias. Deploy sem esperar um humano liberar. |
| Qualidade | 🛡️ | Zero bugs em produção | QA Gate automático com 7 checks. Self-healing loop antes de qualquer PR ser aprovado. |
| Previsibilidade | 📈 | Sabe o que foi feito | Run trail completo. Audit log de cada decisão do agente. Rastreabilidade total para qualquer stakeholder. |

---

### 7. Para Quem É

**Layout:** Grid 2-col (desktop), stack (mobile)
**Section title:** H2: `"Para qualquer líder. Com qualquer perfil."`

**Persona Card 1 — CTO / VP Engineering:**
- Avatar: 🎯
- Título: "CTO / VP Engineering"
- Badge: "Startup Série A-B"
- Pain: `"Meu time passa mais tempo em planning do que em coding."`
- Solution bullets:
  - ✓ SDC automatiza sprint planning
  - ✓ QA Gate elimina bugs antes do PR
  - ✓ Run trail para apresentar ao board

**Persona Card 2 — Founder não-técnico:**
- Avatar: 🚀
- Título: "Founder / CEO"
- Badge: "Time de 2-10 devs"
- Pain: `"Não sei o que meu time de dev está fazendo."`
- Solution bullets:
  - ✓ Visibilidade de progresso sem stand-ups
  - ✓ Features entregues com previsibilidade
  - ✓ Menos dependência de heróis individuais

**Card style:**
- Background: gradient `--bg-surface → --bg-elevated`
- Border: `--border-strong`
- Avatar em circle lime-glow bg
- Pain em itálico, borda esquerda lime, font-size 15px

---

### 8. Testimonials

**Layout:** Grid 2-col (desktop) ou slider (mobile)
**Section title:** H2: `"O que dizem os early adopters"`

**3 Quote Cards (MVP: pode ser mockado ou substituído por "early access"):**
- Quote em aspas grandes (lime)
- Avatar + Nome + Cargo/empresa
- Background: `--bg-elevated`

**Fallback se sem quotes:** "Early Access" badge section com "Seja dos primeiros a usar AIOX" + form de e-mail

---

### 9. CTA Final

**Layout:** Full-width, centered, padding 120px
**Background:** Gradient radial com lime-glow no centro sobre `--bg-void`

**Content:**
- H2: `"Seu time de IA começa hoje."`
- Subheadline: `"Paperclip + AIOX. Open source. Sem vendor lock-in."`
- CTA button: grande, lime background, dark text, 56px height
  - Texto: "Começar gratuitamente →"
- Secondary: `"Ou explore o GitHub →"` link

---

### 10. Footer

**Layout:** 3-col (desktop), stack (mobile)
**Background:** `--bg-base`, border-top `--border`

**Cols:**
1. **Brand:** Logo + tagline curta + "© 2026 Paperclip × AIOX"
2. **Links:** Docs | GitHub | Discord | Paperclip App
3. **Créditos:** "Construído com AIOX Framework" (meta-referência 😄)

---

## Animations & Interactions

### Hero Terminal Animation
```
Typewriter loop:
1. "@river *create-story → LP2 Story 1.1 criada [Draft]" (2s)
2. "@dex *implement → 14 arquivos modificados, 0 erros" (2s)
3. "@quinn *qa-gate → PASS — 7/7 checks [InReview]" (2s)
4. "@gage *push → PR #42 aberto, Vercel deploy ✓" (2s)
5. [reset, 1s pause]
```

### Scroll Animations
- Section titles: `translateY(20px) → 0` com `opacity: 0 → 1` on viewport enter
- Cards: stagger 100ms
- Usar `IntersectionObserver` (sem biblioteca externa)

### Hover States
- Buttons: `transform: translateY(-2px)`, glow lime
- Agent cards: border color `--bb-lime`, `box-shadow: 0 0 20px var(--lime-glow)`
- Persona cards: subtle scale (1.01)

---

## Implementation Notes

### Fonts (Google Fonts)
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
```

### CSS Architecture
- Arquivo único `landing-v2/index.html` (inline styles) OU `landing-v2/styles.css` separado
- Seções comentadas: `/* === HERO === */`, `/* === HOW IT WORKS === */`, etc.
- Variáveis CSS: todos os tokens em `:root`

### JavaScript (mínimo)
- `IntersectionObserver` para scroll animations
- Typewriter effect (loop)
- Hamburger menu mobile
- Nenhuma lib externa (sem jQuery, GSAP, etc.)

---

*Esta Front-End Spec foi criada por Uma (@ux-design-expert) a partir do PRD em `docs/lp2/prd.md`. Próximo: @aria cria a Architecture em `docs/lp2/architecture.md`.*
