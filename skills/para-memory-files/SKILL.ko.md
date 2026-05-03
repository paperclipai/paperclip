---
name: para-memory-files
description: >
  Tiago Forte의 PARA 방식으로 file-based memory를 관리하는 skill입니다.
  knowledge graph, daily notes, tacit knowledge, weekly synthesis, qmd recall을 다룹니다.
---

# PARA Memory Files

PARA 방식의 persistent file-based memory입니다. `$AGENT_HOME` 기준으로 knowledge graph, daily notes, tacit knowledge 세 layer를 관리합니다.

## Layer 1: Knowledge graph

`$AGENT_HOME/life/` 아래에 projects, areas, resources, archives를 둡니다.

- **Projects** — 목표나 deadline이 있는 active work
- **Areas** — 끝이 없는 ongoing responsibility
- **Resources** — reference material과 topic
- **Archives** — inactive item

각 entity는 `summary.md`와 `items.yaml`을 가집니다. durable fact는 즉시 `items.yaml`에 저장하고, weekly로 `summary.md`를 갱신합니다.

## Layer 2: Daily notes

`$AGENT_HOME/memory/YYYY-MM-DD.md`는 raw timeline입니다. 대화 중 계속 기록하고, durable fact는 heartbeat 중 Layer 1로 추출합니다.

## Layer 3: Tacit knowledge

`$AGENT_HOME/MEMORY.md`는 user가 어떻게 일하는지에 대한 pattern과 preference를 저장합니다.

## 원칙

기억해야 할 것은 파일에 씁니다. session context에만 의존하지 않습니다.

Recall은 `grep`보다 `qmd`를 우선 사용합니다.

```sh
qmd query "what happened at Christmas"
qmd search "specific phrase"
qmd vsearch "conceptual question"
```
