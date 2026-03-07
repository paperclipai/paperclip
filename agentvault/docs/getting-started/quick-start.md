# Quick Start // Initial Sync Sequence

Deploy your first AgentVault entity in under 10 minutes.

:::note Prerequisites
- Node.js 18+
- `dfx` installed and reachable in PATH
- AgentVault CLI installed (`npm install -g agentvault`)
:::

## 1. Initialize Project Vessel

```bash
agentvault init my-first-agent
cd my-first-agent
```

This creates a baseline project with config, source, and package metadata.

## 2. Activate Local ICP Runtime

```bash
dfx start --background
dfx ping
```

## 3. Package Entity Artifacts

```bash
agentvault package ./
```

This compiles the agent and prepares deterministic deployment output.

## 4. Deploy to Local Network

```bash
agentvault deploy --network local
```

Capture the emitted canister ID from command output.

## 5. Verify Operational State

```bash
agentvault status
agentvault info
agentvault health
```

## 6. Execute a Task

```bash
agentvault exec --canister-id <YOUR_CANISTER_ID> "hello world"
```

## 7. Read and Preserve State

```bash
agentvault show --canister-id <YOUR_CANISTER_ID>
agentvault backup --canister-id <YOUR_CANISTER_ID>
```

:::tip Divine Efficiency
Automate `status`, `health`, and `backup` checks in your local CI before promoting deployments.
:::

## Next Protocols

| Goal | Guide |
| --- | --- |
| Complete operational walkthrough | [Tutorial](/docs/user/tutorial-v1.0) |
| Mainnet deployment strategy | [Deployment Guide](/docs/user/deployment) |
| Multi-chain wallet operations | [Wallet Guide](/docs/user/wallets) |
| Full command surface | [CLI Reference](/docs/cli/reference) |

## Common Command Set

```bash
# List all local agents
agentvault list

# View runtime logs
agentvault logs <canister-id>

# Fetch state for local reconstruction
agentvault fetch --canister-id <canister-id>

# Inspect cycle balance
agentvault cycles balance <canister-id>
```

## Help

```bash
agentvault --help
agentvault <command> --help
```

See [Troubleshooting](/docs/user/troubleshooting) when commands fail or outputs diverge.
