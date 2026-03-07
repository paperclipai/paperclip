# Cline Example Agent

This is an example Cline agent configuration for AgentVault.

## Directory Structure

```
cline/
├── cline.json          # Primary JSON configuration
├── cline.config.json   # Alternative JSON configuration
└── package.json        # Package metadata
```

## Usage

### Initialize Agent

```bash
cd examples/agents/cline
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

### cline.json / cline.config.json
- Agent name, type, and metadata
- Mode (auto or request)
- Claude version for model selection
- Working directory
- Auto-confirm for dangerous operations
- Use readline for interactive prompts
- Allowed commands list for security

### .cline (alternative format)
You can also use a `.cline` file for your Cline configuration:

```json
{
  "name": "my-cline-agent",
  "type": "cline",
  "mode": "auto",
  "claudeVersion": "3.5",
  "workingDirectory": ".",
  "autoConfirm": false,
  "useReadline": true,
  "allowedCommands": ["ls", "cat", "git", "npm"]
}
```

## Supported Config Files

Cline agents can use any of following configuration files:
- `cline.json` (recommended)
- `cline.config.json`
- `.cline`

The parser will search for these files in order and use the first one found.

## Configuration Options

### mode
- `auto`: Automatically execute commands (requires allowedCommands)
- `request`: Ask for confirmation before executing commands

### claudeVersion
- Target Claude version (e.g., "3.5", "3.0")
- Used for model selection and compatibility

### autoConfirm
- `true`: Skip confirmation prompts for operations
- `false`: Ask for confirmation before executing

### useReadline
- `true`: Use readline interface for interactive prompts
- `false`: Use alternative input method

### allowedCommands
- Array of commands that can be executed
- **Security critical**: Only allow commands you trust
- Examples: `["git", "npm", "node", "ls", "cat"]`

## Example Use Cases

### Auto Mode with Limited Commands
```json
{
  "mode": "auto",
  "allowedCommands": ["ls", "cat", "grep"],
  "autoConfirm": true
}
```

### Request Mode with Full Permissions
```json
{
  "mode": "request",
  "allowedCommands": ["*"],
  "autoConfirm": false
}
```

### Development Environment
```json
{
  "mode": "request",
  "claudeVersion": "3.5",
  "allowedCommands": [
    "git", "npm", "node", "ts-node",
    "ls", "cat", "mkdir", "rm"
  ],
  "autoConfirm": false,
  "useReadline": true
}
```

## Validation

The Cline parser validates:
- Agent name is required
- Mode must be 'auto' or 'request'
- Version format (X.Y.Z)
- Claude version format (basic validation)
- Working directory exists (warning)
- AllowedCommands must be an array of non-empty strings
- Warning: Auto mode without allowedCommands may be dangerous

## Customization

To customize this agent for your use case:

1. Edit `cline.json` to change agent metadata
2. Set `mode` to control command execution behavior
3. Update `claudeVersion` for model compatibility
4. Configure `allowedCommands` for security
5. Adjust `autoConfirm` and `useReadline` for interaction preferences
6. Set `workingDirectory` to default workspace

## Security Notes

- **Critical**: Always review `allowedCommands` before deploying
- Auto mode with unrestricted commands is dangerous
- Test in request mode before switching to auto
- Use working directory to limit file access
