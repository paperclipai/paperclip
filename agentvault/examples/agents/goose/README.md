# Goose Example Agent

This is an example Goose agent configuration for AgentVault.

## Directory Structure

```
goose/
├── goose.yaml      # Primary YAML configuration
├── goose.yml       # Alternative YAML configuration
└── package.json    # Package metadata
```

## Usage

### Initialize Agent

```bash
cd examples/agents/goose
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

### goose.yaml / goose.yml
- Agent name, type, and metadata
- Model selection (gpt-4, gpt-3.5-turbo, etc.)
- Temperature (0.0-2.0) and max tokens
- System prompt for the agent
- Working directory
- Available tools

### .gooserc (alternative format)
You can also use a `.gooserc` file for your Goose configuration:

```yaml
name: my-goose-agent
type: goose
model: gpt-4
temperature: 0.7
maxTokens: 2048
systemPrompt: "Your custom system prompt here"
workingDirectory: .
tools:
  - file-read
  - file-write
```

## Supported Config Files

Goose agents can use any of the following configuration files:
- `goose.yaml` (recommended)
- `goose.yml`
- `.gooserc`

The parser will search for these files in order and use the first one found.

## Agent Capabilities

This Goose agent is configured to:
- Read and write files
- List directory contents
- Execute git commands
- Search code
- Execute shell commands
- Perform web searches

## Customization

To customize this agent for your use case:

1. Edit `goose.yaml` to change agent metadata
2. Update the `model` field to use a different OpenAI model
3. Adjust `temperature` (0.0-2.0) for more deterministic/creative responses
4. Set `maxTokens` for response length limits
5. Customize the `systemPrompt` for agent behavior
6. Modify `workingDirectory` to set the default workspace
7. Add/remove `tools` to limit agent capabilities

## Validation

The Goose parser validates:
- Agent name is required
- Model is required
- Version format (X.Y.Z)
- Temperature range (0.0-2.0)
- Max tokens (must be positive)
- Working directory exists (warning)
- Tools defined (warning if empty)
