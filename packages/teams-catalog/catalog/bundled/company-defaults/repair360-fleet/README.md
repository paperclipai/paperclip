# Repair360 Fleet

Repair360 Fleet is a Paperclip team package for a six-department, multi-tenant SaaS operating model.

## Departments

| Department | Owner | Boundary |
| --- | --- | --- |
| Direction & PMO | Fleet Director | priorities, budgets, approvals |
| Customer Success | Sonia | Repair360/RiparaSubito intake |
| Tenant Operations | Chiara | tenant-scoped TEC operations |
| Voice & WhatsApp | Giorgia | MrPhone channel operations |
| Engineering & Integrations | OpenClaw Engineering | implementation and adapters |
| QA, Security & Audit | QA & Audit | tests, isolation, receipts, rollback |

## Workflow

The Director routes bounded work to the department owner. Departments hand off implementation to OpenClaw Engineering and evidence to QA & Audit. Core360 remains the business system of record. No recurring LLM routine is installed; agents wake on assignment or an explicit event.

## Import

Use Paperclip's team catalog preview, review the six agents and the starter task, then import into the target company. Select the OpenClaw gateway adapter during preview if it is not already selected. Credentials are intentionally not part of this package and must be bound through the secret manager.

This package follows the [Agent Companies specification](https://agentcompanies.io/specification) and is designed for [Paperclip](https://github.com/paperclipai/paperclip).

License: MIT.
