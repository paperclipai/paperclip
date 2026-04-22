# Implement Kilocode CLI Adapter for Paperclip

## Goal
Add support for Kilocode CLI as a system agent adapter in Paperclip, following the existing adapter pattern (gemini-local, codex-local, etc.).

## Context
GitHub Issue: https://github.com/paperclipai/paperclip/issues/1185

Kilocode CLI is an AI-powered terminal coding assistant that provides:
- Headless mode for programmatic control
- Session support for persistent conversations
- Multi-language support (TypeScript, Python, JavaScript, etc.)
- File-aware operations (read, edit, analyze codebases)
- Local model execution for privacy and speed
- Integration with custom tools

## Package Structure to Create

```
packages/adapters/kilocode-local/
├── src/
│   ├── index.ts              # Main exports: type, label, models, agentConfigurationDoc
│   ├── server/
│   │   ├── index.ts          # Server adapter exports: execute, testEnvironment, sessionCodec, etc.
│   │   ├── execute.ts        # kilocode CLI execution with proper argument handling
│   │   ├── parse.ts          # JSON output parser for kilocode responses
│   │   ├── test.ts           # Environment diagnostics and command detection
│   │   └── utils.ts          # Utility functions (if needed)
│   ├── ui/
│   │   ├── index.ts          # UI adapter exports: parseStdout, buildConfig
│   │   ├── parse-stdout.ts   # Parse stdout for run transcripts
│   │   ├── build-config.ts   # Build configuration schema
│   │   └── config-fields.tsx # UI configuration fields (React component)
│   └── cli/
│       ├── index.ts          # CLI adapter exports
│       └── format-event.ts   # Format events for CLI output
├── package.json              # Package configuration
├── tsconfig.json             # TypeScript configuration
└── skills/                   # (Optional) Skill symlinks directory
```

## Implementation Steps

### Step 1: Create Package Structure and package.json
1. Create directory: `packages/adapters/kilocode-local/`
2. Create `package.json` (copy from gemini-local and adapt):
   - Name: `@paperclipai/adapter-kilocode-local`
   - Version: `0.1.0`
   - Dependencies: `@paperclipai/adapter-utils`, `picocolors`
   - Proper exports for server, ui, cli

### Step 2: Implement Main Exports (src/index.ts)
- Export type: `"kilocode_local"`
- Export label: `"Kilocode CLI (local)"`
- Export default model: `"auto"`
- Export models array (similar to gemini-local)
- Export agentConfigurationDoc with:
  - Use cases
  - Core fields: command, model, cwd, timeoutSec, extraArgs, env
  - Operational fields: timeoutSec, graceSec
  - Notes about Kilocode CLI specifics

### Step 3: Implement Server Components

#### src/server/index.ts
Export:
- execute function
- testEnvironment function
- sessionCodec (for session resumption)
- models (re-exported from main index)
- supportsLocalAgentJwt: true (if applicable)
- supportsInstructionsBundle: true (if applicable)
- requiresMaterializedRuntimeSkills: true

#### src/server/execute.ts
Implement execution logic (similar to gemini-local/execute.ts):
1. Resolve command (default: "kilocode")
2. Build environment variables (merge env config + PAPERCLIP_* variables)
3. Ensure skills are injected (symlink injection pattern)
4. Build invocation with proper arguments
5. Run child process with timeout
6. Handle streaming responses
7. Parse and return results

Key features:
- Support for session resumption (if kilocode has --resume or similar)
- Skill injection via symlinks (e.g., ~/.kilocode/skills/)
- Error handling for auth/credential issues
- File operation tracking
- JSON output parsing

#### src/server/parse.ts
Implement parsing functions:
- parseKilocodeJsonl: Parse JSONL output from kilocode
- detectKilocodeAuthRequired: Detect authentication errors
- describeKilocodeFailure: Provide user-friendly error messages
- isKilocodeTurnLimitResult: Detect turn/session limit errors
- isKilocodeUnknownSessionError: Detect session errors

