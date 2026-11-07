import type { TestProject, TestSpecification } from "vitest/node";

// Server suites import very large module graphs (routes/access.ts, routes/issues.ts
// and what they pull in). Vite transforms each module the first time a worker asks
// for it, so the first test or hook in a file that imports such a graph pays that
// one-time transform inside its own timeout: about 6 s on a fast laptop, and over
// 20 s on a loaded CI runner, which can cross testTimeout (for example the first
// test in activity-routes or invite-rate-limit-route).
//
// This global setup transforms the import graph of every server test file in the
// run (its shard only) before any worker starts, following static and literal
// dynamic imports. Workers then fetch already-transformed modules from the same
// Vite environment, so no test or hook budget pays the transform. Global setup has
// no timeout. Nothing is evaluated here: transforms only, so mocks and module
// state in the test files are untouched. Set PAPERCLIP_VITEST_WARM_TRANSFORMS=0
// to skip it.

const CONCURRENCY = 16;
const IMPORT_ACTUAL = /\bvi\.(?:importActual|importMock)\s*(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g;

function isSourceUrl(url: string) {
  // Root-relative and /@fs/ source files; not dependencies (Vitest externalizes
  // node_modules) and not virtual ids such as optional peer dependency stubs.
  return url.startsWith("/") && !url.includes("/node_modules/") && !url.startsWith("/@id/");
}

async function specificationsForThisRun(project: TestProject): Promise<TestSpecification[]> {
  const vitest = project.vitest;
  // Vitest records the run's test files (state.pathsSet, internal) before it starts
  // global setup, and applies --shard later, in the pool, so apply the same
  // sequencer shard here. If a Vitest upgrade drops the field, nothing is warmed.
  const paths = (vitest.state as unknown as { pathsSet?: Set<string> }).pathsSet ?? new Set<string>();
  let specs: TestSpecification[] = [];
  for (const file of paths) {
    const owner = vitest.projects.find((candidate) => candidate.matchesTestGlob(file));
    if (owner) specs.push(owner.createSpecification(file));
  }
  if (vitest.config.shard) {
    const Sequencer = vitest.config.sequence.sequencer;
    specs = await new Sequencer(vitest).shard(specs);
  }
  return specs.filter((spec) => spec.project === project);
}

export default async function warmServerTestTransforms(project: TestProject) {
  if (process.env.PAPERCLIP_VITEST_WARM_TRANSFORMS === "0") return;
  const startedAt = performance.now();
  const environment = project.vite.environments.ssr;
  const specs = await specificationsForThisRun(project);
  const seen = new Set<string>();
  const queue = specs.map((spec) => spec.moduleId);
  let failed = 0;
  const enqueue = (url: string) => {
    if (isSourceUrl(url) && !seen.has(url)) {
      seen.add(url);
      queue.push(url);
    }
  };
  async function visit(url: string) {
    try {
      const result = await environment.transformRequest(url);
      if (!result) return;
      for (const dep of [...(result.deps ?? []), ...(result.dynamicDeps ?? [])]) enqueue(dep);
      // Route suites often load the real module with vi.importActual("…") after
      // vi.doMock; Vite does not see those as imports, so resolve them here.
      const importer = (await environment.moduleGraph.getModuleByUrl(url))?.id ?? url;
      for (const match of result.code.matchAll(IMPORT_ACTUAL)) {
        const resolved = await environment.pluginContainer.resolveId(match[1]!, importer);
        if (resolved && !resolved.external) enqueue(resolved.id);
      }
    } catch {
      // A module that fails to transform fails in its test with the real error.
      failed++;
    }
  }
  for (const url of queue) seen.add(url);
  const running = new Set<Promise<void>>();
  while (queue.length || running.size) {
    while (queue.length && running.size < CONCURRENCY) {
      const task: Promise<void> = visit(queue.shift()!).finally(() => running.delete(task));
      running.add(task);
    }
    if (running.size) await Promise.race(running);
  }
  if (process.env.PAPERCLIP_VITEST_WARM_TRANSFORMS_LOG === "1") {
    console.log(`[warm-transforms] ${specs.length} test files, ${seen.size} modules, ${failed} failed, ${Math.round(performance.now() - startedAt)} ms`);
  }
}
