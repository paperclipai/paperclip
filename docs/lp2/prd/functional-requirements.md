# Functional Requirements

## FR-1: Página Base e Setup

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

## FR-2: Hero Section

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

## FR-3: Seção "Como funciona"

**FR-3.1 — Workflow Steps**
- 4 passos visuais: PM define → SM cria stories → Dev implementa → QA + Deploy
- Cada passo com ícone, título (≤ 4 palavras) e descrição (≤ 20 palavras)
- Conexão visual entre os passos (linha ou seta)

**FR-3.2 — Agentes showcaase**
- Grid ou lista de 6 agentes principais (não todos os 10)
- Agentes: @pm, @dev, @qa, @devops, @architect, @sm
- Cada card: nome, role, capability principal (1 linha)

---

## FR-4: Seção "Outcomes" (ex-Features)

**FR-4.1 — Metrics row**
- 3-4 números de impacto: ex. "3x mais PRs/sprint", "0 bugs em produção por QA Gate", "100% story-driven"
- Grande, bold, destacado

**FR-4.2 — Benefit cards**
- 3 cards: Velocidade | Qualidade | Previsibilidade
- Cada card: título, descrição 2-3 linhas, ícone

---

## FR-5: Seção "Para quem é"

**FR-5.1 — Persona cards**
- 2 personas: CTO/VP Eng | Founder não-técnico
- Cada card: avatar emoji/ícone, título do cargo, dor principal (quote ou bullet), como AIOX resolve

**FR-5.2 — Subheadline da seção**
- "Independente do seu perfil técnico, o AIOX trabalha para você"

---

## FR-6: Seção de Social Proof

**FR-6.1 — Stats de projeto**
- GitHub stars (fetch via API ou hardcoded)
- Número de agentes disponíveis (10+)
- Número de workflows prontos (15+)

**FR-6.2 — Testemunhos (MVP: pode ser mockado)**
- 2-3 quotes com nome, cargo, empresa
- Se não houver quotes reais: substituir por "Early Access" badges

---

## FR-7: CTA Section

**FR-7.1 — CTA final**
- Headline: "Seu time de IA começa hoje"
- Subheadline: 1 frase
- CTA primário com destaque visual (fundo lime, texto escuro)
- Link para signup do Paperclip

**FR-7.2 — Urgência/exclusividade (opcional)**
- Badge "Beta fechado" ou "Acesso antecipado" se aplicável

---

## FR-8: Footer

**FR-8.1 — Links**
- Docs, GitHub, Discord (ou Slack), Paperclip App
- Sem links quebrados

**FR-8.2 — Copyright**
- "© 2026 Paperclip × AIOX"

---
