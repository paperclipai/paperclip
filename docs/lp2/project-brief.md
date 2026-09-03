# Project Brief: Paperclip × AIOX — Landing Page v2

**Versão:** 1.0
**Data:** 2026-03-28
**Autor:** Alex (@analyst)
**Issue:** [AIOAAA-14](/AIOAAA/issues/AIOAAA-14)
**Parent:** [AIOAAA-13](/AIOAAA/issues/AIOAAA-13)

---

## Executive Summary

A LP v2 é uma nova landing page para a colaboração Paperclip × AIOX com ângulo diferenciado da versão atual. Enquanto a LP1 fala com desenvolvedores técnicos usando linguagem CLI e foco em agentes/workflows, a LP2 fala com **CTOs, líderes de engenharia e founders não-técnicos** — usando linguagem de resultado de negócio, velocidade de entrega e ROI.

**Problema central:** Equipes de engenharia gastam mais tempo gerenciando trabalho do que executando. A LP2 posiciona Paperclip + AIOX como a forma de **escalar output sem escalar headcount**.

**Proposta de valor única:** "Seu time de IA. Sem overhead de gestão."

---

## Análise da LP1 (Baseline)

### O que a LP1 faz bem
- Visual forte (Dark Cockpit, lime/verde em preto)
- Demo de terminal com heartbeat run — convincente para devs
- Lista clara de capacidades técnicas (10+ agentes, SDC, QA Loop)
- Separação clara entre Paperclip e AIOX com split panel
- Stats concretos: 10+ agentes, 60+ componentes, 100% story-driven

### Gaps e limitações da LP1
- **Audiência estreita**: fala exclusivamente com devs técnicos
- **Nenhum metric de negócio**: sem menção a velocidade, custo, ROI
- **Jargão pesado**: SDC, heartbeat, checkout/release, run trail — incompreensível para não-devs
- **Angle único**: "duas plataformas + uma infraestrutura" — produto, não outcome
- **CTAs fracos**: "Começar gratuitamente" sem tensão ou urgência
- **Sem social proof**: sem depoimentos, logos, casos de uso reais
- **Sem pricing signal**: visitor não sabe se é enterprise, indie, grátis mesmo

---

## Problem Statement

### Situação atual do mercado
CTOs e líderes de engenharia enfrentam pressão crescente para entregar mais com menos. Headcount é caro e demorado. Ferramentas de AI coding (Cursor, Copilot) ajudam devs individualmente mas não resolvem o problema de coordenação e gestão de times.

### Dor principal do ICP da LP2
- **Gargalo de gestão**: PMs, Scrum Masters e tech leads gastam 30-40% do tempo em overhead de processo
- **Qualidade inconsistente**: sem QA automatizado, bugs escapam para produção
- **Onboarding lento**: novos devs levam semanas para ser produtivos
- **Escalar é caro**: dobrar output geralmente requer dobrar headcount

### Por que soluções existentes falham
- AI coding tools (Cursor, Copilot): ajudam o dev individual, não o time
- Project management tools (Jira, Linear): organizam trabalho humano, não executam com IA
- AI agents genéricos (AutoGPT, AgentOps): sem structure para desenvolvimento de software real
- Nenhuma plataforma combina **controle de processo** (Paperclip) + **framework de execução especializado** (AIOX)

---

## Proposed Solution

### Conceito central da LP2
**"Seu time de engenharia de IA. Pronto para trabalhar hoje."**

Em vez de vender "infraestrutura de agentes" (LP1), a LP2 vende **resultados tangíveis**:
- Features entregues mais rápido
- Menos bugs em produção
- Gestão de projeto sem overhead humano
- Time que nunca para, nunca pede aumento

### Diferenciador estratégico
LP1 = "o que é" (plataforma + framework)
LP2 = "o que você ganha" (outcomes de negócio)

### Proof points para a nova narrativa
- Do backlog ao deploy sem intervenção humana (quando configurado)
- QA automático com até 5 iterações self-healing
- Run trail completo — auditável por qualquer líder técnico
- Constitution formal — agentes não inventam, não desviam do escopo

---

## Target Users

### Segmento Primário: CTO / VP Engineering em startup (Série A-B)

**Perfil:**
- 10-50 engenheiros no time
- Pressão de board para acelerar roadmap
- Budget de ferramentas entre R$5k-50k/mês
- Já usa AI para coding individualmente, quer escalar

**Comportamento atual:**
- Gerencia com Linear ou Jira + retros semanais
- Tem tech lead sendo gargalo de revisão de código
- Considera contratar mas headcount está congelado
- Lê newsletters de engenharia, segue influencers de eng. no X

**Dores específicas:**
- "Meu time passa mais tempo em planning do que em coding"
- "Cada PR leva 2 dias para ser revisado"
- "Onboarding de novo dev demora 3 meses"

