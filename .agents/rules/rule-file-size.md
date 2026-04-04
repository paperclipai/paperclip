# Rule: File Size Limits

Avoid oversized files to maintain readability and prevent context-window exhaustion in AI assistants.

- **Activation**: `Always On`

## Limits

- **Rationale**: Oversized files degrade LLM context utilization, reducing the model's ability to reason accurately about the code.
- **Standard Files**: Maximum 800 lines.
- **Large Components**: Prefer decomposing components larger than 500 lines into multiple sub-modules.
- **Exceptions**: Migration files and generated schema files may exceed these limits if necessary for atomic consistency.
