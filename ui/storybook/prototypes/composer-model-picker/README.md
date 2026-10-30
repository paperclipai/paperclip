# Composer model and effort picker

The approved design is `ComposerModelPickerPreview.tsx`, and the production control is `ui/src/components/task-chat/ComposerRunSettingsPicker.tsx`. Both appear under **Tasks → Composer → Model and effort picker**: the numbered design cases cover harness and model states, while **App picker in composer** and **App picker on mobile** render the production control with the same layout. The task composer passes its selection through the issue update request with the comment, so the next run reads the saved task adapter overrides. Settings stay on the task until changed or reset.

One composer control opens a picker with searchable assignees at the top, then the model and a slider for effort. Its capsule stays on the right beside Send at both desktop and mobile widths. Assignee search matches names, roles, harnesses, and providers, and supports keyboard selection. The selected assignee fixes the harness and provider profile; model search is limited to that profile. The picker supports an exact model ID for harnesses that accept one. The selected effort name sits above the slider between a conditional fast-mode icon on the left and a reset icon on the right. When effort capability is unknown, the entire effort section is omitted. The picker animates its height as content changes and uses a centered, scrollable modal on mobile. Sending a message adds an in-memory transcript bubble with the selected settings.

The stories use fixture state and do not alter task execution. The current adapter model API returns only `{ id, label }`; it cannot tell the client which OpenCode/OpenRouter variants a particular model accepts. The production control therefore uses the model default for those models and for unknown custom IDs. Model capability metadata would allow more precise sliders later.

## Harness coverage

| Harness | Model selection | Effort | Fast mode |
| --- | --- | --- | --- |
| Codex | Curated/search/manual | Model-specific Codex levels | Known supported models only |
| Claude Code | Curated/search/manual | Low, medium, high on known models | No |
| OpenCode with OpenRouter | Search and `openrouter/provider/model` manual ID | Uses model default until variant metadata is available | No |
| Pi | Search/manual | Off through extra high on known models | No |
| Kimi Code, CLI engine | Search/manual | Low, high, max on advertised capable models | No |
| Gemini, Cursor, Grok, Hermes CLI | Search/manual | Not offered | No |
| Cursor Cloud | Manual ID, account default | Not offered | No |
| Paperclip Runner with Codex profile | Codex catalog only | Not offered until the Runner advertises model capabilities | No |
| Process, HTTP, OpenClaw Gateway, Hermes Gateway | No per-message model setting | Not offered | No |

The fixture models reflect repository adapter contracts as of 2026-09-26; provider availability can still depend on the installed CLI, account, environment, or connection. Switching agents clears the draft run settings. The two remote gateway harnesses deliberately leave model choice with their upstream service.