#### src/server/test.ts
Implement environment testing:
- testKilocodeEnvironment: Check if kilocode command is available
- Verify version compatibility
- Check authentication status
- Return diagnostic information

### Step 4: Implement UI Components

#### src/ui/index.ts
Export:
- parseStdout function (for run transcript parsing)
- buildConfig function (for configuration schema)

#### src/ui/parse-stdout.ts
Implement stdout parsing (similar to other adapters):
- Parse tool calls
- Parse responses
- Format for UI display

#### src/ui/build-config.ts
Build configuration schema (similar to gemini-local):
- command (string, optional, default: "kilocode")
- model (string, optional)
- cwd (string, optional)
- timeoutSec (number, optional)
- graceSec (number, optional)
- extraArgs (array, optional)
- env (object, optional)
- promptTemplate (string, optional)
- instructionsFilePath (string, optional)

#### src/ui/config-fields.tsx
React component for UI configuration fields:
- Input fields for each config parameter
- Proper types and validation
- Help text for each field

### Step 5: Implement CLI Components

#### src/cli/index.ts
Export:
- formatEvent function

#### src/cli/format-event.ts
Format events for CLI output (similar to other adapters)

### Step 6: Register Adapters

#### server/src/adapters/registry.ts
Add kilocode_local adapter registration:
```typescript
import { kilocodeLocalAdapter } from "@paperclipai/adapter-kilocode-local/server";

// Add to adapters array
kilocodeLocalAdapter,
```

#### ui/src/adapters/registry.ts
Add kilocode_local UI adapter registration:
```typescript
import { kilocodeLocalUIAdapter } from "@paperclipai/adapter-kilocode-local/ui";

// Add to registerBuiltInUIAdapters()
kilocodeLocalUIAdapter,
```

#### cli/src/adapters/registry.ts
Add kilocode_local CLI adapter registration (if CLI registry exists)

### Step 7: TypeScript Configuration
Create tsconfig.json (copy from gemini-local and adapt)

### Step 8: Update Root Dependencies
Add the new adapter to any workspace configuration if needed

### Step 9: Testing and Validation
1. Run typecheck: `pnpm -r typecheck`
2. Run tests: `pnpm test`
3. Build: `pnpm build`
4. Verify adapter is registered correctly
5. Test basic functionality (if kilocode CLI is available)

## Key Features to Implement

1. **Session Resumption**: Support for persistent conversations across runs
2. **Error Handling**: Clear error messages for auth, credentials, and common failures
3. **File Operations**: Workspace-aware file operations with safety checks
4. **JSON Parsing**: Structured response parsing for kilocode output
5. **Skill Injection**: Symlink-based skill injection (pattern from gemini-local)
6. **Authentication**: Handle API keys or local credentials
7. **Model Selection**: Support custom model selection (local vs cloud-based)
8. **Streaming**: Handle streaming responses for long operations
9. **Paperclip Integration**: Support PAPERCLIP_* environment variables
10. **Timeout Handling**: Proper timeout and grace period support

## Configuration Fields

- **command**: CLI executable (default: "kilocode")
- **model**: Model selection (optional, default: "auto")
- **cwd**: Working directory for file operations (optional)
- **timeoutSec**: Execution timeout in seconds (optional)
- **graceSec**: SIGTERM grace period in seconds (optional)
- **extraArgs**: Additional CLI arguments (optional)
- **env**: Environment variables for API keys and configuration (optional)
- **promptTemplate**: Run prompt template (optional)
- **instructionsFilePath**: Absolute path to instructions file (optional)

## Notes

- Follow the exact pattern from existing adapters (gemini-local, codex-local)
- Maintain consistency in code style and structure
- Use the same utility functions from @paperclipai/adapter-utils
- Ensure all TypeScript types are properly exported
- Include proper error handling and user-friendly messages
- Document any Kilocode CLI-specific behavior in agentConfigurationDoc
- Test with the Kilocode CLI documentation (if available) for correct command syntax

## References

- Issue: https://github.com/paperclipai/paperclip/issues/1185
- Similar adapters: gemini-local, codex-local, opencode-local
- Kilocode CLI documentation (to be researched if needed)
