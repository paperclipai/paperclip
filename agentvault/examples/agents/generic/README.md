# Generic Example Agent

This is an example Generic agent configuration for AgentVault.

## Directory Structure

```
generic/
├── agent.json      # Primary JSON configuration
├── agent.yaml      # Alternative YAML configuration
├── index.js        # Example entry point
└── package.json    # Package metadata
```

## Usage

### Initialize Agent

```bash
cd examples/agents/generic
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

### agent.json / agent.yaml
- Agent name, type, and metadata
- Entry point for agent execution
- Working directory
- Environment variables
- Allowed file patterns (glob)
- Maximum file size limit

### .agentvault.json (alternative format)
You can also use a `.agentvault.json` file:

```json
{
  "name": "my-generic-agent",
  "type": "generic",
  "entryPoint": "index.js",
  "workingDirectory": ".",
  "environment": {
    "API_KEY": "xxx"
  }
}
```

## Supported Config Files

Generic agents can use any of following configuration files:
- `agent.json` (recommended)
- `agent.yaml`
- `agent.yml`
- `agentvault.json`
- `.agentvault.json`

The parser will search for these files in order and use the first one found.

## Configuration Options

### entryPoint
- Path to the main agent executable file
- Relative to agent source directory
- Examples: `index.js`, `src/index.ts`, `main.py`

### workingDirectory
- Default working directory for agent operations
- Relative to agent source directory
- Default: current directory

### environment
- Object of environment variables
- All values must be strings
- Examples:
  ```json
  {
    "NODE_ENV": "production",
    "API_KEY": "sk-xxx",
    "PORT": "3000"
  }
  ```

### allowedFiles
- Array of glob patterns for file access control
- Security feature to limit file system access
- Examples:
  ```json
  ["*.js", "*.ts", "src/**", "lib/**"]
  ```

### maxFileSize
- Maximum file size in bytes
- Set to limit memory usage and prevent large file processing
- Example: `10485760` (10MB)
- Warning shown if > 100MB

## Example Use Cases

### Simple Node.js Agent
```json
{
  "name": "simple-node-agent",
  "type": "generic",
  "entryPoint": "index.js",
  "workingDirectory": "."
}
```

### Python Agent with Environment
```yaml
name: python-agent
type: generic
entryPoint: main.py
workingDirectory: ./src
environment:
  PYTHONPATH: "./src"
  LOG_LEVEL: "info"
```

### Secure TypeScript Agent
```json
{
  "name": "secure-ts-agent",
  "entryPoint": "dist/index.js",
  "allowedFiles": ["*.ts", "*.js", "src/**"],
  "maxFileSize": 5242880,
  "environment": {
    "NODE_ENV": "production"
  }
}
```

## Validation

The Generic parser validates:
- Agent name is required
- Version format (X.Y.Z)
- Entry point exists (warning if not)
- Working directory exists (warning if not)
- AllowedFiles must be an array of non-empty strings
- maxFileSize must be positive number
- Environment variables must be string values
- Warning if maxFileSize is very large (> 100MB)
- Warning if no entry point defined

## Customization

To customize this agent for your use case:

1. Edit `agent.json` or `agent.yaml` to change agent metadata
2. Set `entryPoint` to your main executable file
3. Configure `workingDirectory` for the default workspace
4. Add `environment` variables for your configuration
5. Set `allowedFiles` to restrict file access
6. Configure `maxFileSize` to limit memory usage

## File Pattern Matching

The `allowedFiles` field uses glob patterns:
- `*` - Match any files in current directory
- `**` - Match any files recursively
- `*.js` - Match all .js files
- `src/**` - Match all files in src/ directory
- `test/**/*.spec.ts` - Match test files recursively

## Security Notes

- Use `allowedFiles` to limit file system access
- Set `maxFileSize` to prevent DoS via large files
- Use environment variables for secrets (don't hardcode)
- Validate entry point file exists before deployment
- Test agent in development environment first
