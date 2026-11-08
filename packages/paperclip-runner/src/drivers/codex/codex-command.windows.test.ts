import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { resolveCodexCommand } from "./codex-command.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-windows-command-")));
  const issuer = join(root, "issuer.cjs");
  const base = join(root, "node_modules", "@openai", "codex");
  const bridge = join(root, "node_modules", "@agentclientprotocol", "codex-acp");
  const platform = join(root, "node_modules", "@openai", `codex-win32-${process.arch}`);
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const binary = join(platform, "vendor", triple, "bin", "codex.exe");
  mkdirSync(join(base, "bin"), { recursive: true });
  mkdirSync(bridge, { recursive: true });
  writeFileSync(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.0.0" }));
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" } }));
  writeFileSync(join(base, "bin", "codex.js"), "// fixture launcher");
  const metadata = { name: "@openai/codex", version: `1.2.3-win32-${process.arch}`, os: ["win32"], cpu: [process.arch] };
  writeFileSync(join(platform, "package.json"), JSON.stringify(metadata));
  writeFileSync(binary, "fixture executable");
  return { root, issuer, binary, platform, metadata };
}

it.runIf(process.platform === "win32")("selects the contained Windows binary instead of trying to execute a JS launcher", () => {
  const f = fixture();
  try { expect(resolveCodexCommand(f.issuer, { PATH: "" })).toBe(realpathSync(f.binary)); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32").each(["name", "version"])("refuses a mismatched Windows dependency %s", field => {
  const f = fixture();
  try {
    writeFileSync(join(f.platform, "package.json"), JSON.stringify({ ...f.metadata, [field]: "unexpected" }));
    expect(() => resolveCodexCommand(f.issuer)).toThrow("unexpected package identity");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("refuses a missing installed Windows binary without adopting ambient commands", () => {
  const f = fixture();
  try {
    rmSync(f.binary);
    expect(() => resolveCodexCommand(f.issuer, { PATH: dirname(process.execPath) })).toThrow("Windows executable is missing");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
