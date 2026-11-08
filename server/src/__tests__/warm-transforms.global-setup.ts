import type { TestProject, TestSpecification } from "vitest/node";

const CONCURRENCY = 16;
const IMPORT_ACTUAL = /\bvi\.(?:importActual|importMock)\s*(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g;

function isSourceUrl(url: string) {
  return url.startsWith("/") && !url.includes("/node_modules/") && !url.startsWith("/@id/");
}

async function specificationsForThisRun(project: TestProject): Promise<TestSpecification[]> {
  const vitest = project.vitest;
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
      const importer = (await environment.moduleGraph.getModuleByUrl(url))?.id ?? url;
      for (const match of result.code.matchAll(IMPORT_ACTUAL)) {
        const resolved = await environment.pluginContainer.resolveId(match[1]!, importer);
        if (resolved && !resolved.external) enqueue(resolved.id);
      }
    } catch {
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
