import { watch } from "chokidar";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const uiSrc = path.join(repoRoot, "ui", "src");

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const debounceMs = 1000;
let building = false;
let queued = false;

function timestamp() {
  return new Date().toLocaleTimeString();
}

function runBuild(): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n[${timestamp()}] Building @paperclipai/ui...`);

    const child = spawn("pnpm", ["--filter", "@paperclipai/ui", "build"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[${timestamp()}] Build succeeded in ${elapsed}s`);
        resolve(true);
      } else {
        console.error(`[${timestamp()}] Build failed (exit code ${code}) after ${elapsed}s`);
        resolve(false);
      }
    });

    child.on("error", (err) => {
      console.error(`[${timestamp()}] Build process error: ${err.message}`);
      resolve(false);
    });
  });
}

function scheduleBuild(changedPath: string) {
  const relative = path.relative(repoRoot, changedPath).split(path.sep).join("/");
  console.log(`[${timestamp()}] Changed: ${relative}`);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(async () => {
    debounceTimer = null;

    if (building) {
      queued = true;
      return;
    }

    building = true;
    await runBuild();
    building = false;

    if (queued) {
      queued = false;
      building = true;
      await runBuild();
      building = false;
    }
  }, debounceMs);
}

async function main() {
  console.log(`[${timestamp()}] Watching ui/src/ for changes...`);
  console.log(`[${timestamp()}] Debounce: ${debounceMs}ms`);
  console.log(`[${timestamp()}] Press Ctrl+C to stop\n`);

  const watcher = watch(uiSrc, {
    ignoreInitial: true,
    ignored: /[/\\](node_modules|\.vite)[/\\]/,
    persistent: true,
  });

  watcher.on("all", (_event, filePath) => {
    scheduleBuild(filePath);
  });

  watcher.on("error", (err) => {
    console.error(`[${timestamp()}] Watcher error: ${err.message}`);
  });

  process.on("SIGINT", async () => {
    console.log(`\n[${timestamp()}] Stopping watcher...`);
    await watcher.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log(`\n[${timestamp()}] Stopping watcher...`);
    await watcher.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`[${timestamp()}] Fatal: ${err.message}`);
  process.exit(1);
});
