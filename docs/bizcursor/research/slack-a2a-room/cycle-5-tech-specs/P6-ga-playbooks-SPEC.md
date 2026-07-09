# P6 — GA da Conference Room, Coolify, Playbooks Verticais e Anti-Washing

> **Versão:** 1.0  
> **Data:** 2026-07-09  
> **Ciclo:** 5 — Tech specs  
> **Repo de implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **Pré-requisitos:** P0–P5 Must fechados (métricas P5; memória só se spike GO — senão defer documentado)  
> **Personas docs:** Sofia (Operator) primária; Board secundário  
> **Confiança:** Alta em checklist Coolify/flag; média em playbooks (conteúdo GTM, iterável)

---

## 1. Contexto

### 1.1 Por que P6 existe

Até P5 a Conference Room Slack+A2A vive atrás de `enableConferenceRoomChat` (**experimental**). P6 **gradua** o produto para uso GA em instâncias self-hosted (Coolify), com:

1. Flag / settings de graduação (experimental → GA default-on ou default-off documentado).
2. Checklist operacional Coolify (auth, adapters, secrets, smoke).
3. **Playbooks verticais** beachhead: Software House + Support Ops (Cycle 3).
4. Docs para **Sofia** (linguagem não técnica).
5. **Anti-washing checklist** (Gartner/McKinsey) — obrigatório em pitch e DoD de piloto.

### 1.2 O que “GA” significa aqui

| GA é | GA não é |
|------|----------|
| Feature estável no fork deployado, documentada, com kill-switch | SLA enterprise multi-region |
| Piloto Software House executável com DoD mensurável | Claim “autonomia 80%” |
| Support Ops playbook híbrido honesto | “Substitui 700 FTEs” |
| Flag fora de “Experimental” **ou** experimental com label “Stable preview” explícito | Remover todos os feature flags de uma vez sem rollback |

### 1.3 Decisões herdadas

- Beachhead: **Software houses**; secundário **Support Ops**.
- Marketing ROAS / voice recruiting Jabarian: **fora** dos playbooks de valor causal.
- Adapters suportados no contrato Operator: `cursor_cloud`, `opencode_local`.
- BizCursor desktop Room: pausado; docs podem mencionar “web Paperclip”.

---

## 2. Requisitos funcionais (RF-P6-XX)

| ID | Requisito | MoSCoW |
|----|-----------|--------|
| **RF-P6-01** | Definir política de graduação da flag `enableConferenceRoomChat` (ver §6.2) | Must |
| **RF-P6-02** | UI de settings: remover ou relabel “Experimental” conforme política; kill-switch permanece | Must |
| **RF-P6-03** | Checklist Coolify GA (doc + script/manual smoke) versionada no repo | Must |
| **RF-P6-04** | Playbook **Software House** (cenários SH-1..SH-3 Cycle 3) em docs | Must |
| **RF-P6-05** | Playbook **Support Ops** (CS-1..CS-2 híbrido) em docs | Must |
| **RF-P6-06** | Guia Sofia (PT-BR): como `@`, silent, “precisa de você”, custo, quando chamar Board | Must |
| **RF-P6-07** | Anti-washing checklist (obrigatória) linkada em README/playbooks | Must |
| **RF-P6-08** | Runbook Board: deploy, budgets, roles, rollback flag | Must |
| **RF-P6-09** | Nota de release / CHANGELOG fork com breaking changes Room | Should |
| **RF-P6-10** | Template de piloto 30d (métricas P5 + DoD Cycle 3) | Should |
| **RF-P6-11** | Playbook Recruiting ops (sem voice claim) | Could |
| **RF-P6-12** | Vídeo/GIF walkthrough Sofia | Could |

---

## 3. Requisitos não funcionais

| ID | Requisito | Métrica |
|----|-----------|---------|
| **RNF-P6-01** | Rollback | Desligar flag restaura UI pré-Room em &lt; 1 min (sem migrate destrutiva) |
| **RNF-P6-02** | Docs | PT-BR para Sofia; EN opcional técnico |
| **RNF-P6-03** | Segurança prod | `deploymentMode` ≠ `local_trusted` exposto; Better Auth / board keys |
| **RNF-P6-04** | Adapters | Imagem Coolify documenta deps `opencode_local` e/ou só `cursor_cloud` |
| **RNF-P6-05** | Messaging | Zero claims FLUFF no material GA (ver checklist) |

---

## 4. MoSCoW (resumo)

| Must | Should | Could | Won't (P6) |
|------|--------|-------|------------|
| Graduar flag + kill-switch | CHANGELOG + template piloto 30d | Recruiting ops playbook | Beachhead Marketing ROAS |
| Coolify GA checklist | — | GIF Sofia | Cross-company GA |
| Playbooks SH + Support | — | — | BizCursor desktop Room GA |
| Docs Sofia + anti-washing | — | — | Autonomia sem human owner |

---

## 5. UX / docs experience

### 5.1 Sofia — guia curto (estrutura obrigatória)

