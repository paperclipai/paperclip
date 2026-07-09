# P4 — Custos por Hop/Sessão, Budget Alerts e Densidade Operator vs Board

> **Versão:** 1.0  
> **Data:** 2026-07-09  
> **Ciclo:** 5 — Tech specs  
> **Repo de implementação:** fork `/Users/macbook/Projects/paperclip` (`QuadriniL/paperclip`)  
> **Pré-requisitos:** P2 (orquestração com `parentRunId` / child runs), P3 (estados de hop estáveis); alinhamento conceitual com BizCursor F3  
> **BizCursor desktop:** contratos de `cost-events` / `sessionId` podem ser espelhados depois; UI desta fase é **web Paperclip**  
> **Confiança:** Alta — Paperclip já tem costs/budgets/access; gap é **surface na sala**

---

## 1. Contexto

### 1.1 Por que P4 existe

A Conference Room sem custo visível falha o pitch anti-hype (Gartner &gt;40% cancel por custo unclear) e o DoD de beachhead Software House (“100% custo por thread visível”).

O fork **já grava** `cost-events`, agrega summaries e enforce **80% soft / 100% hard-stop**. O que falta para a sala:

1. **Cost pill por hop** (cada child run / agente mencionado) e **por sessão/thread** da room.
2. **Alertas 80/100 na própria room** (não só Dashboard/Costs page).
3. **Densidade Operator vs Board** — Sofia vê “esta conversa ≈ $X”; Board vê breakdown por agente/modelo/`runId`.

### 1.2 Reuso explícito (não reinventar)

| Capacidade | Onde já vive |
|------------|--------------|
| Cost events + summary APIs | `server/src/services/costs.ts`, `routes/costs.ts` |
| Budget 80/100 + incidents | `server/src/services/budgets.ts`, `budget_incidents` schema |
| UI Costs / cards | `ui/src/pages/Costs.tsx`, `BudgetIncidentCard.tsx`, `BillerSpendCard.tsx` |
| Access Operator/Board | `server/src/services/access.ts`, `company-member-roles.ts`, `ui/src/pages/CompanyAccess.tsx` |
| Docs | `docs/guides/board-operator/costs-and-budgets.md` |

P4 = **bridge room session ↔ cost aggregation** + **UX density**, não novo ledger.

### 1.3 Personas

| Persona | Sucesso P4 |
|---------|------------|
| **Sofia** | Vê pill de custo da conversa; toast em 80%; bloqueio claro em 100% sem jargão |
| **Board** | Expande pill → por hop, agente, modelo, `heartbeatRunId`; ajusta budget |
| **Sistema** | Hard-stop Paperclip continua autoritativo; room só **reflete** |

### 1.4 Glossário

| Termo | Definição |
|-------|-----------|
| **Room session / thread** | Unidade de auditoria da sala (standing issue / room thread id) |
| **Hop cost** | Soma de `cost-events` ligados a um `heartbeatRunId` filho |
| **Session cost** | Soma dos hops + runs da orquestração daquele thread |
| **Operator density** | UI reduzida (pill + semáforo) |
| **Board density** | UI expandida (tabela/trace + ids) |
| **80/100** | Soft alert / hard-stop já documentados no Paperclip |

---

## 2. Requisitos funcionais (RF-P4-XX)

| ID | Requisito | MoSCoW |
|----|-----------|--------|
| **RF-P4-01** | Cada hop A2A na sala exibe **cost pill** (centavos ou “—” se ainda sem event) | Must |
| **RF-P4-02** | Header/composer da room exibe **session cost pill** (agregado do thread) | Must |
| **RF-P4-03** | Correlacionar `cost-events` → `heartbeatRunId` → hop UI (via campos já gravados pelos adapters) | Must |
| **RF-P4-04** | Quando utilization company ou agent ≥ **80%**, toast/banner **na room** (além do dashboard) | Must |
| **RF-P4-05** | Em **100%** / agente paused por budget: room bloqueia novos `@` wakes com mensagem acionável (“Peça ao Board aumentar budget”) | Must |
| **RF-P4-06** | Operator density (default Sofia): pill + cores verde/amarelo/vermelho; sem `runId` | Must |
| **RF-P4-07** | Board density (toggle ou role): breakdown por hop/agente/modelo + link para Costs page | Must |
| **RF-P4-08** | Reusar membership/roles Paperclip para decidir density default (`operator` vs board/admin) | Must |
| **RF-P4-09** | Endpoint ou query: `GET .../rooms/:roomId/costs` (ou costs/summary filtrado por issue/thread da room) | Must |
| **RF-P4-10** | Cost events de `cursor_cloud` / `opencode_local` aparecem na sala após run succeeded (depende adapters; não inventar custo) | Must |
| **RF-P4-11** | Flag `costEstimated` (quando pricing fallback) visível só em Board density | Should |
| **RF-P4-12** | Export mental: botão “Abrir em Costs” com filtro pré-aplicado | Should |
| **RF-P4-13** | Rate-limit visual: avisar se fan-out N agentes estouraria budget restante estimado | Could |
| **RF-P4-14** | Moeda/locale: respeitar preferência instance/company se existir; senão USD cents | Could |

