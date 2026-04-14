# PostgreSQL Testing Setup

This document explains how to run PostgreSQL database tests that are currently being skipped due to embedded PostgreSQL initialization failures.

## Problem

When running the test suite, you may see messages like:

```
Skipping embedded Postgres migration tests on this host: Failed to initialize embedded PostgreSQL for testing: Postgres init script exited with code null. Please check the logs for extra info. The data directory might already exist.
```

This occurs because:
1. Another PostgreSQL instance is already running on the system
2. The embedded PostgreSQL library cannot allocate shared memory due to macOS kernel limits (`kern.sysv.shm*`)
3. Port conflicts with existing PostgreSQL instances

## Solutions

### Option 1: Stop Existing PostgreSQL (Recommended for CI)

If you're running tests in a clean CI environment or can stop existing PostgreSQL instances:

```bash
# Stop homebrew PostgreSQL
brew services stop postgresql@16

# Or stop system PostgreSQL
sudo systemctl stop postgresql  # Linux
sudo launchctl unload /Library/LaunchDaemons/org.postgresql.postgres.plist  # macOS
```

Then run tests normally:
```bash
pnpm test
```

### Option 2: Increase Shared Memory Limits (macOS)

If you need to keep PostgreSQL running, you can increase macOS shared memory limits:

```bash
# Check current limits
sysctl -a | grep shm

# Increase limits (requires reboot)
sudo sysctl -w kern.sysv.shmseg=32
sudo sysctl -w kern.sysv.shmmax=1073741824
sudo sysctl -w kern.sysv.shmall=262144

# Make permanent by adding to /etc/sysctl.conf:
echo "kern.sysv.shmseg=32" | sudo tee -a /etc/sysctl.conf
echo "kern.sysv.shmmax=1073741824" | sudo tee -a /etc/sysctl.conf  
echo "kern.sysv.shmall=262144" | sudo tee -a /etc/sysctl.conf
```

### Option 3: Run Tests Against Existing PostgreSQL

If you have a PostgreSQL instance running and want to use it for testing:

1. Ensure your `DATABASE_URL` points to a PostgreSQL instance where you can create/drop databases:
   ```bash
   export DATABASE_URL="postgresql://username:password@localhost:5432/postgres"
   ```

2. The database user needs permissions to:
   - Create databases
   - Drop databases  
   - Create tables and run migrations

3. Run specific non-embedded tests:
   ```bash
   # Run only tests that don't require embedded PostgreSQL
   pnpm test --grep "(?!embedded)"
   ```

### Option 4: Docker PostgreSQL

Use Docker to run a clean PostgreSQL instance for testing:

```bash
# Start PostgreSQL in Docker
docker run -d --name postgres-test \\
  -e POSTGRES_DB=postgres \\
  -e POSTGRES_USER=test \\
  -e POSTGRES_PASSWORD=test \\
  -p 5433:5432 \\
  postgres:16

# Set test database URL
export DATABASE_URL="postgresql://test:test@localhost:5433/postgres"

# Run tests
pnpm test

# Clean up
docker stop postgres-test && docker rm postgres-test
```

## Skipped Test Files

The following test files are currently being skipped due to embedded PostgreSQL issues:

- `packages/db/src/client.test.ts` - Database migration tests
- `server/src/__tests__/workspace-runtime.test.ts` - Workspace runtime tests  
- `server/src/__tests__/execution-workspaces-service.test.ts` - Execution workspace service tests
- `server/src/__tests__/issues-service.test.ts` - Issues service tests
- `server/src/__tests__/routines-e2e.test.ts` - Routines end-to-end tests
- `server/src/__tests__/heartbeat-process-recovery.test.ts` - Heartbeat recovery tests
- `server/src/__tests__/routines-service.test.ts` - Routines service tests
- `server/src/__tests__/company-import-export-e2e.test.ts` - Company import/export tests

## Monitoring Test Coverage

To see how many tests are being skipped:

```bash
pnpm test 2>&1 | grep -E "(skipped|Tests.*passed)"
```

When embedded PostgreSQL is working properly, you should see:
- Fewer skipped tests
- More comprehensive database integration test coverage

## Troubleshooting

### Check PostgreSQL Processes
```bash
ps aux | grep postgres
```

### Check Shared Memory Usage
```bash
ipcs -m  # Show shared memory segments
```

### View Recent PostgreSQL Logs
```bash
# Homebrew PostgreSQL
tail -f /opt/homebrew/var/log/postgresql@16.log

# System PostgreSQL (varies by system)
tail -f /var/log/postgresql/postgresql-*.log
```

### Test Database Connection
```bash
psql $DATABASE_URL -c "SELECT version();"
```