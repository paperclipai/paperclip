import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function printHeader(label) {
  process.stdout.write(`\n[test:run] ${label}\n`);
}

async function runCommand(cwd, args, label, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      printHeader(`${label} retry ${attempt}/${attempts}`);
    } else {
      printHeader(label);
    }

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(pnpmBin, args, {
          cwd,
          stdio: "inherit",
          env: process.env,
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
        });
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function runVitestProject(projectDir) {
  const configPath = path.join(projectDir, "vitest.config.ts");
  const label = `${path.relative(repoRoot, projectDir)} vitest`;
  await runCommand(projectDir, ["exec", "vitest", "run", "--config", configPath], label);
}

async function runServerTests() {
  const serverDir = path.join(repoRoot, "server");
  const testsDir = path.join(serverDir, "src", "__tests__");
  const files = (await fs.readdir(testsDir))
    .filter((file) => file.endsWith(".test.ts"))
    .sort((left, right) => left.localeCompare(right));

  for (const file of files) {
    const relativePath = path.posix.join("src", "__tests__", file);
    await runCommand(
      serverDir,
      ["exec", "vitest", "run", "--config", path.join(serverDir, "vitest.config.ts"), relativePath],
      `server vitest ${relativePath}`,
      2,
    );
  }
}

async function main() {
  await runVitestProject(path.join(repoRoot, "packages", "db"));
  await runVitestProject(path.join(repoRoot, "packages", "adapters", "codex-local"));
  await runVitestProject(path.join(repoRoot, "packages", "adapters", "opencode-local"));
  await runServerTests();
  await runVitestProject(path.join(repoRoot, "ui"));
  await runVitestProject(path.join(repoRoot, "cli"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
