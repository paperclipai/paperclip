# PRD: AIOX Landing Page v2 — "Ship with AI Agents"

**Version:** 1.0
**Date:** 2026-03-28
**Author:** Morgan (@pm)
**Issue:** [AIOAAA-15](/AIOAAA/issues/AIOAAA-15)
**Parent:** [AIOAAA-13](/AIOAAA/issues/AIOAAA-13)
**Input:** `docs/lp2/project-brief.md`
**Status:** Approved

---

## Product Overview

### Vision
Criar uma landing page que converte líderes técnicos (CTOs, VP Engineering, founders com time de dev) em usuários do Paperclip × AIOX, comunicando o valor em linguagem de resultado de negócio — não de feature técnica.

### Problem
A LP1 atual (`landing/index.html`) fala exclusivamente com devs técnicos. Líderes de negócio que avaliam ferramentas de AI para seus times não conseguem entender a proposta de valor em menos de 30 segundos.

### Solution
LP v2 com ângulo "Autonomous Engineering Platform": foca em outcomes (velocidade, qualidade, previsibilidade) e posiciona Paperclip + AIOX como time de IA gerenciado, não como infraestrutura para devs configurarem.

---

## Epic Structure

### Epic 1: Foundation & Hero (LP2-E1)
Estrutura base da página e seção hero que comunica o valor principal em < 10 segundos.

### Epic 2: Proof & Social (LP2-E2)
Seções que constroem credibilidade: métricas, workflow demo, social proof.

### Epic 3: Conversion (LP2-E3)
Seções de CTA, FAQ e footer otimizadas para conversão.

---

## Functional Requirements

### FR-1: Página Base e Setup

**FR-1.1 — Estrutura de arquivos**
- Diretório: `landing-v2/`
- Arquivos: `index.html`, `styles.css` (opcional — pode ser inline), `assets/`
- Deploy: Vercel (configuração em `vercel.json` existente)

**FR-1.2 — Performance**
- LCP < 2.5s
- CLS < 0.1
- TBT < 200ms
- Total page size < 200KB (sem assets de vídeo)

**FR-1.3 — Responsive**
- Desktop-first (1280px base)
- Mobile breakpoint: 768px
- Sem scroll horizontal em nenhum viewport

**FR-1.4 — Acessibilidade**
- Contraste mínimo WCAG AA
- Semântica HTML correta (h1-h6 em ordem, landmarks)
- Alt text em todas as imagens

---

### FR-2: Hero Section

**FR-2.1 — Headline**
- Máximo 8 palavras
- Focada em outcome: ex. "Ship 3x mais rápido com seu time de IA"
- Font size >= 48px desktop, >= 32px mobile

**FR-2.2 — Subheadline**
- 1-2 frases explicando o mecanismo
- Linguagem de resultado, não de feature
- Máximo 20 palavras

**FR-2.3 — CTAs**
- CTA primário: "Começar gratuitamente" → link para Paperclip signup
- CTA secundário: "Ver no GitHub" → github.com/paperclipai
- Ambos visíveis above the fold em desktop e mobile

**FR-2.4 — Hero Visual**
- Mockup animado do dashboard Paperclip OU screenshot do workflow em execução
- Alternativa: animação CSS mostrando o ciclo SM → Dev → QA → DevOps

**FR-2.5 — Badge de credibilidade**
- Ex: "Open Source • Claude Code Native • Story-Driven"
- Abaixo dos CTAs

---

### FR-3: Seção "Como funciona"

**FR-3.1 — Workflow Steps**
- 4 passos visuais: PM define → SM cria stories → Dev implementa → QA + Deploy
- Cada passo com ícone, título (≤ 4 palavras) e descrição (≤ 20 palavras)
- Conexão visual entre os passos (linha ou seta)

**FR-3.2 — Agentes showcaase**
- Grid ou lista de 6 agentes principais (não todos os 10)
- Agentes: @pm, @dev, @qa, @devops, @architect, @sm
- Cada card: nome, role, capability principal (1 linha)

---

### FR-4: Seção "Outcomes" (ex-Features)

**FR-4.1 — Metrics row**
- 3-4 números de impacto: ex. "3x mais PRs/sprint", "0 bugs em produção por QA Gate", "100% story-driven"
- Grande, bold, destacado

**FR-4.2 — Benefit cards**
- 3 cards: Velocidade | Qualidade | Previsibilidade
- Cada card: título, descrição 2-3 linhas, ícone

---

### FR-5: Seção "Para quem é"

**FR-5.1 — Persona cards**
- 2 personas: CTO/VP Eng | Founder não-técnico
- Cada card: avatar emoji/ícone, título do cargo, dor principal (quote ou bullet), como AIOX resolve

