# `@paperclipai/adapter-claude-local`

Local-process adapter for Anthropic's [Claude Code](https://github.com/anthropics/claude-code) CLI.

## AWS Bedrock mode

Claude Code can be pointed at AWS Bedrock instead of the Anthropic API by setting either of:

- `CLAUDE_CODE_USE_BEDROCK=1`, or
- `ANTHROPIC_BEDROCK_BASE_URL=<url>`

When Bedrock mode is detected, the adapter automatically switches its **model list** and the
**`cheap` model profile** to region-correct Bedrock cross-region inference-profile IDs.

Bedrock requires region-prefixed identifiers — Anthropic-direct ids like `claude-sonnet-4-6` are
**rejected** by Bedrock with `400 The provided model identifier is invalid.`. The adapter handles
this for you.

### Region resolution

The adapter picks the Bedrock prefix from these environment variables, in order:

1. `ANTHROPIC_BEDROCK_REGION`
2. `AWS_REGION`
3. `AWS_DEFAULT_REGION`

Mapping:

| AWS region prefix | Bedrock inference-profile prefix |
| ----------------- | -------------------------------- |
| `eu-*`            | `eu.anthropic.*`                 |
| `ap-*`            | `apac.anthropic.*`               |
| anything else     | `us.anthropic.*` (default)       |

### Profile mapping

| Profile | Direct (Anthropic API)   | Bedrock (eu-central-1)                                   |
| ------- | ------------------------ | -------------------------------------------------------- |
| `cheap` | `claude-sonnet-4-6`      | `eu.anthropic.claude-haiku-4-5-20251001-v1:0`            |

The Bedrock branch prefers Haiku because Haiku is the cheapest Anthropic family model on Bedrock.
If Haiku has not rolled out in your region yet, the adapter falls back to the first model in
that region's list.

### Per-agent override

Operators can still pin a specific Bedrock id per-agent via `runtimeConfig`:

```json
{
  "runtimeConfig": {
    "modelProfiles": {
      "cheap": {
        "enabled": true,
        "adapterConfig": {
          "model": "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
          "effort": "low"
        }
      }
    }
  }
}
```

Per-agent values override the adapter default.

### Verifying

```ts
import {
  listClaudeModels,
  listClaudeModelProfiles,
} from "@paperclipai/adapter-claude-local/server";

process.env.CLAUDE_CODE_USE_BEDROCK = "1";
process.env.AWS_REGION = "eu-central-1";

const profiles = await listClaudeModelProfiles();
console.log(profiles.find((p) => p.key === "cheap")?.adapterConfig?.model);
// → "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
```
