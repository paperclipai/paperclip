---
title: Departments
summary: Optional company department labels and agent membership
---

Departments are labels. They do not change `reportsTo`. An agent can belong to several departments, or to none. None is an empty membership list, not a stored department.

Board access is required for every write. Company members can read the list. Another company's id returns `404`.

Names are trimmed, internal whitespace is collapsed, and the stored length is 1 to 80 characters. A company cannot have two departments whose names match under case-folding. That collision on create returns the existing department with `200`. A rename collision returns `409`.

An agent can belong to at most 20 departments.

## List departments

```
GET /api/companies/{companyId}/departments
```

Returns each department with `id`, `companyId`, `name`, and `agentIds`. `agentIds` on every department response includes only agents the caller is allowed to read.

## Create a department

```
POST /api/companies/{companyId}/departments
{ "name": "Accounting" }
```

Board only. `201` when the department is new. `200` when the folded name already exists. The response is the department, including current `agentIds`.

## Rename a department

```
PATCH /api/departments/{departmentId}
{ "name": "Finance" }
```

Board only.

## Delete a department

```
DELETE /api/departments/{departmentId}
```

Board only. Membership rows are removed. Agents are not.

## Replace an agent's departments

```
PUT /api/agents/{agentId}/departments
{ "departmentIds": ["department-id"] }
```

Board only. This replaces the agent's memberships with `departmentIds`. The ids must belong to the agent's company. An empty array clears every membership. Two overlapping replacements are serialized on the agent row, so the saved set is the last request, not the union of both. More than 20 ids returns `400` and leaves the previous memberships in place.

The response is the departments the agent now belongs to.
