# Rule: Company Scoping

Every domain entity and operation in Paperclip must be strictly scoped to a company to ensure multi-tenant safety and organizational boundaries.

- **Activation**: `Always On`

## Guidelines

- **Entity Ownership**: Every database record (tasks, agents, projects, etc.) MUST have a `companyId` foreign key.
- **Route Protection**: All API endpoints (under `/api`) must verify that the requesting actor has access to the specified `:companyId`.
- **Service Isolation**: Service methods should always take a `companyId` context and include it in all database queries and storage operations.
- **Global Objects**: Avoid creating entities that exist outside of a company unless explicitly specified in the core architecture (e.g., system-level users or auth).
- **Leak Prevention**: Ensure that one company's data is never visible to another, regardless of the actor's permissions within their own company.
