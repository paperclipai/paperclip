# Task Breakdown — Sprint 2024-03-31

## Frontend Tasks (Engineer Alpha)

| Task ID | Title | Description | Acceptance Criteria | Estimate | Assignment | V-Label | Dependencies |
|---------|-------|-------------|-------------------|----------|------------|---------|--------------|
| F1 | Auth UI | Build login/signup pages with email validation | Form validates, shows errors, submits to backend | 30 | Alpha | V1 | - |
| F2 | Task List View | Display tasks in sortable/filterable table | Lists all user tasks, can sort by priority and date | 25 | Alpha | V1 | F1 |
| F3 | Task Creation | Build modal form to create new tasks | Form opens, collects title/priority/due_date, submits | 20 | Alpha | V1 | F2 |
| F4 | Task Details | Modal showing full task info with edit button | Shows task, allows inline edit of title | 15 | Alpha | V2 | F3 |

## Backend Tasks (Engineer Beta)

| Task ID | Title | Description | Acceptance Criteria | Estimate | Assignment | V-Label | Dependencies |
|---------|-------|-------------|-------------------|----------|------------|---------|--------------|
| B1 | Auth API | POST /auth/login, POST /auth/signup endpoints | Validates email, hashes password, returns JWT | 35 | Beta | V1 | - |
| B2 | Task CRUD | POST/GET/PUT/DELETE /tasks endpoints | CRUD ops work, user isolation enforced | 35 | Beta | V1 | B1 |
| B3 | Database | Create users and tasks tables in PostgreSQL | Tables created, indexes on user_id | 15 | Beta | V1 | - |
| B4 | Task Filtering | Add query params for priority, due_date sorting | Filter params work, return correct results | 10 | Beta | V2 | B2 |

## Summary

- **Total V1 Time**: 90 minutes (F1, F2, F3, B1, B2, B3)
- **Total V2 Time**: 40 minutes (F4, B4)
- **Parallelization**: Alpha and Beta start simultaneously at their respective task queues
- **Critical Path**: B1 (auth) must complete before Alpha can test F1
