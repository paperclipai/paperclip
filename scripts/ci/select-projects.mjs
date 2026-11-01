import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

// Each Vite context stays in its own process: aliases, plugins, globals and
// heaps cannot leak between projects. Two contexts bound memory on hosted CI.
export async function selectProjects({ projects, changed, root = process.cwd(), concurrency = Math.min(2, availableParallelism()) }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("Expected one or two graph workers");
  const results = new Array(projects.length), children = new Set();
  let next = 0, failure;
  const work = async () => {
    while (!failure && next < projects.length) {
      const index = next++;
      try {
        results[index] = await new Promise((resolve, reject) => {
          const env = { ...process.env };
          delete env.NODE_TEST_CONTEXT;
          const child = fork(fileURLToPath(import.meta.url), [], {
            cwd: root, env, execArgv: ["--max-old-space-size=2048"], stdio: ["ignore", "inherit", "inherit", "ipc"],
          });
          children.add(child);
          let result;
          const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
          child.on("message", message => { result = message; });
          child.once("error", error => {
            clearTimeout(timer);
            children.delete(child);
            child.kill("SIGKILL");
            reject(error);
          });
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            children.delete(child);
            if (code === 0 && result?.graph?.project === projects[index]) resolve(result.graph);
            else reject(new Error(result?.error || `Graph worker ${projects[index]} exited ${signal || code}`));
          });
          child.send({ root, project: projects[index], changed });
        });
      } catch (error) {
        failure ??= error;
        for (const child of children) child.kill("SIGKILL");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, work));
  if (failure) throw failure;
  return results;
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.once("message", async input => {
    try {
      const { selectProjectTests } = await import("./vitest-selection-graph.mjs");
      const graph = await selectProjectTests(input);
      process.send({ graph }, () => process.exit(0));
    } catch (error) {
      process.send({ error: error.message }, () => process.exit(1));
    }
  });
}
