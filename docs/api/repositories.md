---
title: Repositories
summary: Company repository catalog, provider connections, relationships, and effective access
---

Repositories are company-scoped work objects. They are not execution workspaces: a project relationship is a planning/context hint, while a workspace is a concrete checkout and runtime location.

The published shared contracts live in `packages/shared/src/types/repository.ts` and their request validators in `packages/shared/src/validators/repository.ts`.

## Catalog

Board operators can list and create manual catalog entries:

```text
GET  /api/companies/{companyId}/repositories?includeArchived=true
POST /api/companies/{companyId}/repositories
GET  /api/repositories/{repositoryId}
PATCH /api/repositories/{repositoryId}
DELETE /api/repositories/{repositoryId}
GET  /api/repositories/{repositoryId}/relationships
```

`DELETE` archives rather than hard-deletes. Catalog identity and URLs are normalized; credential-bearing URLs are rejected. The relationships response names linked projects and agents whose effective access comes from a direct grant, a readable linked project, or both.

## Project hints and agent access

```text
GET    /api/projects/{projectId}/repositories
PUT    /api/projects/{projectId}/repositories/{repositoryId}
DELETE /api/projects/{projectId}/repositories/{repositoryId}

GET    /api/agents/{agentId}/repositories
GET    /api/agents/{agentId}/repositories?effective=true
PUT    /api/agents/{agentId}/repositories/{repositoryId}
DELETE /api/agents/{agentId}/repositories/{repositoryId}
```

The project `PUT` body is `{ "displayOrder": 0 }`. Project hints are many-to-many and non-exclusive. The agent `PUT` creates an explicit direct grant. `effective=true` returns the union of direct grants and repositories hinted by projects the agent may read, with the contributing sources attached. Reads apply project/agent authorization; mutations are board-only and activity-logged.

Project payloads expose `repositoryHints`, a secret-free `ProjectRepositoryHint[]`. Agent heartbeat/resume context exposes only the equivalent secret-free `EffectiveRepositoryContext[]`; neither payload includes provider metadata or a credential.

## Provider connections

```text
GET    /api/companies/{companyId}/repository-providers
GET    /api/companies/{companyId}/repository-connections
POST   /api/companies/{companyId}/repository-connections
GET    /api/repository-connections/{connectionId}
POST   /api/repository-connections/{connectionId}/sync
DELETE /api/repository-connections/{connectionId}

POST /api/companies/{companyId}/repository-connections/{provider}/install
POST /api/companies/{companyId}/repository-connections/{provider}/callback
GET  /api/repository-connections/{connectionId}/discover
POST /api/repository-connections/{connectionId}/import
```

Provider identity is `(provider, normalized host)`, allowing hosted and enterprise installations to coexist. The available-provider route is runtime capability discovery: an extension-contributed provider appears only while its trusted plugin is ready, declares that identity, holds `repository.providers.register`, and has a running worker.

## Clone credentials

```text
POST /api/repositories/{repositoryId}/clone-credential
```

This endpoint is available only for an active provider-backed repository in the caller's effective access set. The credential is short-lived, audited, and returned with `Cache-Control: no-store`; it must not be persisted, logged, placed in prompts, or included in company portability output.

## Portability

Company packages use `.paperclip.yaml` schema version 8 for repository entries and portable project/direct-agent slug relationships. Export excludes connection and secret material. Preview reports provider disconnection and unresolved mappings. Import matches normalized clone URLs, recreates missing entries as manual metadata, restores resolvable relationships, and never creates an execution workspace from a repository hint.
