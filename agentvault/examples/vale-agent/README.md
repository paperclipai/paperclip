# Vale Agent Example

This example demonstrates how to set up an autonomous agent with version-controlled memory using MemoryRepo.

## Prerequisites

- [dfx](https://internetcomputer.org/docs/current/developer-docs/getting-started/install/) installed
- AgentVault CLI installed (`npm install -g agentvault`)

## Step-by-Step Setup

### 1. Start a local ICP replica

```bash
dfx start --background
```

### 2. Deploy the MemoryRepo canister

```bash
dfx deploy memory_repo
```

### 3. Initialize Vale's memory from the soul document

```bash
agentvault memory init soul.md --canister-id $(dfx canister id memory_repo)
```

### 4. Check repository status

```bash
agentvault memory status --canister-id $(dfx canister id memory_repo)
```

### 5. Add a commit

```bash
agentvault memory commit "First interaction" \
  -d "user: Hello Vale" \
  -t chat,interaction \
  --canister-id $(dfx canister id memory_repo)
```

### 6. View the commit log

```bash
agentvault memory log --canister-id $(dfx canister id memory_repo)
```

### 7. Create a branch for experimental state

```bash
agentvault memory branch experiments \
  --canister-id $(dfx canister id memory_repo)

agentvault memory checkout experiments \
  --canister-id $(dfx canister id memory_repo)
```

### 8. Rebase onto a new soul document

```bash
agentvault memory rebase --from-soul soul-v2.md \
  --canister-id $(dfx canister id memory_repo)
```

### 9. Merge branches

```bash
agentvault memory checkout main \
  --canister-id $(dfx canister id memory_repo)

agentvault memory merge --from-branch experiments \
  --canister-id $(dfx canister id memory_repo)
```

## File Structure

```
vale-agent/
  soul.md      — Vale's soul document (genesis identity)
  agent.json   — Agent configuration
  README.md    — This file
```
