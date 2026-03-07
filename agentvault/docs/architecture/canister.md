# Canister Architecture

AgentVault canister internals and design.

## Canister Overview

AgentVault deploys AI agents as ICP canisters. Each canister:

- Runs agent code compiled to WASM
- Stores agent state persistently
- Executes tasks autonomously
- Reports health and metrics

## Canister Structure

```
┌─────────────────────────────────────────────────────────────┐
│                        Canister                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    WASM Module                           ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       ││
│  │  │  Agent      │ │  State      │ │  API        │       ││
│  │  │  Logic      │ │  Manager    │ │  Handlers   │       ││
│  │  └─────────────┘ └─────────────┘ └─────────────┘       ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Stable Memory                         ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       ││
│  │  │  Tasks      │ │  Context    │ │  Config     │       ││
│  │  │  Queue      │ │  Data       │ │  Settings   │       ││
│  │  └─────────────┘ └─────────────┘ └─────────────┘       ││
│  └─────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Heap Memory                           ││
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       ││
│  │  │  Runtime    │ │  Cache      │ │  Temp       │       ││
│  │  │  Objects    │ │  Data       │ │  Buffers    │       ││
│  │  └─────────────┘ └─────────────┘ └─────────────┘       ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Candid Interface

### Core Types

```candid
// Agent status
type AgentStatus = variant {
  idle;
  running;
  paused;
  error;
};

// Task definition
type Task = record {
  id: text;
  input: text;
  status: TaskStatus;
  result: opt text;
  created_at: int;
  completed_at: opt int;
};

// Task status
type TaskStatus = variant {
  pending;
  running;
  completed;
  failed;
};

// Health status
type HealthStatus = record {
  status: text;
  cycles: nat;
  memory: nat;
  timestamp: int;
};
```

### Core Methods

```candid
// Query methods (free, immediate)
query func getStatus() : async AgentStatus;
query func getTask(id: text) : async ?Task;
query func getTasks() : async [Task];
query func getHealth() : async HealthStatus;
query func getState() : async State;

// Update methods (costs cycles, async)
update func execute(input: text) : async Task;
update func pause() : async ();
update func resume() : async ();
update func configure(config: Config) : async ();
```

## State Management

### Stable Memory

Data persisted across upgrades:

```typescript
interface StableState {
  tasks: Map<string, Task>;
  context: AgentContext;
  config: AgentConfig;
  version: string;
}
```

### Heap Memory

Runtime data (lost on upgrade):

```typescript
interface HeapState {
  cache: Map<string, any>;
  connections: Map<string, Connection>;
  buffers: Buffer[];
}
```

### State Migration

On canister upgrade:

1. Pre-upgrade: Serialize heap to stable memory
2. Upgrade: Install new WASM
3. Post-upgrade: Deserialize stable to heap

## Canister Lifecycle

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│ Created │────▶│  Idle   │────▶│ Running │────▶│ Stopped │
└─────────┘     └─────────┘     └─────────┘     └─────────┘
                     │               │               │
                     │               │               │
                     ▼               ▼               ▼
                 Paused         Executing       Deleted
                                Tasks
```

## Inter-Canister Calls

Agent canisters can call other canisters:

```typescript
// Call another canister
const result = await actor.other_canister.method(args);

// With cycles
await ic.call_with_cycles(
  other_canister_principal,
  method_name,
  args,
  cycles_amount
);
```

## Cycles Management

### Cycles Consumption

| Operation | Approximate Cost |
|-----------|------------------|
| Query call | Free |
| Update call | ~0.01 T cycles |
| Canister create | ~100 B cycles |
| Storage per GB | ~400 B cycles/year |

### Cycles Monitoring

```bash
# Check cycles balance
agentvault cycles balance <canister-id>

# Top-up cycles
agentvault cycles top-up <canister-id> --amount 1T

# View history
agentvault cycles history <canister-id>
```

## Controllers

### Controller Types

| Type | Permissions |
|------|-------------|
| `controller` | Full control (install, stop, delete) |
| `settings_controller` | Modify settings only |

### Managing Controllers

```bash
# List controllers
dfx canister info <canister-id>

# Add controller
dfx canister update-settings --add-controller <principal>

# Remove controller
dfx canister update-settings --remove-controller <principal>
```

## Upgrades

### Upgrade Process

1. **Prepare**: Backup state
2. **Stop**: Stop canister
3. **Install**: Install new WASM
4. **Start**: Start canister
5. **Verify**: Check health

```bash
# Upgrade canister
agentvault deploy --canister-id <id> --upgrade
```

### Upgrade Safety

- Use `pre_upgrade` and `post_upgrade` hooks
- Test upgrades on local replica first
- Always backup before upgrading

## Security

### Canister Sandbox

Each canister runs in isolation:

- Memory isolation
- No direct file system access
- Limited network access (HTTPS outcalls)
- Controlled inter-canister calls

### Access Control

```candid
// Check caller
func requires_controller() {
  let caller = ic.caller();
  if (not is_controller(caller)) {
    throw Error.reject("Unauthorized");
  };
};
```

## Monitoring

### Health Endpoints

```bash
# Basic health
agentvault health <canister-id>

# Detailed status
agentvault info <canister-id>

# Statistics
agentvault stats <canister-id>
```

### Metrics Available

| Metric | Description |
|--------|-------------|
| `requests` | Total requests |
| `errors` | Error count |
| `latency` | Response time |
| `memory` | Memory usage |
| `cycles` | Cycles balance |

## Canister Code (Motoko)

### Example Structure

```motoko
// Main canister
actor class Agent() = this {
  // Stable state
  stable var tasks : [(Text, Task)] = [];
  stable var config : Config = defaultConfig;

  // State manager
  let state = StateManager(tasks, config);

  // Query: Get status
  public query func getStatus() : async AgentStatus {
    state.getStatus()
  };

  // Update: Execute task
  public shared(msg) func execute(input : Text) : async Task {
    state.execute(input, msg.caller)
  };

  // System: Pre-upgrade
  system func preupgrade() {
    tasks := state.serialize();
  };

  // System: Post-upgrade
  system func postupgrade() {
    state.deserialize(tasks);
  };
};
```

## Next Steps

- [Architecture Overview](./overview.md) - System architecture
- [Modules](./modules.md) - Module reference
- [Deployment Guide](../user/deployment.md) - Deploy canisters
