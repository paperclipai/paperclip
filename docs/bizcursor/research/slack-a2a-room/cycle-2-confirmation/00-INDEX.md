# Ciclo 2 — Confirmação

> **Data:** 2026-07-09  
> **Método:** WebFetch fontes primárias + leitura de código no fork

## Resultados

| Domínio | Claims | Confirmadas | Parciais | Refutadas |
|---------|--------|-------------|----------|-----------|
| A2A protocol | 8 | 7 | 1 (v1.0.0 vs patch 1.0.1) | 0 |
| Academia | 8 | 7–8 | 1 (Magentic abs) | 0 |
| Indústria UX | 8 | 7 | 1 (Slack “agentic OS”) | 0 |
| Fork Paperclip | 8 | 7 | 1 (assignee wake exceptions) | 0 |
| Verticais | 6 | grades A/B/C | — | Marketing = FLUFF |

## Achados que viram requisitos de produto

1. **A2A ≠ sala** — fan-out `@A @B` é orquestração Paperclip sobre N SendMessage/delegate.
2. **Fan-out+join já existe** no fork (`wait:false` + `waitAllSec`) — falta bridge sala → A2A.
3. **UX a copiar:** Claude Tag / Linear / Teams — `@` multiplayer, async, thread, human owner.
4. **Default SAS → cascade MAS** (Gao); se paralelo → quorum (Aegean), não barrier cego.
5. **Beachhead Phase 1:** Software houses (A); Support secundário (B); Marketing N.

## Gaps confirmados no código

- BoardChat: sempre concierge, sem @
- Mentions em issues: wakeup independente ≠ A2A join
- Humano não pode POST delegate (só agent JWT em run)
- Sem modelo de sala com silent-until-@ + peer wait