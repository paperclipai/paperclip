# Creating a Plugin

This guide walks you through creating a custom Paperclip plugin.

## Prerequisites

- Node.js >= 20
- TypeScript >= 5.5
- Paperclip SDK: `@paperclipai/plugin-sdk`
- Familiarity with MCP (Model Context Protocol)

## Step 1: Initialize the Project

```bash
mkdir my-plugin
cd my-plugin
pnpm init

pnpm add @paperclipai/plugin-sdk zod
pnpm add -D typescript @types/node
```

## Step 2: Create package.json

```json
{
  "name": "@paperclipai/plugin-my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.5.0"
  }
}
```

## Step 3: Create tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## Step 4: Create the Plugin Manifest

Create `src/manifest.ts`:

```typescript
import { PluginManifest } from '@paperclipai/plugin-sdk';
import { z } from 'zod';

export const manifest: PluginManifest = {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'My custom Paperclip plugin',
  tools: [
    {
      name: 'my_tool',
      description: 'Description of what this tool does',
      inputSchema: z.object({
        param1: z.string().describe('First parameter'),
        param2: z.number().optional().describe('Optional second parameter'),
      }),
      handler: async (input, context) => {
        // Tool implementation
        return {
          success: true,
          data: {
            result: `Processed ${input.param1}`,
          },
        };
      },
    },
    // Add more tools...
  ],
};
```

## Step 5: Create the Entry Point

Create `src/index.ts`:

```typescript
export { manifest } from './manifest.js';
```

## Step 6: Implement Tool Handlers

Create `src/worker.ts` for complex tool logic:

```typescript
import { ToolContext } from '@paperclipai/plugin-sdk';

export async function myToolHandler(
  input: { param1: string; param2?: number },
  context: ToolContext
) {
  // Access agent context
  const { agentId, companyId, taskId } = context;

  // Implement your logic
  const result = await doSomething(input.param1);

  return {
    success: true,
    data: {
      result,
      metadata: {
        processedAt: new Date().toISOString(),
      },
    },
  };
}

async function doSomething(param: string): Promise<string> {
  // Your implementation
  return `Processed: ${param}`;
}
```

## Step 7: Build and Test

```bash
pnpm run typecheck
pnpm run build
```

Check the output:

```bash
ls -la dist/
# Should have: index.js, index.d.ts, manifest.js, manifest.d.ts
```

## Step 8: Install Locally

In your Paperclip project:

```bash
pnpm add file:../my-plugin
```

Or publish to npm:

```bash
npm publish --access public
```

## Step 9: Enable the Plugin

Add to your Paperclip config:

```yaml
# config.yaml
plugins:
  - my-plugin
```

Or via environment:

```bash
export PAPERCLIP_PLUGINS=my-plugin
```

## Tool Schema Best Practices

### Use Descriptive Names

```typescript
// ❌ Bad
{ name: 'do_thing' }

// ✅ Good
{ name: 'deploy_to_production' }
```

### Document Parameters

```typescript
inputSchema: z.object({
  environment: z
    .enum(['staging', 'production'])
    .describe('Target deployment environment'),
  branch: z
    .string()
    .default('main')
    .describe('Git branch to deploy'),
  skipTests: z
    .boolean()
    .default(false)
    .describe('Skip test suite before deploy'),
});
```

### Return Structured Data

```typescript
return {
  success: true,
  data: {
    deploymentId: 'deploy-123',
    url: 'https://app.example.com',
    status: 'completed',
    duration: 45.2,
  },
  metadata: {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  },
};
```

### Handle Errors Gracefully

```typescript
try {
  const result = await riskyOperation();
  return { success: true, data: result };
} catch (error) {
  return {
    success: false,
    error: {
      code: 'OPERATION_FAILED',
      message: error.message,
      details: error.stack,
    },
  };
}
```

## Advanced Patterns

### Stateful Tools

Maintain state across tool calls:

```typescript
import { PluginContext } from '@paperclipai/plugin-sdk';

let browserSession: Browser | null = null;

export async function browser_navigate(
  input: { url: string },
  context: ToolContext
) {
  if (!browserSession) {
    browserSession = await launchBrowser();
    // Register cleanup
    context.onCleanup(() => browserSession?.close());
  }

  await browserSession.goto(input.url);
  return { success: true, data: { url: input.url } };
}
```

### Multi-Step Workflows

```typescript
export async function deploy_workflow(
  input: { branch: string; environment: string },
  context: ToolContext
) {
  // Step 1: Build
  const build = await runBuild(input.branch);
  if (!build.success) return build;

  // Step 2: Test
  const test = await runTests();
  if (!test.success) return test;

  // Step 3: Deploy
  const deploy = await runDeploy(input.environment);

  return {
    success: true,
    data: {
      buildId: build.data.id,
      testResults: test.data.results,
      deploymentId: deploy.data.id,
    },
  };
}
```

### External API Integration

```typescript
export async function github_create_pr(
  input: { title: string; branch: string; base: string },
  context: ToolContext
) {
  const token = process.env.GITHUB_TOKEN;
  
  const response = await fetch(
    `https://api.github.com/repos/${context.repo}/pulls`,
    {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: input.title,
        head: input.branch,
        base: input.base,
      }),
    }
  );

  const pr = await response.json();

  return {
    success: true,
    data: {
      number: pr.number,
      url: pr.html_url,
      state: pr.state,
    },
  };
}
```

## Debugging

### Enable Plugin Logging

```typescript
// In your tool handler
console.log('[my-plugin] Tool called with:', input);

try {
  const result = await doWork();
  console.log('[my-plugin] Success:', result);
  return { success: true, data: result };
} catch (error) {
  console.error('[my-plugin] Error:', error);
  return { success: false, error: { message: error.message } };
}
```

### Test Tools Manually

```bash
# Start Paperclip with plugin
PAPERCLIP_PLUGINS=my-plugin pnpm dev

# Use the tool via agent or API
curl -X POST http://localhost:3100/api/tools/my_tool \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"param1": "test"}'
```

## Publishing

### Prepare for npm

1. Update version in `package.json`
2. Add README.md with usage examples
3. Add LICENSE file
4. Test installation from local path first

### Publish

```bash
npm login
npm publish --access public
```

### Version Updates

```bash
# Patch (bug fix)
npm version patch

# Minor (new feature, backwards compatible)
npm version minor

# Major (breaking change)
npm version major
```

## Examples

See existing plugins for reference:

- [`@paperclipai/plugin-playwright-mcp`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/playwright-mcp)
- [`@paperclipai/plugin-ruflo-bridge`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/ruflo-bridge)
- [`@paperclipai/plugin-skills-hub`](https://github.com/paperclipai/paperclip/tree/master/packages/plugins/skills-hub)

## Troubleshooting

### Plugin Not Loading

1. Check plugin is installed: `pnpm list @paperclipai/plugin-*`
2. Verify config: `PAPERCLIP_PLUGINS` includes your plugin name
3. Check server logs for load errors

### Tool Not Available

1. Verify tool is registered in `manifest.ts`
2. Check tool name matches exactly (case-sensitive)
3. Ensure plugin build succeeded (`dist/` exists)

### Type Errors

1. Run `pnpm typecheck` to catch errors
2. Ensure Zod schemas match handler input types
3. Check SDK version compatibility

## Next Steps

- [Plugin Overview](./overview.md)
- [Playwright MCP Plugin](./playwright-mcp.md)
- [Ruflo Bridge Plugin](./ruflo-bridge.md)
- [Skills Hub Plugin](./skills-hub.md)