1. O que é a sala (colegas agentes, não chatbot mágico).  
2. Quando usar `@` (e quando **não**).  
3. Fan-out `@A @B` — o que esperar (dois trabalhando; join).  
4. “Precisa de você” — como responder ao card.  
5. Custo da conversa — o que a pill significa.  
6. Quando chamar o Board (budget 100%, erro técnico, novo agente).

Tom: direto, sem `runId`, sem A2A jargon.

### 5.2 Board — runbook

- Ligar/desligar Room.  
- Budgets 80/100.  
- Roles Operator vs Board density.  
- Smoke ST pós-deploy.  
- Rollback.

### 5.3 Settings UX

| Antes (experimental) | Depois (GA policy) |
|----------------------|--------------------|
| Enterrado em Experimental | Seção “Conference Room” em Company/Instance settings |
| Label “Experimental” | “Available” / “Stable” **ou** “Stable preview” se default-off |
| Kill-switch | Mantido (emergência) |

---

## 6. Arquitetura e artefatos (paths no fork)

### 6.1 Flag / settings

| Área | Path absoluto |
|------|---------------|
| Hook flag | `/Users/macbook/Projects/paperclip/ui/src/hooks/useConferenceRoomChatEnabled.ts` |
| Experimental settings UI | `/Users/macbook/Projects/paperclip/ui/src/pages/InstanceExperimentalSettings.tsx` |
| OpenAPI experimental | `/Users/macbook/Projects/paperclip/server/src/routes/openapi.ts` (`/api/instance/settings/experimental`) |
| Gate BoardChat | `/Users/macbook/Projects/paperclip/ui/src/components/ConferenceRoomChatGate.tsx` |
| Teste flag | `/Users/macbook/Projects/paperclip/server/src/__tests__/board-chat-route-feature-flag.test.ts` |
| Instance settings service | (localizar em) `/Users/macbook/Projects/paperclip/server/src/services/` + schema `instance_settings` |

### 6.2 Política de graduação (escolher uma e documentar)

| Opção | Comportamento | Quando |
|-------|---------------|--------|
| **A — GA default-on** | Novas instâncias: Room on; flag vira `enableConferenceRoomChat` em settings gerais | Piloto SH interno passou DoD |
| **B — GA default-off** | Removido do bucket “Experimental”; default false; one-click enable | Mais conservador Coolify multi-tenant |
| **C — Stable preview** | Continua experimental API key mas UI diz “Stable preview” | Compromisso |

**Recomendação Cycle 5:** **B** no primeiro release GA público do fork; **A** após 1 piloto SH com DoD Cycle 3 verde.

### 6.3 Docs a criar/atualizar

| Doc | Path absoluto proposto |
|-----|------------------------|
| Coolify GA checklist | `/Users/macbook/Projects/paperclip/docs/deploy/coolify-conference-room-ga.md` |
| Guia Sofia | `/Users/macbook/Projects/paperclip/docs/guides/operator/conference-room-sofia.md` |
| Playbook Software House | `/Users/macbook/Projects/paperclip/docs/guides/playbooks/software-house-room.md` |
| Playbook Support Ops | `/Users/macbook/Projects/paperclip/docs/guides/playbooks/support-ops-room.md` |
| Anti-washing | `/Users/macbook/Projects/paperclip/docs/guides/playbooks/anti-washing-checklist.md` |
| Board runbook | `/Users/macbook/Projects/paperclip/docs/guides/board-operator/conference-room.md` |
| Research mirror (bizcursor) | `/Users/macbook/Projects/bizcursor/docs/research/slack-a2a-room/cycle-5-tech-specs/` (este pacote) |
| Dual adapter | `/Users/macbook/Projects/paperclip/docs/bizcursor/DUAL-ADAPTER-INTEGRATION.md` (linkar) |
| Dockerfile / deploy | `/Users/macbook/Projects/paperclip/Dockerfile`, `/Users/macbook/Projects/paperclip/docs/deploy/` |

### 6.4 Código mínimo P6

P6 é **majoritariamente docs + settings UX**. Código Must:

- Relabel/move settings (§6.2).  
- Testes de flag atualizados.  
- Opcional: banner “Room está em GA” one-time NUX.

Não reabrir P2–P5 features em P6 sem bugfix.

---

## 7. Coolify GA checklist (normativo)

Copiar para `coolify-conference-room-ga.md` e marcar no deploy:

### 7.1 Infra & auth

- [ ] `deploymentMode` = `authenticated` (não `local_trusted` público)
- [ ] Bind/exposure corretos; HTTPS no domínio Coolify
- [ ] Board auth / Better Auth funcionando; board API keys rotacionáveis
- [ ] Secrets (`CURSOR_API_KEY`, keys OpenCode, DB) só no server — nunca WebView

### 7.2 Adapters

- [ ] Pelo menos um path de wake sem `spawn(claude)` no board-chat
- [ ] `opencode_local` **ou** `cursor_cloud` validados com chat/room wake
- [ ] cost-events aparecendo pós-run (P4)

