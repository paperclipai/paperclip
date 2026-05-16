/**
 * paperclipai CLI npm 배포용 esbuild 설정입니다.
 *
 * workspace 패키지 코드는 단일 파일로 묶고, CLI가 직접 의존하는 npm 패키지만
 * 런타임 의존성으로 남깁니다. workspace 내부 전이 의존성은 dist import smoke가
 * package manager의 hoisting 형태에 의존하지 않도록 번들에 포함합니다.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// 런타임에서 별도 패키지로 해석해야 하는 workspace 패키지입니다.
const externalWorkspacePackages = new Set([
  "@paperclipai/server",
]);

// source-tree server launch에서만 필요한 개발용 loader입니다. published CLI에서는
// server/src가 없으므로 이 dynamic import 경로가 실행되지 않습니다.
const devOnlyExternals = new Set(["tsx"]);

// CLI package가 직접 선언한 npm 의존성만 external로 둡니다.
const externals = new Set();
const cliPkg = JSON.parse(readFileSync(resolve(repoRoot, "cli", "package.json"), "utf8"));
for (const name of Object.keys(cliPkg.dependencies || {})) {
  if (externalWorkspacePackages.has(name)) {
    externals.add(name);
  } else if (!name.startsWith("@paperclipai/")) {
    externals.add(name);
  }
}
for (const name of Object.keys(cliPkg.optionalDependencies || {})) {
  externals.add(name);
}
for (const name of externalWorkspacePackages) {
  externals.add(name);
}
for (const name of devOnlyExternals) {
  externals.add(name);
}

/** @type {import('esbuild').BuildOptions} */
export default {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "#!/usr/bin/env node" },
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
};
