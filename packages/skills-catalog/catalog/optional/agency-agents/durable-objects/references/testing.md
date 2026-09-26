# Testing Durable Objects

Use Cloudflare’s Vitest integration to exercise Durable Objects in the Workers runtime. Before changing an existing suite, inspect its installed Vitest/Cloudflare packages, configuration, and test scripts. Follow the matching API or migration guide; adding a test does not by itself require migrating the suite.

Fetch the relevant current documentation before writing setup or test code:

| Task | Documentation |
|------|---------------|
| Install compatible packages, configure Vitest and Wrangler, generate test types, run tests | [Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) |
| Migrate an existing pool-based suite | [Migrate to Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) |
| Configure bindings, runtime options, or multiple Workers | [Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) |
| Test RPC, Worker HTTP routes, instance separation, SQLite storage, and alarms | [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/) |
| Inspect internals, enumerate instances, or trigger scheduled alarms with test helpers | [Test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) |
| Choose state cleanup and concurrency behavior | [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/) |

Choose tests around the behavior being changed:

- Use RPC tests for object behavior and HTTP integration tests for Worker routing and response contracts.
- Verify that one object retains state across calls and different object identities remain independent. Inspect SQLite state when persistence itself is the contract under test; repeated calls alone do not prove recovery after restart.
- For alarms, verify the scheduled work’s effects and any rescheduling or cancellation, using the documented helper to avoid waiting for wall-clock time.
- Check the installed integration’s isolation model before reusing object names. Use separate identities or explicit cleanup where state is shared between tests.

Keep package versions, imports, configuration, helper signatures, and runnable examples in the linked documentation rather than copying them into this reference.
