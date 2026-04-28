# Phase 11: Task Mesh and Knowledge Workspace - Discussion Log

> **Audit trail only.** 계획/실행 입력은 `11-CONTEXT.md`를 기준으로 한다.

**Date:** 2026-04-25
**Phase:** 11 - Task Mesh and Knowledge Workspace
**Mode:** `/gsd-discuss-phase 11 --auto --chain`

---

## Task Mesh view shape

| Option | Description | Selected |
|--------|-------------|----------|
| 기존 graph panel 확장 | 기존 route/panel을 7개 mesh view contract로 확장 | ✓ |
| 새 workspace 앱 생성 | 별도 top-level Task Mesh 앱 생성 | |
| Backend only | API만 만들고 UI는 후속 처리 | |

**선택:** 기존 graph panel 확장.
**근거:** Phase 5/10의 기존 project-scoped graph/daily 흐름과 가장 잘 맞고, 사용자에게 보이는 gap을 바로 닫는다.

---

## Knowledge export shape

| Option | Description | Selected |
|--------|-------------|----------|
| API export bundle | DB/event projector를 truth로 두고 Obsidian-compatible markdown bundle 반환 | ✓ |
| Local file writer | 서버가 직접 vault directory에 파일 기록 | |
| Markdown primary write path | markdown 파일을 source of truth로 사용 | |

**선택:** API export bundle.
**근거:** AGENTS.md의 markdown non-primary-write-path 원칙과 company-scoped auditability를 유지한다.

---

## Graph evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Report contract 확장 | God Node, surprising connection, stale warning을 shared/server/UI contract에 포함 | ✓ |
| Markdown report only | graph report markdown에만 표시 | |
| Deferred | Phase 12 이후 처리 | |

**선택:** Report contract 확장.
**근거:** 개발기획서의 graph output 요구사항은 운영자 UI/API에서 구조적으로 확인 가능해야 한다.

---

## Deferred Ideas

- 실제 Obsidian 양방향 sync/local writer.
- 대규모 interactive graph canvas.
