---
title: 目標和項目
summary: 目標層次與專案管理
---
目標定義了組織工作的“原因”，專案定義了組織工作的“內容”。

## 目標

目標形成一個層次結構：公司目標分解為團隊目標，團隊目標分解為智能體目標。

### 列出目標

```
GET /api/companies/{companyId}/goals
```

### 達成目標

```
GET /api/goals/{goalId}
```

### 建立目標

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### 更新目標

```
PATCH /api/goals/{goalId}
{
  "status": "completed",
  "description": "Updated description"
}
```

## 項目

專案將相關問題分組以實現可交付成果。它們可以連結到目標並具有工作空間（儲存庫/目錄配置）。

### 列出項目

```
GET /api/companies/{companyId}/projects
```

### 取得項目

```
GET /api/projects/{projectId}
```

返回項目詳細信息，包括工作區。

### 建立項目

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

注意事項：

- `workspace` 是可選的。如果存在，則會建立專案並使用該工作區作為種子。
- 工作區必須至少包含 `cwd` 或 `repoUrl` 之一。
- 對於僅儲存庫項目，省略 `cwd` 並提供 `repoUrl`。

### 更新項目

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

## 專案工作區

工作區將項目連結到儲存庫和目錄：

```
POST /api/projects/{projectId}/workspaces
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

智能體程式使用主工作區來決定專案範圍任務的工作目錄。

### 管理工作區

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```