---

## 3. Requisitos não funcionais (RNF-P4-XX)

| ID | Requisito | Métrica |
|----|-----------|---------|
| **RNF-P4-01** | Sem segundo sistema de billing | Só `cost_events` + budgets Paperclip |
| **RNF-P4-02** | Poll/SSE de custo na room | Atualização ≤ 5 s após run terminal |
| **RNF-P4-03** | Permissões | Operator lê summary da company/room; só Board PATCH budgets |
| **RNF-P4-04** | Secrets | Nenhuma API key de provider no WebView |
| **RNF-P4-05** | Performance | Agregar por thread sem full table scan; índices existentes / issueId |
| **RNF-P4-06** | Honestidade | Nunca mostrar custo Cursor Admin como “fatura” se for estimado |

---

## 4. MoSCoW (resumo)

| Must | Should | Could | Won't (P4) |
|------|--------|-------|------------|
| Pill hop + session | `costEstimated` Board-only | Pre-flight budget do fan-out | ML de forecast |
| Alerts 80/100 na room | Deep link Costs | Locale avançado | Billing Stripe |
| Density Operator/Board via access | — | — | Ledger paralelo BizCursor nesta fase |
| API agregação room | — | — | Controlar spend Cursor Cloud account |

---

## 5. UX

### 5.1 Operator (Sofia)

```
[Sala #eng-bugs]                    conversa ≈ $1.20  ●
...
@triage  …                          $0.18
@coder   …                          $0.91
```

- 80%: toast “Orçamento da empresa em 80% — priorize o essencial.”
- 100%: composer `@` desabilitado com CTA “Falar com Board”.

### 5.2 Board density

Toggle “Detalhes técnicos” (ou auto se role board/admin):

| Hop | Agente | Adapter | Modelo | Tokens | $ | Run |
|-----|--------|---------|--------|--------|---|-----|
| 1 | triage | opencode_local | … | in/out | 0.18 | `run_…` |
| 2 | coder | cursor_cloud | … | … | 0.91* | `run_…` |

\* = estimado.

### 5.3 Reuso visual

Preferir tokens/componentes existentes: `BudgetIncidentCard`, `BudgetSidebarMarker`, padrões de `Costs.tsx` — **não** inventar design system paralelo.

### 5.4 Anti-padrões

- Mostrar custo só no Dashboard e “zero” na sala.
- Assustar Sofia com stack de `costCents` raw sem formatação.
- Permitir `@` após hard-stop “porque a sala é especial”.

---

## 6. Arquitetura (paths no fork)

### 6.1 Diagrama

```
Adapters (cursor_cloud / opencode_local)
    → POST cost-events (existente)
         → costs/budgets services
              → GET room costs aggregate (P4)
                   → BoardChat cost pills + alerts
Access/roles ─────────────────────────► density mode
```

### 6.2 REUSAR

| Área | Path absoluto |
|------|---------------|
| Costs service | `/Users/macbook/Projects/paperclip/server/src/services/costs.ts` |
| Cost metadata | `/Users/macbook/Projects/paperclip/server/src/services/cost-metadata.ts` |
| Budgets | `/Users/macbook/Projects/paperclip/server/src/services/budgets.ts` |
| Routes costs | `/Users/macbook/Projects/paperclip/server/src/routes/costs.ts` |
| Schema cost_events | `/Users/macbook/Projects/paperclip/packages/db/src/schema/cost_events.ts` |
| Schema budget_incidents | `/Users/macbook/Projects/paperclip/packages/db/src/schema/budget_incidents.ts` |
| Schema budget_policies | `/Users/macbook/Projects/paperclip/packages/db/src/schema/budget_policies.ts` |
| Access | `/Users/macbook/Projects/paperclip/server/src/services/access.ts` |
| Company member roles | `/Users/macbook/Projects/paperclip/server/src/services/company-member-roles.ts` |
| UI Costs | `/Users/macbook/Projects/paperclip/ui/src/pages/Costs.tsx` |
| UI CompanyAccess | `/Users/macbook/Projects/paperclip/ui/src/pages/CompanyAccess.tsx` |
| Budget cards | `/Users/macbook/Projects/paperclip/ui/src/components/BudgetIncidentCard.tsx` |
| Guide | `/Users/macbook/Projects/paperclip/docs/guides/board-operator/costs-and-budgets.md` |
| cursor_cloud costs note | `/Users/macbook/Projects/paperclip/packages/adapters/cursor-cloud/README.md` |

