// Small wrappers shared by the LET-181 jsdom tests.
//
// React 19 exports `act` only from the development build. The current
// worktree may have NODE_ENV inherited as `production`, which collapses the
// React entry to the production bundle and leaves `act` undefined. The
// helpers below gracefully fall back to a synchronous shim so the EAOS
// shell tests stay deterministic regardless of NODE_ENV, while preserving
// React's preferred act-wrapping when it is available.

import * as React from "react";

// Signal to React that act-style flushing is expected so the dev build does
// not emit "current testing environment is not configured to support act(...)"
// warnings during the LET-181 shell tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ActCallback = () => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reactAct: ((cb: ActCallback) => unknown) | undefined = (React as any).act;

export function actSync(fn: () => void): void {
  if (typeof reactAct === "function") {
    reactAct(fn);
    return;
  }
  fn();
}

// Drain react-query microtasks + one macrotask inside an act() boundary so
// promises resolved during initial render (e.g. `useQuery` settling against
// mocked APIs) commit their re-renders before the suite asserts on the DOM.
// Without this drain, React 19 emits "act() warnings" on jsdom for any test
// that mounts a component using react-query reads — see the LET-484
// reviewer feedback for the Command Center landing.
export async function flushReactQuery(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    if (typeof reactAct === "function") {
      await reactAct(async () => {
        await Promise.resolve();
      });
    } else {
      await Promise.resolve();
    }
  }
  if (typeof reactAct === "function") {
    await reactAct(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
