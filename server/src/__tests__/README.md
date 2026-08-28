# Server Tests

Server tests that need a real PostgreSQL process must use
`./helpers/embedded-postgres.ts` instead of constructing `embedded-postgres`
directly.

The shared helper creates a throwaway data directory and a reserved-safe
loopback port for each test database. This protects the live Paperclip
control-plane Postgres from server vitest runs; see PAP-2033 for the incident
that introduced this guard.
