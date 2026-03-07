# AgentVault Canister

This directory contains the Motoko canister code for the AgentVault platform.

## Canister Features

The `agent.mo` canister provides:

- **Agent Lifecycle**: Initialize, configure, and manage agent lifecycle
- **Memory Management**: Store, retrieve, and manage agent memories
- **Task Queue**: Submit and execute tasks with status tracking
- **Context Storage**: Key-value context storage for agent state
- **Agent Execution**: Execute agent logic with step and batch operations
- **System Status**: Query canister status, metrics, and health

## API Reference

### Agent Configuration

- `getAgentConfig()`: Get agent configuration
- `setAgentConfig(config)`: Set agent configuration (one-time)

### Memory Operations

- `addMemory(memory)`: Add a memory entry
- `getMemories()`: Get all memories
- `getMemoriesByType(type)`: Get memories filtered by type
- `clearMemories()`: Clear all memories

### Task Management

- `addTask(task)`: Add a task to the queue
- `getTasks()`: Get all tasks
- `getPendingTasks()`: Get pending tasks
- `getRunningTasks()`: Get running tasks
- `updateTaskStatus(id, status, result)`: Update task status
- `clearTasks()`: Clear all tasks

### Context Management

- `setContext(key, value)`: Set a context value
- `getContext(key)`: Get a context value
- `getAllContext()`: Get all context entries
- `clearContext()`: Clear all context

### Agent Execution

- `execute(input)`: Execute agent with input
- `executeBatch(inputs)`: Execute multiple inputs in batch

### System

- `getCanisterStatus()`: Get canister status
- `getMetrics()`: Get canister metrics
- `heartbeat()`: Maintenance heartbeat

## Deployment

Build and deploy the canister using the AgentVault CLI:

```bash
# Build agent to WASM
agentvault package ./my-agent

# Deploy to canister
agentvault deploy dist/my-agent.wasm
```

## Data Structures

### Memory
```motoko
type Memory = {
  id : Text;
  memoryType : { #fact; #user_preference; #task_result };
  content : Text;
  timestamp : Int;
  importance : Nat8;
};
```

### Task
```motoko
type Task = {
  id : Text;
  description : Text;
  status : { #pending; #running; #completed; #failed };
  result : ?Text;
  timestamp : Int;
};
```

### AgentConfig
```motoko
type AgentConfig = {
  name : Text;
  agentType : Text;
  version : Text;
  createdAt : Int;
};
```

## Stable Memory

All data (memories, tasks, context, configuration) is stored in stable memory, ensuring persistence across canister upgrades and restarts.
