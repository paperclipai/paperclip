# Miniflare Troubleshooting and Migrations

| Symptom or task | Check |
|-----------------|-------|
| TypeScript, bundled code, or imports fail to load | [Custom builds](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/#custom-builds) and [module rules](https://developers.cloudflare.com/workers/testing/miniflare/core/modules/#module-rules) |
| Bindings from Wrangler configuration are missing | [Interacting with bindings](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/#interacting-with-bindings) — direct Miniflare needs explicit configuration |
| Tests disagree with Worker runtime behavior | [Test runtime differences](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/) and [compatibility dates](https://developers.cloudflare.com/workers/testing/miniflare/core/compatibility/) |
| Instances keep running, ports conflict, or request metadata is unexpected | [Instance lifecycle and HTTP server](https://developers.cloudflare.com/workers/testing/miniflare/get-started/) — dispatching a request without HTTP does not mean the instance has no HTTP server |
| Storage disappears or leaks across tests | Check the relevant [storage configuration](./configuration.md) and the chosen test tool's persistence settings |
| Breakpoints are needed with direct Miniflare | [Attaching a debugger](https://developers.cloudflare.com/workers/testing/miniflare/developing/debugger/) |
| Upgrade a Miniflare 2 application | [Migrate from version 2](https://developers.cloudflare.com/workers/testing/miniflare/migrations/from-v2/) |
| Upgrade an existing Workers Vitest package | [Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) |
| Replace unstable_dev tests | [Migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-unstable-dev/) and [integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/) |

For a migration, choose the target using [the testing-tool decision](./README.md#choose-the-testing-tool) before translating old options. A historical migration page describes that version transition; use current setup documentation for new test suites.
