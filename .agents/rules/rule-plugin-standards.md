---
trigger: model_decision
description: Apply when a new plugin needs to be added for Paperclip
---

# Rule: Plugin Standards

Activation: Model Decision
Context: Applied when creating or modifying Paperclip plugins.

## Rule
Plugins must adhere to the Paperclip Plugin System Specification. While the Alpha implementation is currently used (as described in the Authoring Guide), design decisions should remain compatible with the target long-term architecture.

## Reference
@/doc/plugins/PLUGIN_SPEC.md
@/doc/plugins/PLUGIN_AUTHORING_GUIDE.md

## Key Requirements
- Maintain out-of-process isolation using the plugin worker model.
- Explicitly declare capability sets in the manifest.
- Use namespaced tools (e.g., `plugin-id:tool-name`) to avoid core collisions.
- Strictly follow the scaffolding and build patterns from `@paperclipai/create-paperclip-plugin`.
