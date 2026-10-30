# Paperclip Eval Kernel

`@paperclipai/paperclip-eval-kernel` is the workspace-private, provider-neutral
matrix orchestrator owned by Paperclip Evals. It contains no Paperclip scenario
corpus, provider configuration, product fixture, scorer, or report template.

Consumers pass scenario and candidate values plus execution and scoring
callbacks. Candidate `preflight` hooks should call the runner package's
`assertPaperclipRunnerCompatibility` before any provider work starts. This keeps
catalog, protocol, runner-client, control-plane-adapter, testkit, corpus, and
provider-operation incompatibilities explicit.

Paperclip App may consume this package only as a development dependency for CI
or parity tests. `@paperclipai/paperclip-runner` has no runtime dependency on it.
