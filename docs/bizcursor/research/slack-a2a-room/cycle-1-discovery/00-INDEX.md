# Ciclo 1 — Descoberta de fontes

> **Data:** 2026-07-09  
> **Produto-alvo:** Paperclip Conference Room como Slack (humanos + `@agente`) com A2A nativo (fan-out paralelo + wait/join)  
> **Repo de implementação:** fork `QuadriniL/paperclip`  
> **NotebookLM:** sem overlap Villa

## Catálogos produzidos (subagents)

| ID | Escopo | Fontes ~ | Achado-chave |
|----|--------|----------|--------------|
| D1 | Protocolo A2A oficial | ~24 | Spec **v1.0.0** em a2a-protocol.org; fan-out multi-agente é **app-level**; A2A ≠ Slack |
| D2 | Academia MAS / HITL / wait | ~24 | Co-Gym `WaitTeammateContinue`; Aegean quorum; MAS ≠ upgrade universal (budget-matched) |
| D3 | Indústria / frameworks / produtos | ~40 | Linear/Slack/Teams = agente como colega; AG2/SK GroupChat; Gartner anti-hype |
| D4 | Fork Paperclip + BizCursor | interno | `run-delegation` + MCP `paperclipDelegate` **já implementados**; BoardChat sem @; mentions ≠ A2A |
| D5 | Verticais de negócio | ~40 | SE + support + recruiting = evidência forte; marketing/content = fluff; SC = early |

## Decisões de produto já tomadas (conversa)

1. Path **B/Slack+@** (não Manus 1:1 puro)
2. Produto **só no fork Paperclip** (BizCursor desktop pausa)
3. `@A @B` → ambos veem; decidem wait/peer ou paralelo (A2A nativo completo)

## Próximo ciclo

Ciclo 2 — Confirmação: citar em paralelo as fontes top, validar uso real, cruzar com código do fork.