**FR-5.2 — Subheadline da seção**
- "Independente do seu perfil técnico, o AIOX trabalha para você"

---

### FR-6: Seção de Social Proof

**FR-6.1 — Stats de projeto**
- GitHub stars (fetch via API ou hardcoded)
- Número de agentes disponíveis (10+)
- Número de workflows prontos (15+)

**FR-6.2 — Testemunhos (MVP: pode ser mockado)**
- 2-3 quotes com nome, cargo, empresa
- Se não houver quotes reais: substituir por "Early Access" badges

---

### FR-7: CTA Section

**FR-7.1 — CTA final**
- Headline: "Seu time de IA começa hoje"
- Subheadline: 1 frase
- CTA primário com destaque visual (fundo lime, texto escuro)
- Link para signup do Paperclip

**FR-7.2 — Urgência/exclusividade (opcional)**
- Badge "Beta fechado" ou "Acesso antecipado" se aplicável

---

### FR-8: Footer

**FR-8.1 — Links**
- Docs, GitHub, Discord (ou Slack), Paperclip App
- Sem links quebrados

**FR-8.2 — Copyright**
- "© 2026 Paperclip × AIOX"

---

## Non-Functional Requirements

**NFR-1: Performance**
- Core Web Vitals passando em Green no Lighthouse
- Fontes carregadas via Google Fonts (preconnect configurado)
- Imagens otimizadas (WebP quando possível)

**NFR-2: SEO**
- Title: "AIOX — Ship com seu Time de IA | Paperclip"
- Description: ≤ 155 chars, focada em outcome
- OG tags para compartilhamento social

**NFR-3: Design Consistency**
- Usar tokens da LP1: `--bb-lime`, `--bg-void`, `--text-primary`, etc.
- Fonte: Geist + Geist Mono
- Não usar frameworks CSS externos

**NFR-4: Maintainability**
- CSS organizado em seções comentadas
- Nenhuma dependência externa além de Google Fonts
- HTML semântico e limpo

---

## Epic e Stories Breakdown

### Epic 1: Foundation & Hero (LP2-E1)

**Story 1.1 — Setup do diretório e estrutura base**
- AC: `landing-v2/index.html` criado com HTML5 boilerplate
- AC: Design tokens CSS copiados/adaptados da LP1
- AC: Meta tags (title, description, OG) configuradas
- AC: Vercel routing configurado para `/v2`

**Story 1.2 — Seção Hero**
- AC: Headline > 48px desktop, > 32px mobile
- AC: Dois CTAs visíveis above the fold
- AC: Hero visual implementado (mockup ou animação)
- AC: Badge de credibilidade presente

**Story 1.3 — Seção "Como funciona" + Workflow**
- AC: 4 workflow steps renderizados
- AC: 6 agent cards presentes
- AC: Responsivo em mobile

### Epic 2: Proof & Social (LP2-E2)

**Story 2.1 — Seção Outcomes/Metrics**
- AC: 3-4 métricas de impacto exibidas
- AC: 3 benefit cards (Velocidade, Qualidade, Previsibilidade)

**Story 2.2 — Seção "Para quem é"**
- AC: 2 persona cards implementados
- AC: Cada card com dor + solução

**Story 2.3 — Seção Social Proof**
- AC: Stats de projeto exibidos
- AC: Testemunhos ou early access badges

### Epic 3: Conversion (LP2-E3)

**Story 3.1 — CTA Section + Footer**
- AC: CTA final com destaque visual lime
- AC: Footer com todos os links corretos
- AC: Página passa no Lighthouse (Performance > 90)

---

## Constraints

**CON-1:** HTML/CSS/JS puro — sem React, Vue, Angular, ou qualquer framework JS
**CON-2:** Sem backend — LP completamente estática
**CON-3:** Deploy em Vercel usando configuração existente em `landing/vercel.json`
**CON-4:** Design system AIOX: dark (#000), lime (#D1FF00), Geist font — não mudar brand

---

## Out of Scope

- Internacionalização (EN/ES)
- Blog ou conteúdo editorial
- Chat widget
- Pricing page completa
- Dashboard de analytics em tempo real
- Comparativo detalhado com competidores

---

## Dependencies

- Vercel account e configuração: já existente
- Google Fonts (Geist): CDN externo, ok
- Design tokens: extrair da `landing/index.html` existente
- Paperclip signup URL: necessário antes de Story 1.2
- GitHub repo URL: hardcoded como `github.com/paperclipai`

---

*Este PRD foi criado por Morgan (@pm) a partir do Project Brief em `docs/lp2/project-brief.md`. Próximo: @uma cria a Front-End Spec em `docs/lp2/front-end-spec.md`.*
