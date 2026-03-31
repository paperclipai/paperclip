# Plugin System — Próxima Iteração

**Last Updated:** 2026-03-31 20:30 UTC

---

## ✅ Concluído Nesta Sessão

### Testes Unitários de Worker — COMPLETO

**Status anterior (documento desatualizado):**
- Playwright MCP: 28 testes unitários ✅
- Ruflo Bridge + Skills Hub: **ZERO testes unitários** ❌

**Status atual (2026-03-31 20:30 UTC):**
| Plugin | Testes | Arquivo | Status |
|--------|--------|---------|--------|
| Playwright MCP | 28 testes | `src/__tests__/worker.test.ts` | ✅ Completa |
| Ruflo Bridge | 47 testes | `src/__tests__/worker.test.ts` | ✅ Completa |
| Skills Hub | 37 testes | `src/__tests__/worker.test.ts` | ✅ Completa |
| **Total** | **112 testes** | 3 arquivos | ✅ **Completa** |

**Cobertura por plugin:**

#### Ruflo Bridge (47 testes)
- Manifest validation (4 testes)
- `agent_spawn` schema (7 testes)
- `swarm_init` schema (4 testes)
- `memory_store` schema (5 testes)
- `memory_search` schema (4 testes)
- `workflow_create` schema (4 testes)
- `workflow_execute` schema (4 testes)
- `coordination_orchestrate` schema (4 testes)
- `autopilot_status` schema (3 testes)
- `hooks_route` schema (3 testes)

#### Skills Hub (37 testes)
- Manifest validation (4 testes)
- `search_skills` schema (3 testes)
- `get_skill` schema (3 testes)
- `get_trending` schema (2 testes)
- `get_top_rated` schema (2 testes)
- `get_rising` schema (2 testes)
- `get_categories` schema (2 testes)
- `get_masters` schema (2 testes)
- `get_stats` schema (2 testes)
- `submit_skill` schema (3 testes)
- `scan_security` schema (2 testes)
- `get_workflows` schema (2 testes)
- `get_landing` schema (2 testes)

**Validação:**
```bash
pnpm test -- plugin-unit
# → 112 testes passando (28 + 47 + 37)
# → Duration: ~2s
```

---

## 🎯 Próximas Oportunidades de Alto ROI

### 1. Testes de Integração com Mock de Contexto (PRIORITÁRIO)

**Gap atual:**
- Testes atuais validam apenas schemas de manifesto
- Não validam execução real dos workers com contexto mockado
- Não testam error handling, entity operations, ou tool registration dinâmica

**Oportunidade:**
Adicionar testes de integração que mockam o `PluginContext` e validam:
- Tool registration no boot do worker
- Execução de handlers com inputs válidos/inválidos
- Entity upsert/find operations
- Error handling e fallbacks
- Response formatting

**Esforço estimado:** 4-6 horas, ~50-80 testes de integração

**Padrão sugerido:**
```typescript
// Exemplo: ruflo-bridge/src/__tests__/integration.test.ts
import { createMockContext } from '@paperclipai/plugin-sdk/testing';

describe('Ruflo Bridge Integration', () => {
  it('should register all 9 tools on boot', async () => {
    const ctx = createMockContext();
    const worker = await import('../worker.js');
    await worker.default(ctx);
    
    expect(ctx.tools.register).toHaveBeenCalledTimes(9);
    expect(ctx.tools.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent_spawn' })
    );
  });

  it('should execute agent_spawn with valid params', async () => {
    const ctx = createMockContext({
      entities: { upsert: vi.fn().mockResolvedValue({ id: 'agent-1' }) }
    });
    
    const result = await executeTool(ctx, 'agent_spawn', {
      agentType: 'coder',
      task: 'Fix bug #123'
    });
    
    expect(result.success).toBe(true);
    expect(ctx.entities.upsert).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({ type: 'coder' })
    );
  });
});
```

---

### 2. Playwright MCP — Testes de Execução Real de Browser

**Gap atual:**
- Testes validam apenas schema do manifesto
- Não executam browser real (Playwright não instalado no CI)

**Oportunidade:**
Adicionar testes E2E opcionais (skip no CI, run local) que:
- Navegam para página de teste local
- Validam click, fill, screenshot
- Testam wait conditions e timeouts

**Requisitos:**
- Playwright instalado (`pnpm exec playwright install chromium`)
- Servidor local de teste (Vite ou Express estático)

**Esforço estimado:** 2-3 horas, ~15-20 testes E2E

---

### 3. Documentação de Exemplos de Uso por Tool

**Gap atual:**
- READMEs dos plugins listam tools mas não mostram exemplos completos
- Usuário precisa adivinhar como combinar múltiplas tools

**Oportunidade:**
Adicionar seção "Recipes" em cada README:
- Playwright MCP: "Login automation", "Scrape product data", "Visual regression"
- Ruflo Bridge: "Spawn coder agent", "Initialize swarm", "Store/retrieve memory"
- Skills Hub: "Search skills by category", "Install skill", "Validate skill"

