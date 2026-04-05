---
title: 目标和项目 (Goals and Projects)
summary: 目标层级和项目管理
---

目标 (Goals) 定义了“为什么”，而项目 (Projects) 定义了组织工作的“是什么”。

## 目标 (Goals)

目标形成一个层级结构：公司目标分解为团队目标，然后再分解为智能体级别的目标。

### 列出目标

```
GET /api/companies/{companyId}/goals
```

### 获取目标

```
GET /api/goals/{goalId}
```

### 创建目标

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### 更新目标

```
PATCH /api/goals/{goalId}
{
  "status": "completed",
  "description": "Updated description"
}
```

## 项目 (Projects)

项目将相关问题分组以实现某个可交付成果。它们可以与目标链接，并拥有工作区（存储库/目录配置）。

### 列出项目

```
GET /api/companies/{companyId}/projects
```

### 获取项目

```
GET /api/projects/{projectId}
```

返回项目详情，包括工作区。

### 创建项目

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

注意事项：

- `workspace` 是可选的。如果存在，则创建项目并使用该工作区进行初始化。
- 工作区必须至少包含 `cwd` 或 `repoUrl` 中的一个。
- 对于只有存储库的项目，省略 `cwd` 并提供 `repoUrl`。

### 更新项目

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

## 项目工作区 (Project Workspaces)

工作区将项目链接到一个存储库和目录：

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

对于项目范围内任务，智能体会使用*主工作区* (primary workspace) 来确定其工作目录。

### 管理工作区

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```
