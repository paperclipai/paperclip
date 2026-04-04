# Rule: File Size Limits

Avoid oversized files to maintain readability and prevent context-window exhaustion in AI assistants.

- **Activation**: `Always On`

## Limits

- **Rationale**: Files too big reduces the chances of the LLM models to code better code.
- **Standard Files**: Maximum 800 lines.
- **Large Components**: Prefer decomposing components larger than 500 lines into multiple sub-modules.
- **Exceptions**: Migration files and generated schema files may exceed these limits if necessary for atomic consistency.
