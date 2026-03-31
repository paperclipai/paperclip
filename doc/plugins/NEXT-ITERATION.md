# Plugin System — Próxima Iteração

## Gap Identificado (2026-03-31)

**Status atual:**
- 3 plugins production-ready (Playwright MCP, Ruflo Bridge, Skills Hub)
- SDK: 131 testes unitários ✅
- Playwright MCP: 28 testes unitários ✅
- Ruflo Bridge + Skills Hub: **ZERO testes unitários** (apenas E2E lifecycle)

**Problema:**
- E2E lifecycle valida integração básica (install → run → uninstall)
- Não valida lógica interna dos workers (tool registration, entity operations, error handling)
- Se um worker quebrar a lógica, só descobrimos em produção

---

## Oportunidade de Alto ROI

**Adicionar testes unitários para Ruflo Bridge + Skills Hub**

### Ruflo Bridge (9 tools)
Tools para testar:
1. `agent_spawn` — valida schema, entity upsert, response format
2. `swarm_init` — valida schema, entity upsert, response format
3. `memory_store` — valida schema, entity upsert, tags
4. `memory_search` — valida query, threshold, namespace
5. `agent_status` — valida agent lookup, status response
6. `agent_terminate` — valida termination flow
7. `agent_list` — valida filtering, pagination
8. `swarm_status` — valida swarm lookup
9. `swarm_shutdown` — valida shutdown flow

**Abordagem:**
- Mock `ctx` (logger, entities, tools, assets)
- Testar cada tool handler isoladamente
- Validar schemas de input/output
- Testar error paths (missing params, invalid data)

**Esforço estimado:** 2-3 horas, ~100 testes

### Skills Hub (12 tools)
Tools para testar:
1. `skill_list` — list filtering, category search
2. `skill_view` — skill loading, file access
3. `skill_create` — creation flow, validation
4. `skill_patch` — patch operations, replace_all
5. `skill_delete` — deletion flow
6. `skill_search` — search queries, relevance
7. `skill_validate` — validation logic
8. `skill_export` — export format
9. `skill_import` — import validation
10. `skill_template_list` — template discovery
11. `skill_template_apply` — template application
12. `skill_metadata` — metadata extraction

**Abordagem:**
- Mock filesystem operations
- Mock skill registry
- Testar cada tool handler
- Validar error handling

**Esforço estimado:** 3-4 horas, ~150 testes

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
