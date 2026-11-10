# Task chat scrollback regression

Run from the repository root:

```sh
pnpm exec playwright test --config tests/perf/task-chat/playwright.config.ts
```

The test starts an isolated Vite server on port 4197. It needs no database,
credentials, or running agents. It renders the real `TaskChatThreadView`, bubbles,
markdown, run folds, and scroller with 200 long responses and 4,000 historical
tool entries. A synthetic live tail updates ten times per second. A second case
recreates the history objects on each update, as transcript projection can do.
The harness uses a plain reply textarea; it does not test the full task composer
or server-to-browser transport.

Chromium samples main-thread task time for three seconds. Both cases must stay
below 50% main-thread utilization and deliver at least 20 updates. The ceiling
leaves room for machine variation while detecting the original saturation.
Performance JSON is attached to each test result. The test also checks reading
position during updates, typing, return to latest, lazy tool inspection, and
preserved tool expansion across closing/reopening a run.

For manual inspection, start the same server and open
`http://127.0.0.1:4197/tests/task-chat-perf.html`:

```sh
pnpm --filter @paperclipai/ui exec vite --host 127.0.0.1 --port 4197 --strictPort
```

This HTML entry is not part of the shipped application build.

## Reproduction and results

On macOS Chromium against commit `a05b828bc`, the original code consumed 97.8%
of the main thread and delivered 8 updates. With the fix, the same dev fixture
consumed 11.6% for tail-only updates and 31.5% for recreated history, delivering
32 updates in both cases. These are local samples, not cross-machine promises.

The normal Vitest suite includes deterministic guards in
`TaskChatThreadView.performance.test.tsx` and `TaskChatTurn.test.tsx`: unchanged
history does not rerender or reparse markdown, changed content/gallery callbacks
remain current, and collapsed tools mount on demand. These run in ordinary CI;
the browser performance test is opt-in.