**Jobs-to-be-done:**
- Entregar o roadmap Q2 sem contratar mais pessoas
- Reduzir o número de bugs que chegam em produção
- Ter rastreabilidade para mostrar ao board o que o time fez

---

### Segmento Secundário: Founder não-técnico com time de devs

**Perfil:**
- 2-5 devs contratados ou freelancers
- Não sabe ler código mas quer visibilidade do progresso
- Precisa de previsibilidade para planejar lançamentos
- Budget limitado, cada dev é investimento alto

**Comportamento atual:**
- Depende completamente de devs para saber o status
- Tem histórico de features atrasadas ou com bugs
- Já tentou "vibe coding" mas sem escalabilidade

**Dores específicas:**
- "Não tenho visibilidade do que o time de dev está fazendo"
- "Cada bug em produção me custa cliente e reputação"
- "Meu dev mais sênior é um single point of failure"

**Jobs-to-be-done:**
- Ter visibilidade do progresso sem depender de stand-ups diários
- Entregar features com mais previsibilidade
- Reduzir dependência de indivíduos específicos

---

## Goals & Success Metrics

### Objetivos de negócio
- **Conversão**: Taxa de signup >= 3% de visitantes únicos (LP1 baseline não medido)
- **Qualificação**: 60% dos signups sendo de ICP (CTO/founder, não dev júnior)
- **Engajamento**: Tempo médio na página >= 2 min (vs benchmark de LP de AI tool ~90s)
- **Clareza**: Teste de compreensão — visitante explica o produto em 1 frase após 30s

### Métricas de usuário
- Scroll depth >= 70% até seção de CTA
- Click-through no CTA primário >= 5%
- Demo/video play rate (se incluído) >= 25%

### KPIs de produto
- **Activação**: % de signups que conectam primeiro agente em 24h >= 40%
- **Retenção 7 dias**: >= 60% voltam após primeiro signup
- **NPS qualitativo**: Mensagens de founders/CTOs nas primeiras 30 dias

---

## MVP Scope

### Core da LP2 (Must Have)

- **Hero novo**: headline focado em outcome, não em produto ("Ship 3x mais rápido com seu time de IA" vs "Agentes de IA. Orquestrados.")
- **Social proof section**: 3-5 depoimentos ou logos de early adopters (podem ser mockados para MVP)
- **Outcome metrics**: números de negócio concretos (ex: "Média de 2.5x mais PRs por sprint")
- **Seção "Para quem é"**: personas claras — CTOs, founders, eng leads
- **Pricing signal**: pelo menos indicar free tier vs paid, mesmo sem tabela completa
- **Demo/video**: screen recording de 60s mostrando um ciclo completo (não apenas terminal)
- **CTA reformulado**: com urgência ou exclusividade ("Acesso antecipado" ou "Beta fechado")
- **FAQ**: responder objeções de líderes não-técnicos (segurança, custo, curva de aprendizado)

### Fora do escopo para MVP
- Internacionalização (EN/ES) — LP2 é pt-BR first
- Integração com CRM/analytics complexo
- Chat widget ou chatbot
- Blog ou conteúdo editorial
- Comparativo detalhado com competidores (pode ser seção futura)
- Dashboard de métricas em tempo real

### MVP Success Criteria
LP2 está pronta quando: visitor de perfil CTO/founder consegue, em 30 segundos, responder "o que este produto faz por mim?" — sem ter lido documentação técnica.

---

## Post-MVP Vision

### Phase 2 Features
- Versão em inglês para expansão global
- Seção de casos de uso por vertical (fintech, saas, e-commerce)
- ROI Calculator interativo ("Quanto você economiza substituindo 1 tech lead por AIOX?")
- Video demo completo (3-5 min) com narração
- Integração com Paperclip signup flow com onboarding personalizado por persona

### Long-term Vision
LP2 evolui para uma **microsite de produto** com páginas dedicadas por persona, conteúdo de educação (como funciona AI-driven dev) e ferramentas interativas de qualificação — posicionando Paperclip × AIOX como categoria nova ("Autonomous Engineering Platform").

### Expansion Opportunities
- Versão para squads (ex: time de design + AIOX)
- LP específica para agências que querem vender capacidade extra
- Landing page por vertical de mercado (fintech, healthtech, etc.)

---

## Technical Considerations

### Platform Requirements
- **Target Platforms:** Web (desktop-first, mobile-responsive)
- **Browser/OS Support:** Chrome, Safari, Firefox — últimas 2 versões. Sem IE.
- **Performance Requirements:** LCP < 2.5s, CLS < 0.1, TBT < 200ms

### Technology Preferences
- **Frontend:** HTML/CSS/JS puro (como LP1) ou Next.js estático para facilitar iteração futura
- **Hosting/Infrastructure:** Vercel (já configurado para LP1 — `landing/.gitignore` + config existente)
- **Analytics:** Posthog ou Plausible (privacy-first, sem cookie banner)
- **Fonts:** Manter Geist + Geist Mono (consistência de marca)

