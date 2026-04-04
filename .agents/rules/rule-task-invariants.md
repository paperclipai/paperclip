# Rule: Task Invariants

Protect the integrity of agent assignments and atomic checkouts. Ensure that a task is never being actively worked on by more than one agent or human at a time.

- **Activation**: `Always On`

## Guidelines

- **Single Assignee**: Every active task must have exactly one (or zero) assigned `agentId` or `userId`.
- **Atomic Checkout**: The transition of a task to `in_progress` must be atomic (e.g., using a database transaction with a check for current status).
- **Status Consistency**: A task in `completed` status cannot be checked out or modified without first being reverted to a valid pending status.
- **Concurrency Control**: Use database-level locking or explicit optimistic concurrency checks when updating task state to prevent race conditions.
