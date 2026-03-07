# Clawdbot / Claude skill: install, bootstrap, and backup (AgentVault v1.0)

Use this page as a simple operator runbook.

## 1) Install AgentVault CLI

```bash
npm install -g agentvault
agentvault --help
```

If using the repository source:

```bash
git clone https://github.com/johnnyclem/agentvault.git
cd agentvault
npm install
npm run build
node dist/cli/index.js --help
```

## 2) Bootstrap a new agent project

```bash
agentvault init my-agent
cd my-agent
```

Expected result:

- `.agentvault/` config directory exists.
- project is ready for packaging.

## 3) Package and deploy

Start local ICP replica (for local testing):

```bash
dfx start --background
```

Package your agent:

```bash
agentvault package ./
```

Deploy:

```bash
agentvault deploy --network local
```

## 4) Verify status and health

```bash
agentvault status
agentvault health
```

Use `agentvault info` for additional runtime details.

## 5) Backup your agent

Run a backup after successful deployment and periodically after updates:

```bash
agentvault backup --canister-id <YOUR_CANISTER_ID>
```

Recommended backup cadence:

- Before each deployment
- After major state changes
- Daily for production agents

## 6) Restore and recovery checks

To validate disaster recovery readiness, perform recurring test restores in a non-production environment:

```bash
agentvault fetch --canister-id <YOUR_CANISTER_ID>
```

Then compare expected state snapshots and run smoke checks.

## Suggested Claude skill snippet

You can copy this into your Claude/Clawdbot operational prompt:

> When managing AgentVault agents, always follow this order: install/verify CLI, bootstrap project, package, deploy, run status + health checks, then create a backup. Never deploy without a fresh backup. For any incident, fetch and verify the latest known-good state before attempting rollback.

## Minimal day-2 operations checklist

- [ ] `agentvault status` is healthy.
- [ ] last backup completed and is timestamped.
- [ ] restore drill tested recently.
- [ ] deployment change log captured.
