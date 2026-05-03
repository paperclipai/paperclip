---
title: Goals and Projects
summary: Goal hierarchy와 project management
---

# Goals and Projects

Goal은 “왜”를 정의하고, project는 “무엇을” 묶습니다.

## Goals

Goal은 hierarchy를 가집니다. company goal은 team goal로, team goal은 agent-level goal로 내려갈 수 있습니다.

```http
GET /api/companies/{companyId}/goals
GET /api/goals/{goalId}
POST /api/companies/{companyId}/goals
PATCH /api/goals/{goalId}
```

생성 예시:

```json
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

유효한 status: `planned`, `active`, `achieved`, `cancelled`

## Projects

Project는 deliverable을 향한 관련 issue 묶음입니다. goal과 연결할 수 있고 workspace를 가질 수 있습니다.

```http
GET /api/companies/{companyId}/projects
GET /api/projects/{projectId}
POST /api/companies/{companyId}/projects
PATCH /api/projects/{projectId}
```

생성 시 `workspace`를 함께 넣으면 project와 primary workspace를 동시에 만들 수 있습니다. workspace에는 `cwd` 또는 `repoUrl` 중 하나 이상이 필요합니다.

## Project Workspaces

```http
GET /api/projects/{projectId}/workspaces
POST /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```

agent는 project-scoped task를 실행할 때 primary workspace를 기준으로 working directory를 결정합니다.