### 7.3 Room features

- [ ] Flag enable conforme política GA
- [ ] `@` mention + silent-until-@
- [ ] Fan-out + join (P2) smoke
- [ ] HITL card (P3) smoke
- [ ] Cost pills + 80/100 (P4) smoke
- [ ] Room metrics endpoint (P5) responde

### 7.4 Rollback

- [ ] Procedimento: disable flag → verificar gate
- [ ] Sem migrate que apague histórico da standing issue

### 7.5 Observabilidade

- [ ] Logs sem secrets
- [ ] Budget incidents visíveis
- [ ] Activity log de orquestrações

---

## 8. Playbooks (conteúdo mínimo)

### 8.1 Software House

Base: Cycle 3 §2 (SH-1 bug war room, SH-2 spike paralelo, SH-3 feature onboarding).

Incluir:

- Agentes sugeridos (`@triage`, `@coder`, `@reviewer`, `@ceo`) + adapters.  
- Políticas: cascade default; parallel só em spike.  
- DoD piloto 30d (Cycle 3 §2.5).  
- Anti-claims: não vender SWE-Bench 90%; citar METR nuance.

### 8.2 Support Ops

Base: Cycle 3 §3 (CS-1 L1, CS-2 escalation).

Incluir:

- Narrativa **híbrida** (Klarna scale + walk-back qualidade).  
- Always-human option.  
- Limiares $ / VIP.  
- Proibido: “substitui N FTEs” como KPI único.

### 8.3 Anti-washing checklist (Must publicar)

Antes de qualquer pitch/demo GA, **todos** devem ser verdadeiros:

1. [ ] KPI de ciclo medido (latência/handoff/custo) — não “autonomia %” inventada.  
2. [ ] Human owner visível em toda ação agentic relevante.  
3. [ ] Custo por thread visível (P4).  
4. [ ] Escopo de 1 vertical / 1 sala no piloto.  
5. [ ] Sem ROAS/ROI de mídia como DoD.  
6. [ ] Sem “Gartner 50% SCM” como proof of value atual.  
7. [ ] Sem voice-interview Jabarian vendido como feature Slack.  
8. [ ] Feature flag/kill-switch conhecido pelo Board.  
9. [ ] Admits: MAS ≠ upgrade universal (budget-matched).  
10. [ ] Cite risco Gartner &gt;40% cancel — e como este produto mitiga (scoped, governed, human gate).

---

## 9. Smoke tests (ST-P6-XX)

| ID | Cenário | Esperado |
|----|---------|----------|
| **ST-P6-01** | Deploy Coolify fresh + checklist §7 | Todos itens Must marcáveis |
| **ST-P6-02** | Flag off | Room inacessível; sem regressão Issues |
| **ST-P6-03** | Flag on | BoardChat + `@` + fan-out smoke |
| **ST-P6-04** | Seguir playbook SH-1 em staging | Thread completo com human gate |
| **ST-P6-05** | Seguir playbook CS-1 | Escalation com resumo; humano decide |
| **ST-P6-06** | Review anti-washing em copy do README | Zero violações |
| **ST-P6-07** | Sofia guia: walkthrough por pessoa não-eng | Completa tarefa `@coder` sem ajuda Board |
| **ST-P6-08** | Rollback flag mid-flight | UI gated; runs em curso não corrompem DB |

---

## 10. Definição de pronto (DoD)

- [ ] Política de graduação A/B/C escolhida e implementada na UI/settings
- [ ] Docs §6.3 Must publicados no fork
- [ ] Coolify checklist executada em **staging** com evidência (data + quem)
- [ ] Playbooks SH + Support revisados contra Cycle 3 (sem FLUFF)
- [ ] Guia Sofia PT-BR revisado por persona Operator (ou proxy)
- [ ] Anti-washing checklist no repo e linkada nos playbooks
- [ ] ST-P6-01..07 passam
- [ ] Release notes do fork mencionam Conference Room GA/preview
- [ ] Memória: se P5 NO-GO, playbooks **não** prometem recall PARA

---

## 11. Riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Graduar cedo demais | Suporte explode | Opção B default-off + piloto SH |
| Docs divergem do código | Confiança | ST playbook em staging a cada release |
| Washing em sales deck paralelo | Reputação | Checklist obrigatória + “N” em Marketing |
| Coolify sem OpenCode | Room quebrada | Checklist adapters; path cursor_cloud-only documentado |
| `local_trusted` em prod | Incidente segurança | Checklist §7.1 bloqueante |
| Sofia docs em inglês só | Adoção | PT-BR Must |

---

## 12. Dependências e handoff

```
P0…P5 Must
  → P6 graduação + docs + playbooks
    → Piloto pagante Software House (ops, não eng feature)
```

**Handoff para ops:** checklist Coolify assinada + métricas P5 baseline + anti-washing OK.

**Referências:** Cycle 3 `03-verticals-and-value.md` §2–3, §9; gap analysis §6 Coolify/auth; flag `useConferenceRoomChatEnabled.ts`.
