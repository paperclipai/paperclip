---
title: Departments
summary: Optional company department labels and agent membership
---

Departments are labels. They do not change `reportsTo`. An agent can belong to several departments, or to none. None is an empty membership list, not a stored department.

Company members can read the list. Another company's id returns `404`. `agentIds` on every response includes only agents the caller can read (`agent:read`). Department names are not filtered that way. Listing does not require board access.

Creating a department is board-only. Renaming and deleting a department are board-only. An agent's own `agent_config:update` permission, including the self-update allowance, does not create, rename, or delete company departments.

Replacing an agent's memberships requires `agent_config:update` on that target agent. Board members need the same target grant. A company member without it is denied.

Names are trimmed, internal whitespace is collapsed, and the stored length is 1 to 80 characters. A company cannot have two departments whose names match under case-folding. That collision on create returns the existing department with `200`. A rename collision returns `409`.

An agent can belong to at most 20 departments.

## List departments

```
GET /api/companies/{companyId}/departments
```

Returns each department with `id`, `companyId`, `name`, and `agentIds`.

## Create a department

```
POST /api/companies/{companyId}/departments
{ "name": "Accounting" }
```

`201` when the department is new. `200` when the folded name already exists. The response is the department, including current `agentIds`.

## Rename a department

```
PATCH /api/departments/{departmentId}
{ "name": "Finance" }
```

## Delete a department

```
DELETE /api/departments/{departmentId}
```

Membership rows are removed. Agents are not.

## Replace an agent's departments

```
PUT /api/agents/{agentId}/departments
{
  "departmentIds": ["department-id"],
  "names": ["New department"]
}
```

`departmentIds` replaces the agent's memberships. The ids must belong to the agent's company. An empty array, with `names` omitted, clears every membership. Omitted ids are removed. This is not a union with the previous set.

`names` is optional and board-only, because each new name is a company-wide department. Agents assign departments that already exist by sending `departmentIds`. Each new name is created and added to the same membership set. An existing folded name is reused and is not created again. The creates and the membership replacement commit together. If the combined set is larger than 20, or an id is not in this company, the request returns `400` and leaves both the catalog and the memberships unchanged.

Two overlapping replacements are serialized on the agent row, so the saved set is the last request, not the union of both.

The response is the departments the agent now belongs to.
