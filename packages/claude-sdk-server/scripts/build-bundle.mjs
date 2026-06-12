import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const distDir = path.join(packageDir, "dist");
const bundleRoot = path.join(packageDir, "bundle");
const bundleName = "paperclip-claude-sdk-server-bundle";
const bundleDir = path.join(bundleRoot, bundleName);
const archivePath = path.join(bundleRoot, `${bundleName}.tar.gz`);

async function writeBundleReadme(targetPath) {
  const text = `# ${bundleName}

This is a minimal runtime bundle for the standalone Paperclip Claude bridge.

Requirements:
- Node.js 20+
- \`claude\` installed and authenticated on this host

Install runtime dependencies:

\`\`\`bash
npm install --omit=dev
\`\`\`

Run:

\`\`\`bash
node dist/cli.js --listen ws://127.0.0.1:4400
\`\`\`

With bearer auth:

\`\`\`bash
node dist/cli.js --listen ws://127.0.0.1:4400 --token-file "$HOME/.claude/paperclip-bridge.token"
\`\`\`
`;
  await fs.writeFile(targetPath, text, "utf8");
}

async function main() {
  await fs.access(distDir);
  await fs.rm(bundleDir, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });
  await fs.mkdir(bundleDir, { recursive: true });

  await fs.cp(distDir, path.join(bundleDir, "dist"), { recursive: true });

  const packageJson = {
    name: bundleName,
    private: true,
    type: "module",
    engines: {
      node: ">=20",
    },
    bin: {
      "paperclip-claude-sdk-server": "./dist/cli.js",
    },
    scripts: {
      start: "node ./dist/cli.js",
    },
    dependencies: {
      ws: "^8.19.0",
    },
  };

  await fs.writeFile(
    path.join(bundleDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  await writeBundleReadme(path.join(bundleDir, "README.md"));

  await execFileAsync("tar", ["-czf", archivePath, "-C", bundleRoot, bundleName], {
    cwd: packageDir,
  });

  process.stdout.write(
    [
      `[paperclip-claude-sdk-server] bundle ready`,
      `  dir: ${bundleDir}`,
      `  archive: ${archivePath}`,
    ].join("\n") + "\n",
  );
}

await main();