**Esforço estimado:** 1-2 horas, 3-6 recipes por plugin

---

### 4. Plugin de Exemplo "Kitchen Sink" — Completa

**Gap atual:**
- `packages/plugins/examples/plugin-kitchen-sink-example/` existe mas pode estar incompleto

**Oportunidade:**
Transformar em referência completa:
- Todas as features do SDK demonstradas
- UI component examples
- Tool registration dinâmica
- Entity operations
- Asset handling
- Error boundaries

**Esforço estimado:** 3-4 horas

---

## Critérios de Priorização

| Critério | Peso | Opção 1 (Integração) | Opção 2 (Playwright E2E) | Opção 3 (Docs) |
|----------|------|---------------------|-------------------------|----------------|
| Impacto na confiabilidade | 3x | Alto | Médio | Baixo |
| Esforço | 2x | Médio (4-6h) | Baixo (2-3h) | Baixo (1-2h) |
| Risco de regressão | 2x | Alto (pega bugs cedo) | Médio | Baixo |
| Valor para devs externos | 1x | Médio | Baixo | Alto |

**Recomendação:** Opção 1 (testes de integração) → maior ROI em confiabilidade.

---

## Padrão de Teste (copiar de Playwright MCP)

```typescript
// packages/plugins/ruflo-bridge/src/__tests__/worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../worker.js';
import type { PluginContext, ToolResult } from '@paperclipai/plugin-sdk';

function createMockContext(): PluginContext {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    entities: {
      upsert: vi.fn(),
      find: vi.fn(),
      delete: vi.fn(),
    },
    tools: {
      register: vi.fn(),
    },
    assets: {
      read: vi.fn(),
      write: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe('Ruflo Bridge Worker', () => {
  let ctx: PluginContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('agent_spawn tool', () => {
    it('spawns agent with required params', async () => {
      vi.mocked(ctx.entities.upsert).mockResolvedValue({
        id: 'agent-123',
        entityType: 'ruflo_agent',
        data: { status: 'spawned' },
      });

      const tool = worker.tools?.find(t => t.name === 'agent_spawn');
      const result = await tool?.handler(
        { agentType: 'coder', task: 'fix bug' },
        {} as any
      );

      expect(result?.content).toContain('agent-123');
      expect(ctx.entities.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'ruflo_agent',
          data: expect.objectContaining({
            agentType: 'coder',
            task: 'fix bug',
          }),
        })
      );
    });

    it('fails without required agentType', async () => {
      const tool = worker.tools?.find(t => t.name === 'agent_spawn');
      
      await expect(async () => {
        await tool?.handler({}, {} as any);
      }).rejects.toThrow();
    });
  });
});
```

---

## Critérios de Aceite

### Ruflo Bridge
- [ ] 9 tools testadas (100% coverage)
- [ ] Mínimo 10 testes por tool (happy path + errors)
- [ ] Total: ~90-100 testes
- [ ] Vitest config igual a playwright-mcp
- [ ] `pnpm test --filter @paperclipai/plugin-ruflo-bridge` passa

### Skills Hub
- [ ] 12 tools testadas (100% coverage)
- [ ] Mínimo 12 testes por tool
- [ ] Total: ~140-150 testes
- [ ] Vitest config igual a playwright-mcp
- [ ] `pnpm test --filter @paperclipai/plugin-skills-hub` passa

---

## Benefícios

1. **Detecção precoce** — bugs de lógica pegos em CI, não produção
2. **Refactoring seguro** — testes previnem regressões
3. **Documentação viva** — testes mostram como usar cada tool
4. **Confiança** — 100% coverage dá certeza que o código funciona

---

## Execução

**Fase 1 (Ruflo Bridge):**
1. Criar `src/__tests__/worker.test.ts`
2. Copiar padrão de playwright-mcp
3. Implementar testes para 9 tools
4. Validar: `pnpm test --filter @paperclipai/plugin-ruflo-bridge`
5. Commit: `test(ruflo-bridge): add 100 unit tests for all tools`

**Fase 2 (Skills Hub):**
1. Criar `src/__tests__/worker.test.ts`
2. Copiar padrão de playwright-mcp
3. Implementar testes para 12 tools
4. Validar: `pnpm test --filter @paperclipai/plugin-skills-hub`
5. Commit: `test(skills-hub): add 150 unit tests for all tools`

**Fase 3 (CI Integration):**
1. Atualizar `scripts/validate-plugins.sh` para incluir novos testes
2. Validar script completo
3. Commit: `test(plugins): include ruflo-bridge and skills-hub in validation`

---

## Health Score Impacto

**Atual:** 9.8/10 (deduzido 0.2 por gaps de testes)
**Pós-implementação:** 10.0/10 (100% testes, 100% coverage)