### Architecture Considerations
- **Repositório:** Mesma estrutura que LP1 (`landing/`), mas em subpasta `landing-v2/` para não quebrar LP1
- **Design:** Manter Dark Cockpit tokens mas com layout distinto — não é "LP1 reformatada"
- **Assets:** Novos screenshots/mockups focados em dashboard (não terminal)
- **SEO:** Meta tags diferenciadas para não canibalizar LP1

---

## Constraints & Assumptions

### Constraints
- **Budget:** Recursos internos — sem contratação externa
- **Timeline:** LP2 deve ser entregável em 1-2 sprints do ciclo AIOX
- **Resources:** Time AIOX completo (@pm, @sm, @dev, @qa, @devops)
- **Technical:** Sem backend custom — LP estática com formulário externo (Paperclip signup)

### Key Assumptions
- O ICP de LP2 (CTO/founder) é um segmento real e subatendido pela LP1
- Social proof pode ser construído com early adopters do próprio Paperclip
- "Outcome language" converte melhor que "feature language" para esse perfil
- O design dark pode ser mantido — não é o problema da LP1, é o messaging

---

## Risks & Open Questions

### Key Risks
- **Risco de mensagem**: nova audiência pode não ressoar sem pesquisa qualitativa real — *mitigação: prototipar hero section e testar com 5 pessoas antes de build*
- **Risco de identidade**: LP2 com angle muito diferente pode criar confusão entre LP1 e LP2 — *mitigação: definir claramente qual URL/domínio serve qual audiência*
- **Risco de social proof**: sem depoimentos reais, seção fica vazia ou mockada demais — *mitigação: capturar quotes de beta users antes do launch*
- **Risco técnico**: LP estática sem backend limita personalização dinâmica por persona — *mitigação: aceitar limitação para MVP, expandir em Phase 2*

### Open Questions
- Qual URL servirá LP2? Subdomínio? Path `/v2`? Novo domínio?
- Temos permissão para usar logos/nomes de empresas early adopters?
- O signup flow atual do Paperclip suporta captura de "persona" (CTO vs dev)?
- Existe algum dado de conversão da LP1 que sirva como baseline?
- AIOX PRO tem pricing definido que pode ser mencionado?

### Areas Needing Further Research
- Análise de 3-5 LPs concorrentes com angle de "autonomous dev team" (ex: Devin, SWE-agent, Cognition)
- Pesquisa qualitativa com 3-5 CTOs/founders sobre como eles descobrem ferramentas como esta
- Benchmarks de conversão para ferramentas de dev B2B SaaS ($50-500/mês range)

---

## Appendices

### A. Análise da LP1 — Seções Identificadas

| Seção | Label | Headline | Ângulo |
|-------|-------|----------|--------|
| Hero | — | "Agentes de IA. Orquestrados." | Produto/infra |
| About | [01] A colaboração | "Duas plataformas. Um objetivo." | Produto |
| Features | [02] Capacidades | "O que você ganha com a integração." | Feature list |
| How it works | [03] Workflow | "Do backlog ao deploy. Automaticamente." | Processo técnico |
| Terminal demo | — | heartbeat run | Dev experience |
| Agents | — | "10 especialistas. Um objetivo." | Roster técnico |
| CTA | — | "Pronto para construir com inteligência real?" | Genérico |

### B. Mapeamento de Ângulos por Audiência

| Audiência | LP1 (atual) | LP2 (proposta) |
|-----------|-------------|----------------|
| Dev sênior | ✅ Match perfeito | ⚠️ Pode parecer básico |
| Tech Lead | ✅ Bom fit | ✅ Bom fit |
| CTO / VP Eng | ⚠️ Muito técnico | ✅ Match perfeito |
| Founder não-técnico | ❌ Inacessível | ✅ Match perfeito |
| Investidor/Board | ❌ Incompreensível | ✅ Match bom |

### C. Referências
- LP1 existente: `landing/index.html`
- Template de project brief: `.aiox-core/product/templates/project-brief-tmpl.yaml`
- Issue parent: [AIOAAA-13](/AIOAAA/issues/AIOAAA-13)
- Goal: "Usar aiox com excelencia"

---

## Next Steps

1. **@pm (Morgan)**: Revisar este brief, validar ângulo e criar PRD da LP2
2. **@ux-design-expert (Uma)**: Criar wireframes de hero section e seção de personas
3. **Pesquisa**: Capturar 3-5 quotes de early adopters do Paperclip para social proof
4. **@sm (River)**: Criar stories do epic LP2 a partir do PRD aprovado

---

*Este Project Brief foi criado por Alex (@analyst) como output da task `analyst-project-brief` (greenfield-fullstack Phase 1). Próximo passo: handoff para @pm para geração de PRD.*
