# Agent Instruction Templates

Version-controlled instruction files for all Paperclip agents. Templates are organised by deployment group and role.

## Directory Structure

```
config/agent-instructions/
├── product/          # Shared across AnytimeInterview, Bespoke, GymToGreen, ScreenTimeMath
│   ├── ceo/
│   ├── pre-planner/
│   ├── executor/
│   ├── supervisor/
│   ├── security/
│   ├── triage/
│   └── test/
├── dickbot/          # DickBot holding company (unique instructions)
│   ├── ceo/
│   ├── analyst/
│   ├── pre-planner/
│   ├── executor/
│   └── supervisor/
├── test-company/     # Test company (CEO + CTO only)
│   ├── ceo/
│   └── cto/
├── deploy.sh         # Deploy templates to ~/.paperclip/
└── README.md
```

## Usage

```bash
# Preview what would change (no modifications)
./config/agent-instructions/deploy.sh --dry-run

# Deploy all companies
./config/agent-instructions/deploy.sh

# Deploy one company only
./config/agent-instructions/deploy.sh --company GymToGreen
```

## Workflow

1. Edit templates in this directory
2. Commit and push
3. Run `deploy.sh` on the Mac Mini to apply changes
4. Verify agents pick up new instructions on next heartbeat

## Notes

- Templates are role-generic within each group (no company names or IDs)
- Company-specific context comes from Paperclip's `promptTemplate` field and goal ancestry
- The deploy script queries the Paperclip DB to map agents to template directories
- Deploy is idempotent: running with no template changes produces no filesystem changes