### 6.3 ADAPTAR / CONSTRUIR

| Área | Path absoluto proposto |
|------|------------------------|
| Room cost aggregate | `/Users/macbook/Projects/paperclip/server/src/services/room-costs.ts` |
| Route (estender board-room ou costs) | `/Users/macbook/Projects/paperclip/server/src/routes/board-room.ts` e/ou `costs.ts` |
| Validators | `/Users/macbook/Projects/paperclip/packages/shared/src/validators/room-costs.ts` |
| UI pills | `/Users/macbook/Projects/paperclip/ui/src/components/RoomCostPill.tsx` |
| Hook | `/Users/macbook/Projects/paperclip/ui/src/hooks/useRoomCosts.ts` |
| Density helper | `/Users/macbook/Projects/paperclip/ui/src/hooks/useRoomDensity.ts` (lê role via access) |
| BoardChat integration | `/Users/macbook/Projects/paperclip/ui/src/pages/BoardChat.tsx` |
| Delegation hop row (custo) | `/Users/macbook/Projects/paperclip/ui/src/features/delegation-trace/` (se existir pós-P2) |
| Testes | `/Users/macbook/Projects/paperclip/server/src/__tests__/room-costs.test.ts` |

### 6.4 Contrato de resposta (alvo)

```ts
type RoomCostsSummary = {
  roomId: string;
  issueId: string; // standing issue / thread backing
  sessionCostCents: number;
  currency: "USD";
  hops: Array<{
    heartbeatRunId: string;
    agentId: string;
    agentName: string;
    costCents: number;
    costEstimated: boolean;
    provider?: string;
    model?: string;
  }>;
  budget: {
    scope: "company" | "agent";
    utilizationPercent: number;
    incident?: "none" | "soft_80" | "hard_100";
  };
};
```

### 6.5 Density via access

```
if role in { board, instance_admin, company admin } → default Board density available
else operator → Operator density; Board density hidden or read-only expand se grant explícito
```

Reusar `canUser` / permission keys existentes para `costs.read` / `budgets.write` — **não** criar role “Sofia” paralelo se Operator já mapeia.

---

## 7. Smoke tests (ST-P4-XX)

| ID | Cenário | Esperado |
|----|---------|----------|
| **ST-P4-01** | Run `opencode_local` succeeded com usage | Hop pill &gt; 0; session pill atualiza |
| **ST-P4-02** | Fan-out 2 hops | Soma session ≈ soma hops |
| **ST-P4-03** | Forçar utilization ≥ 80% (budget baixo) | Banner/toast na room |
| **ST-P4-04** | Hard-stop 100% | Novos `@` rejeitados com CTA |
| **ST-P4-05** | Login Operator | Sem tabela runId; só pills |
| **ST-P4-06** | Login Board | Expand mostra modelo + runId |
| **ST-P4-07** | Board PATCH budget | Room reflete novo headroom |
| **ST-P4-08** | Run sem usage | Pill “—”; sem inventar $ |
| **ST-P4-09** | cursor_cloud com `costEstimated` | Asterisco só em Board density |

---

## 8. Definição de pronto (DoD)

- [ ] RF-P4-01..10 Must feitos
- [ ] Alerts 80/100 visíveis **na room** (não só `/costs`)
- [ ] Density Operator vs Board amarrada a access/roles existentes
- [ ] ST-P4-01..08 passam; ST-P4-09 se cursor_cloud disponível no staging
- [ ] Docs board-operator: seção “Costs in Conference Room”
- [ ] Nenhum claim de “custo Cursor = fatura” sem Enterprise reconciliation (Won't)
- [ ] Beachhead DoD parcial: custo por thread 100% visível para Board

---

## 9. Riscos

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| cost-events atrasados / ausentes (adapter) | Pill zerada engana | “—” + Board warning; não fake |
| Paperclip budget ≠ Cursor account spend | Falso senso de controle | Docs + README adapter |
| Operator vê demais / Board demais escondido | UX confusa | Defaults por role + toggle explícito |
| Agregar por poll pesado | Carga DB | Agregar por `issueId` indexado; cache curto |
| Dual UI BizCursor vs Paperclip | Drift | Esta fase só fork; contrato Zod documentado para cherry-pick futuro |
| Alert spam 80% | Fadiga | Debounce / dismiss por sessão UI |

---

## 10. Dependências

```
P2/P3 (hops com runIds estáveis)
  → P4 (room-costs + pills + alerts + density)
    → P5 (métricas de sala incluem cost/session)
    → P6 (playbooks citam custo visível no DoD)
```

**Alinhamento BizCursor F3:** mesmos limiares 80/100 e ideia de `session_cost_links`; implementação autoritativa no fork para a Room.
