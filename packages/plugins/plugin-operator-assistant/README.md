# Operator Assistant

Operator Assistant is a company-scoped, read-only conversational interface for
Paperclip. It retrieves a small evidence bundle from issues, comments, blocker
relationships, projects, agents, and recent heartbeat runs before asking a
managed agent to answer.

Chats are stored in plugin-owned tables. Asking a question does not create,
update, or comment on a Paperclip issue. The managed agent also receives a
read-only Paperclip API identity, so mutation attempts are rejected by the host.
