# Runner SDK and lab documentation

These documents cover the package-local browser SDK, React components,
standalone demos, scenario explorer, issue-thread surface, and live-session
development tools. They do not enable a production provider or change
Paperclip's runtime selection.

## Tutorials

- [Local runner](tutorials/local-runner.md)
- [Live console protocol server](tutorials/live-console-protocol-server.md)
- [Live console](tutorials/live-console.md)
- [SDK console](tutorials/sdk-console.md)
- [Standalone adapter](tutorials/standalone-thin-paperclip-adapter.md)
- [Scenario explorer](tutorials/capability-scenario-explorer.md)
- [Scenario chat](tutorials/scenario-chat.md)
- [Issue-thread lab](tutorials/capability-issue-thread.md)
- [Clean-room Codex chat](tutorials/capability-clean-room-chat.md)

## Reference

- [Runner eval scoring slice](capability-eval-slice.md)
- [Deterministic runner workflow evals](runner-workflow-evals.md)
- [Evals integration contract](evals-integration.md)
- [Local runner and supervision](local-runner.md)
- [Durable transport and recovery](durable-recovery.md)
- [Live console protocol server](live-console-protocol-server.md)
- [Live console](live-console.md)
- [Browser and React SDK](sdk.md)
- [Standalone adapter](standalone-thin-paperclip-adapter.md)
- [Scenario explorer](capability-scenario-explorer.md)
- [Scenario chat](scenario-chat.md)
- [Mock control plane](capability-mock-control-plane-port.md)
- [Live runnerd/Codex loop](capability-live-runnerd-codex.md)
- [Issue-thread UI](capability-issue-thread-ui.md)
- [Clean-room chat](capability-clean-room-chat.md)
- [Issue-thread UX contract](design/capability-issue-thread-ux-contract.md)
- [Scenario explorer UX](design/capability-scenario-explorer-ux.md)
- [Scenario chat UX](design/scenario-chat-ux.md)
- [Live-console interaction map](design/live-console-interaction-map.md)
- [Live-console component decisions](design/live-console-component-decisions.md)
- [SDK component decisions](design/sdk-component-decisions.md)
- [Standalone adapter boundary](design/standalone-thin-paperclip-adapter.md)
- [UI library compatibility note](research/2026-08-07-ui-library-compatibility.md)

The SDK and labs are additive. Existing direct adapters continue to use their
existing composer, transcript, interaction, and finalization paths.
