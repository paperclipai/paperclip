# Sprint 2024-03-31

## Brief

Build a simple task management application that allows users to create, view, update, and delete tasks with basic priority and due date support.

## Product

**Name:** TaskMaster Lite

**Target User:** Individual productivity enthusiasts who want a lightweight, distraction-free task manager

**Primary Flow:** User logs in → creates task with title/priority/due date → views task list → marks complete

## Data Model

- User (id, email, name, created_at)
- Task (id, user_id, title, priority, due_date, completed, created_at)

## Tech Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: PostgreSQL
- Deployment: Cloudflare Workers + Pages

## V-Label Breakdown

| Label | Minutes |
|-------|---------|
| V1 | 90 |
| V2 | 40 |
| V3 | 30 |

## Risk Assessment

- PostgreSQL connection pooling might be needed if user load is higher than expected
- React form state management could be complex for real-time updates
- Cloudflare D1 SQLite limitations if we scale beyond 1GB data
- Timezone handling in due dates could be error-prone
