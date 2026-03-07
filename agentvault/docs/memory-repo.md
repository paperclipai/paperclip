# MemoryRepo — Git for Agent Souls

MemoryRepo is a git-style version-controlled memory system built as an ICP canister. It gives agents persistent, branching, auditable memory — anchored by a genesis commit from a Soul.md document.

## Architecture

MemoryRepo runs as a separate canister (`memory_repo`) alongside the main `agent_vault` canister:

- **Independent upgrade cycles** — upgrade memory without touching agent execution
- **Separate cycle budgets** — memory operations don't compete with WASM execution
- **Clean separation** — agent execution vs. memory versioning are distinct concerns

## Concepts

### Commits

Every state change is recorded as a commit:

```
{ id, timestamp, message, diff, tags, parent, branch }
```

- **id**: Auto-generated (`c_<timestamp>_<index>`)
- **diff**: The actual content/state change
- **tags**: Semantic labels for categorization (e.g., `chat`, `config`, `soul`)
- **parent**: Previous commit ID (null for genesis)

### Branches

Branches are named pointers to commit IDs. Every repo starts with a `main` branch.

```bash
# List branches
agentvault memory branch

# Create a new branch
agentvault memory branch experiments

# Switch branches
agentvault memory checkout experiments
```

### Genesis Commits

The first commit in a repository is the genesis commit, created from a Soul.md document. This anchors the agent's identity:

```bash
agentvault memory init soul.md
```

### Rebase

Rebase creates a new branch with a new genesis commit (from a new Soul.md), then replays all non-genesis commits. The original branch is preserved:

```bash
agentvault memory rebase --from-soul new-soul.md
```

This creates a `rebase/<timestamp>` branch with the replayed history.

### Merge

Merge brings commits from one branch into another:

```bash
# Auto merge (fails on conflicts)
agentvault memory merge --from-branch feature

# Manual merge (returns all commits for cherry-picking)
agentvault memory merge --from-branch feature --strategy manual
```

**Conflict detection**: Two commits conflict if they share overlapping tags but have different diffs.

### Cherry-Pick

Pick individual commits from any branch:

```bash
agentvault memory cherry-pick c_1234567890_3
```

## CLI Reference

### `memory init [soul-file]`

Initialize a new memory repository from a soul document.

| Option | Description |
|--------|-------------|
| `soul-file` | Path to soul.md (default: `soul.md`) |
| `--canister-id` | MemoryRepo canister ID |

### `memory commit <message>`

Create a new commit on the current branch.

| Option | Description |
|--------|-------------|
| `-d, --diff` | Diff content (required) |
| `-t, --tags` | Comma-separated tags |

### `memory log`

Show the commit log.

| Option | Description |
|--------|-------------|
| `--branch` | Branch name (default: current) |
| `--json` | Output raw JSON |

### `memory status`

Show repository status: initialization state, current branch, commit/branch counts, owner.

### `memory branch [name]`

List all branches (no argument) or create a new branch.

### `memory checkout <branch>`

Switch the current branch.

### `memory show <commit-id>`

Display full details of a specific commit, including its diff.

| Option | Description |
|--------|-------------|
| `--json` | Output raw JSON |

### `memory rebase`

Rebase onto a new soul document.

| Option | Description |
|--------|-------------|
| `--from-soul` | Path to new soul.md (required) |
| `--branch` | Source branch (default: current) |

### `memory merge`

Merge commits from another branch.

| Option | Description |
|--------|-------------|
| `--from-branch` | Branch to merge from (required) |
| `--strategy` | `auto` (default) or `manual` |

### `memory cherry-pick <commit-id>`

Cherry-pick a single commit onto the current branch.

## Canister API

The Motoko canister exposes these methods:

| Method | Type | Description |
|--------|------|-------------|
| `initRepo(text)` | update | Initialize with soul content |
| `commit(text, text, vec text)` | update | Create commit (message, diff, tags) |
| `log(opt text)` | query | Get commit log for branch |
| `getCurrentState()` | query | Get HEAD commit diff |
| `getRepoStatus()` | query | Get repo status |
| `getBranches()` | query | List all branches |
| `createBranch(text)` | update | Create new branch |
| `switchBranch(text)` | update | Switch current branch |
| `getCommit(text)` | query | Get commit by ID |
| `rebase(text, opt text)` | update | Rebase with new soul |
| `merge(text, MergeStrategy)` | update | Merge branch |
| `cherryPick(text)` | update | Cherry-pick commit |

## Deployment

```bash
# Add to dfx.json (already configured)
dfx deploy memory_repo

# Initialize
dfx canister call memory_repo initRepo '("Soul content here")'
```

## Example: Vale Agent

See `examples/vale-agent/` for a complete walkthrough of setting up an autonomous agent with MemoryRepo.
