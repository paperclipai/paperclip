# Clawdbot Example Agent

This is an example Clawdbot agent configuration for AgentVault.

## Directory Structure

```
.clawdbot/
├── config.json      # Agent metadata and configuration
├── projects.json    # Project definitions
├── tasks.json       # Task definitions
├── context.json     # Agent capabilities and preferences
└── settings.json    # Model and execution settings
```

## Usage

### Initialize Agent

```bash
cd examples/agents/clawdbot
agentvault init --verbose
```

### Package Agent

```bash
agentvault package
```

### Deploy to ICP

```bash
agentvault deploy
```

## Configuration Files

### config.json
- Agent name, type, and metadata
- Version information
- Description

### projects.json
- Project definitions with status tracking
- Project settings and priorities
- Root paths and timestamps

### tasks.json
- Task definitions linked to projects
- Task status and priority
- Dependencies and assignments

### context.json
- Agent capabilities
- Language and framework preferences
- Integration configurations

### settings.json
- Model selection (claude-3-5-sonnet-20241022)
- Temperature (0.7) and max tokens (4096)
- Logging and performance settings
- Security constraints

## Agent Capabilities

This Clawdbot agent is configured to:
- Generate code (TypeScript/React)
- Review code changes
- Refactor components
- Generate documentation
- Create tests

## Customization

To customize this agent for your use case:

1. Edit `.clawdbot/config.json` to change agent metadata
2. Update `.clawdbot/settings.json` to change model parameters
3. Modify `.clawdbot/projects.json` to define your projects
4. Add tasks to `.clawdbot/tasks.json`
5. Adjust `.clawdbot/context.json` to set agent capabilities
