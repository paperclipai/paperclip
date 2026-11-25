import { FIXTURE, REAL_RUN, deriveRealSwarm, plainBrief, type SwarmHelper, type SwarmPost, type SwarmView } from "./swarm-model";

export const REQUEST = "Build a tiny static unit-converter page in this folder: page, styles, conversion logic and a README, then have it checked.";

export function starting(): SwarmView {
  const view = deriveRealSwarm(6, "starting");
  return { ...view, request: REQUEST, helpers: view.helpers.map((helper) => ({ ...helper, state: helper.role === "monitor" ? "waiting" : "starting", action: undefined })) };
}

export function running(): SwarmView {
  return { ...deriveRealSwarm(8, "running"), request: REQUEST };
}

export function runningWithBlocked(): SwarmView {
  const at = FIXTURE.board.find((post) => post.seq === 8)!.time;
  const recorded = { seq: 9, agent: FIXTURE.recordedBlock.helper, text: FIXTURE.recordedBlock.text, time: at };
  return { ...deriveRealSwarm(8, "running", [recorded]), request: REQUEST };
}

export function stopping(): SwarmView {
  return { ...running(), status: "stopping" };
}

export function stopped(): SwarmView {
  return { ...deriveRealSwarm(8, "stopped"), request: REQUEST, reason: "You stopped the swarm. Files the helpers already wrote stay in the task folder." };
}

export function failed(): SwarmView {
  return {
    ...deriveRealSwarm(8, "stopped"),
    request: REQUEST,
    status: "failed",
    reason: "The helpers did not finish in time, so Paperclip stopped the swarm. Files they already wrote stay in the task folder.",
  };
}

export function refused(): SwarmView {
  return {
    ...deriveRealSwarm(0, "refused"),
    request: REQUEST,
    helpers: [],
    posts: [],
    threads: [],
    reason: "Swarm is not available with this Google connection: helpers can only change files in Antigravity's auto mode, which this sign-in does not offer.",
  };
}

export function completed(): SwarmView {
  return { ...deriveRealSwarm(REAL_RUN.lastSeq, "completed"), request: REQUEST };
}

const LONG_HELPERS: Array<[string, string, string, SwarmHelper["state"], string | undefined]> = [
  ["api-profiler", "Profile the task list endpoint", "t-api", "done", undefined],
  ["query-tuner", "Cut the task list query to one round trip", "t-api", "in_review", undefined],
  ["cache-writer", "Cache project and label lookups", "t-api", "working", "Running server tests for the label cache"],
  ["ui-virtualizer", "Render only visible task rows", "t-ui", "working", "Writing TaskListRows.tsx"],
  ["bundle-trimmer", "Split the task list bundle", "t-ui", "blocked", "Blocked: tried to change a file outside the task folder"],
  ["skeleton-writer", "Show a stable loading skeleton", "t-ui", "done", undefined],
  ["bench-writer", "Add a cold-load benchmark", "t-proof", "working", "Running the cold-load benchmark 5 times"],
  ["docs-writer", "Note the new limits in the docs", "t-proof", "waiting", undefined],
  ["verifier-api", "Check server changes and tests", "t-proof", "working", "Reading query-tuner's diff in #23"],
  ["verifier-ui", "Check UI changes in both themes", "t-proof", "waiting", undefined],
  ["monitor", "Watch for stalls", "t-proof", "waiting", "Watching for stalls"],
];

const LONG_POSTS: Array<[string, string]> = [
  ["api-profiler", "@coordinator [done] p95 is 2.4s: 61% in the label join, 22% serialising 900 rows, rest is auth"],
  ["coordinator", "@query-tuner @cache-writer see #12 for the profile"],
  ["skeleton-writer", "@verifier-ui [done] skeleton keeps the row height; no layout shift in the trace"],
  ["query-tuner", "@verifier-api [done] task list now loads labels with one joined query; 2.4s to 0.9s locally"],
  ["bundle-trimmer", "@coordinator [blocked] permission check failed for write_file \"../vendor/router.patch\": the prompt timed out waiting for user response after 60s"],
  ["coordinator", "@bundle-trimmer keep the split inside the task folder; do not patch vendor files"],
  ["cache-writer", "@verifier-api cache keys are scoped per company; running the server tests now"],
  ["ui-virtualizer", "@skeleton-writer I reuse your row height token for the virtual list"],
  ["verifier-ui", "@skeleton-writer looks right in light and dark; one gap at 360px, see screenshot"],
  ["skeleton-writer", "@verifier-ui [done] fixed the 360px gap"],
  ["bench-writer", "@coordinator first cold loads: 3.1s, 2.9s; waiting on query-tuner and cache-writer"],
  ["monitor", "@coordinator [stall] docs-writer and verifier-ui have waited 6 minutes with nothing assigned"],
  ["coordinator", "@docs-writer start the limits note from #23"],
  ["verifier-api", "@query-tuner reading your diff now; one question about the label index"],
];

export function longSwarm(): SwarmView {
  const at = REAL_RUN.startedAt;
  const briefs: SwarmPost[] = LONG_HELPERS.map(([name, task], index) => ({ seq: index + 1, author: "coordinator", text: `@${name} ${task}.`, at, kind: "brief" }));
  const posts: SwarmPost[] = LONG_POSTS.map(([author, text], index) => ({
    seq: briefs.length + index + 1,
    author,
    text,
    at,
    kind: /\[stall\]/.test(text) ? "stall" : /\[blocked\]/.test(text) ? "blocked" : /\[done\]/.test(text) ? "done" : "update",
  }));
  return {
    request: "The task list takes over two seconds on a cold load. Get it under one second without changing what it shows.",
    title: "Task list under one second",
    goal: { title: "Get the task list under one second", line: "Query and skeleton landed; virtual list and bundle split in progress." },
    status: "running",
    startedAt: at,
    helpers: LONG_HELPERS.map(([name, task, , state, action]) => ({
      name,
      role: name.startsWith("verifier") ? "verifier" : name === "monitor" ? "monitor" : "helper",
      task,
      brief: plainBrief(task),
      state,
      action,
      model: "gemini-4-neon-high",
    })),
    posts: [...briefs, ...posts],
    threads: [
      { id: "t-api", title: "Faster task query", goal: "One round trip, cached lookups", helpers: ["api-profiler", "query-tuner", "cache-writer"] },
      { id: "t-ui", title: "Lighter task page", goal: "Render less, load less", helpers: ["ui-virtualizer", "bundle-trimmer", "skeleton-writer"] },
      { id: "t-proof", title: "Proof and docs", goal: "Benchmarked, checked and written down", helpers: ["bench-writer", "docs-writer", "verifier-api", "verifier-ui", "monitor"] },
    ],
    model: "Gemini 4 Neon",
    synthetic: true,
  };
}

export const TODAY_STEPS: string[] = [
  "Swarm started in the task folder with Gemini 4 Neon. Helper changes inside the task folder are approved automatically; anything else is blocked.",
  `Swarm: ${REAL_RUN.title}`,
  ...REAL_RUN.addedHelpers.map(({ name, brief }) => (/^monitor$/i.test(name) ? "Started a helper that watches for stalls" : `Started helper ${name}: ${plainBrief(brief)}`)),
  "Checked on the helpers",
  "Checked on the helpers",
  "Coordinator: Static unit-converter page built and verified (index.html, style.css, convert.js, README.md)",
  "Files changed in the task folder: README.md, convert.js, index.html, style.css",
  "Token usage is the coordinator's total and includes the helpers; Google does not report it per helper",
];
