import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { NativeMcpLaunchBinding } from "./native-mcp.js";

async function assertSafeTree(root: string, child = ""): Promise<void> {
  const directory = child ? join(root, child) : root;
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink()) {
    throw new Error(
      `runtime context asset contains a symlink: ${child || "."}`,
    );
  }
  if (!directoryStat.isDirectory()) {
    throw new Error("runtime context asset root must be a directory");
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = child ? `${child}/${entry.name}` : entry.name;
    const stat = await lstat(join(root, childRelative));
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime context asset contains a symlink: ${childRelative}`,
      );
    }
    if (stat.isDirectory()) await assertSafeTree(root, childRelative);
    else if (!stat.isFile()) {
      throw new Error(
        `runtime context asset contains an unsupported file: ${childRelative}`,
      );
    }
  }
}

function safeMaterializationTarget(root: string, runtimeName: string): string {
  const segments = runtimeName.split("/");
  if (
    runtimeName.startsWith("/")
    || runtimeName.includes("\\")
    || runtimeName.includes("\0")
    || segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f]/u.test(segment))
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || segments.some((segment) => !segment.replace(/[ .]+$/u, ""))
    || segments.some(isWin32ReservedPathSegment)
  ) {
    throw new Error("runtime context skill name must be a safe relative path");
  }
  const target = resolve(root, runtimeName);
  const relation = relative(resolve(root), target);
  if (
    relation === ""
    || relation === ".."
    || relation.startsWith(`..${sep}`)
    || isAbsolute(relation)
  ) {
    throw new Error("runtime context skill name must stay inside the skills home");
  }
  return target;
}

function isWin32ReservedPathSegment(segment: string): boolean {
  const basename = segment
    .normalize("NFC")
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
    basename,
  );
}

function portableRuntimeNameKey(runtimeName: string): string {
  // Skill assignments must remain unambiguous when the same context is moved
  // between the case-sensitive Linux runner and the case-insensitive default
  // filesystems on macOS or Windows. NFC also catches composed/decomposed
  // aliases, while per-segment trimming matches Win32's treatment of trailing
  // dots and spaces before either spelling reaches the staging tree.
  return runtimeName
    .normalize("NFC")
    .split("/")
    .map((segment) => segment.replace(/[ .]+$/u, ""))
    .join("/")
    .toLowerCase();
}

async function protectStagedTree(root: string): Promise<void> {
  const rootHandle = await open(
    root,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory()) {
      throw new Error("staged runtime context root must be a directory");
    }
    // Keep directories owner-writable so the private staging tree can be
    // removed without a second path-based chmod traversal.
    await rootHandle.chmod(0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) {
        await protectStagedTree(child);
        continue;
      }
      const childHandle = await open(
        child,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const openedChild = await childHandle.stat();
        if (!openedChild.isFile()) {
          throw new Error("staged runtime context asset must be a regular file");
        }
        await childHandle.chmod(openedChild.mode & 0o555);
      } finally {
        await childHandle.close();
      }
    }
  } finally {
    await rootHandle.close();
  }
}

export async function materializeNativeRuntimeSkills(
  context: NativeRuntimeContextSnapshot | null,
  skillsHome: string,
  dependencies: {
    /** Internal test seam for failed staging cleanup coverage. */
    removeTree?: (path: string) => Promise<void>;
    /** Internal test seam for publication failure coverage. */
    renameTree?: (source: string, destination: string) => Promise<void>;
  } = {},
): Promise<void> {
  const removeTree =
    dependencies.removeTree ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const renameTree = dependencies.renameTree ?? rename;
  if (context) {
    const runtimeNames = new Set<string>();
    for (const skill of context.skills) {
      safeMaterializationTarget(skillsHome, skill.runtimeName);
      const runtimeName = portableRuntimeNameKey(skill.runtimeName);
      if (runtimeNames.has(runtimeName)) {
        throw new Error("runtime context skill names must not overlap");
      }
      runtimeNames.add(runtimeName);
    }
    for (const runtimeName of runtimeNames) {
      const segments = runtimeName.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        if (runtimeNames.has(segments.slice(0, length).join("/"))) {
          throw new Error("runtime context skill names must not overlap");
        }
      }
    }
    for (const skill of context.skills) {
      await assertSafeTree(skill.bundle.rootPath);
    }
  }

  const skillsHomeExists = await lstat(skillsHome).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (skillsHomeExists) {
    throw new Error(
      "runtime context skills home must be a fresh destination",
    );
  }

  const parent = dirname(skillsHome);
  const nonce = randomUUID();
  const stagingHome = join(parent, `.paperclip-skills-staging-${nonce}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await mkdir(stagingHome, { mode: 0o700 });
  try {
    for (const skill of context?.skills ?? []) {
      const target = safeMaterializationTarget(stagingHome, skill.runtimeName);
      await cp(skill.bundle.rootPath, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      await assertSafeTree(target);
      await protectStagedTree(target);
    }

    // The caller supplies a new isolated home for each provider launch. Never
    // move an existing assignment out of its canonical path: a failed bounded
    // rollback cannot portably guarantee that name is restored on every
    // filesystem. Publication therefore targets only a fresh destination.
    await renameTree(stagingHome, skillsHome);
  } catch (error) {
    await removeTree(stagingHome).catch(() => undefined);
    throw error;
  }
}

async function readSourceCodexAuth(sourceAuth: string): Promise<Buffer | null> {
  const handle = await open(
    sourceAuth,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > 1024 * 1024) {
      throw new Error("source Codex auth file exceeds the 1 MiB limit");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function prepareIsolatedCodexHome(input: {
  context: NativeRuntimeContextSnapshot | null;
  codexHome: string;
  sourceCodexHome?: string | null;
  nativeMcp?: NativeMcpLaunchBinding | null;
  apiKey?: string | null;
}): Promise<void> {
  await materializeNativeRuntimeSkills(
    input.context,
    join(input.codexHome, "skills"),
  );

  const configPath = join(input.codexHome, "config.toml");
  await rm(configPath, { force: true });
  await writeFile(configPath, [
    // Codex shell snapshots serialize the provider process environment. The
    // native runner injects short-lived provider and MCP bindings, so a
    // snapshot would turn ephemeral credentials into durable session state.
    "[features]",
    "shell_snapshot = false",
    "",
    ...(input.nativeMcp
      ? [
          `[mcp_servers.${JSON.stringify(input.nativeMcp.name)}]`,
          `url = ${JSON.stringify(input.nativeMcp.url)}`,
          `http_headers = { Authorization = ${JSON.stringify(`Bearer ${input.nativeMcp.token}`)} }`,
          "",
        ]
      : []),
  ].join("\n"), { mode: 0o600 });

  const targetAuth = join(input.codexHome, "auth.json");
  await rm(targetAuth, { force: true });
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    // The pinned Codex app-server authenticates API-key automation through its
    // login cache rather than the CLI-only CODEX_API_KEY path. Keep this file
    // owner-only in the disposable session home.
    await writeFile(
      targetAuth,
      JSON.stringify({ OPENAI_API_KEY: apiKey }),
      { mode: 0o600 },
    );
    await chmod(targetAuth, 0o600);
    return;
  }

  const sourceHome = input.sourceCodexHome?.trim();
  if (!sourceHome) return;
  const sourceAuth = await readSourceCodexAuth(join(sourceHome, "auth.json"));
  if (!sourceAuth) return;
  await writeFile(targetAuth, sourceAuth, { mode: 0o600 });
  await chmod(targetAuth, 0o600);
}
