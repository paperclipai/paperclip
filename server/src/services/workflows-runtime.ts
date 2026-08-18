import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowPipelineDefinition } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type InstrumentationTarget = {
  relativePath: string;
  functionName: string;
  key: string;
  label: string;
};

type AdkNodeKind = "phase" | "agent" | "loop" | "tool" | "validator";

type ParsedAdkInlineNode = {
  className: string;
  name: string;
};

type ParsedAdkDefinition = {
  variableName: string;
  relativePath: string;
  definitionKind: "agent" | "loop" | "workflow" | "join";
  name: string;
  description: string | null;
  systemPrompt: string | null;
  skillNames: string[];
  childRefs: string[];
  workflowEdges: Array<{ sourceRefs: string[]; targetRefs: string[] }>;
  inlineSubAgents: ParsedAdkInlineNode[];
  toolRefs: string[];
};

type WorkflowPipelineNode = {
  key: string;
  label: string;
  kind: AdkNodeKind;
  filePath: string | null;
  functionName: string | null;
  ordinal: number;
  parentKey: string | null;
  parentKeys: string[];
  depth: number;
  agentName: string | null;
  description: string | null;
  systemPrompt: string | null;
  configuredSkills: Array<{ name: string; content: string }>;
};

export interface AnalyzedWorkflowProject {
  sourceHash: string;
  entrypoint: string;
  pipelineDefinition: WorkflowPipelineDefinition;
  files: InstrumentationTarget[];
  rootDir: string;
  entryPath: string;
  executionTargetPath: string;
}

const PYTHON_EXT = ".py";
const EXCLUDED_DIRS = new Set([".git", ".venv", "venv", "__pycache__", "node_modules", ".mypy_cache", ".pytest_cache"]);
const LOW_PRIORITY_PATH_SEGMENTS = ["/eval/", "/tests/", "/test_", "_test.py"];

function humanizeFunctionName(name: string) {
  return name
    .replace(/^_+/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Phase";
}

async function collectPythonFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(PYTHON_EXT)) {
        results.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  results.sort();
  return results;
}

function parseFunctionNames(contents: string) {
  const pattern = /^([ \t]*)(async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  const functions: Array<{ indent: string; functionName: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    const functionName = match[3] ?? "";
    if (!functionName || functionName.startsWith("__")) continue;
    functions.push({ indent: match[1] ?? "", functionName });
  }
  return functions;
}

function relativePathPriority(relativePath: string) {
  const normalized = `/${relativePath.replaceAll("\\", "/")}`;
  let score = 0;
  if (normalized.endsWith("/agent.py")) score += 200;
  if (normalized.endsWith("/__init__.py")) score += 100;
  if (normalized.includes("/sub_agents/")) score += 50;
  if (LOW_PRIORITY_PATH_SEGMENTS.some((segment) => normalized.includes(segment))) score -= 250;
  return score;
}

function extractBalancedSection(source: string, startIndex: number, openChar: string, closeChar: string) {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let triple = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const nextThree = source.slice(index, index + 3);
    if (quote) {
      if (triple) {
        if (nextThree === quote.repeat(3)) {
          index += 2;
          quote = null;
          triple = false;
        }
        continue;
      }
      if (char === "\\" && index + 1 < source.length) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (nextThree === '"""' || nextThree === "'''") {
      quote = nextThree[0] as "'" | '"';
      triple = true;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      triple = false;
      continue;
    }
    if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex + 1, index);
      }
    }
  }
  return null;
}

function parsePythonStringArg(block: string, argName: string) {
  const pattern = new RegExp(
    `${argName}\\s*=\\s*(?:[rubfRUBF]*"""([\\s\\S]*?)"""|[rubfRUBF]*'''([\\s\\S]*?)'''|[rubfRUBF]*"([^"]*)"|[rubfRUBF]*'([^']*)')`,
    "m",
  );
  const match = block.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim() || null;
}

function parsePythonStringAssignment(contents: string, variableName: string) {
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(variableName)}\\s*=\\s*(?:[rubfRUBF]*"""([\\s\\S]*?)"""|[rubfRUBF]*'''([\\s\\S]*?)'''|[rubfRUBF]*"([^"\\n]*)"|[rubfRUBF]*'([^'\\n]*)')`,
    "m",
  );
  const match = contents.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim() || null;
}

function parsePythonStringOrReferenceArg(contents: string, block: string, argName: string) {
  const literal = parsePythonStringArg(block, argName);
  if (literal) return literal;
  const reference = new RegExp(`${argName}\\s*=\\s*([A-Za-z_][A-Za-z0-9_]*)`, "m")
    .exec(block)?.[1];
  return reference ? parsePythonStringAssignment(contents, reference) : null;
}

function parsePythonListArg(block: string, argName: string) {
  const startMatch = new RegExp(`${argName}\\s*=\\s*\\[`, "m").exec(block);
  if (!startMatch) return null;
  const bracketIndex = block.indexOf("[", startMatch.index);
  if (bracketIndex < 0) return null;
  return extractBalancedSection(block, bracketIndex, "[", "]");
}

function extractIdentifierRefs(source: string) {
  const refs: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const nextThree = source.slice(index, index + 3);
    if (char === "#") {
      const lineBreakIndex = source.indexOf("\n", index + 1);
      index = lineBreakIndex < 0 ? source.length : lineBreakIndex;
      continue;
    }
    if (nextThree === '"""' || nextThree === "'''") {
      const closeIndex = source.indexOf(nextThree, index + 3);
      index = closeIndex < 0 ? source.length : closeIndex + 3;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (current === quote) break;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] ?? "")) {
        end += 1;
      }
      const ref = source.slice(index, end);
      if (!seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return refs;
}

function splitTopLevelListItems(listBody: string) {
  const items: string[] = [];
  let current = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | null = null;
  let triple = false;

  for (let index = 0; index < listBody.length; index += 1) {
    const char = listBody[index];
    const nextThree = listBody.slice(index, index + 3);
    if (quote) {
      current += char;
      if (triple) {
        if (nextThree === quote.repeat(3)) {
          current += listBody[index + 1] ?? "";
          current += listBody[index + 2] ?? "";
          index += 2;
          quote = null;
          triple = false;
        }
        continue;
      }
      if (char === "\\" && index + 1 < listBody.length) {
        current += listBody[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (nextThree === '"""' || nextThree === "'''") {
      current += nextThree;
      quote = nextThree[0] as "'" | '"';
      triple = true;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      triple = false;
      continue;
    }
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth -= 1;
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth -= 1;
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth -= 1;
    if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

function parseAdkDefinitions(relativePath: string, contents: string): ParsedAdkDefinition[] {
  const definitions: ParsedAdkDefinition[] = [];
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(Agent|LlmAgent|LoopAgent|SequentialAgent|ParallelAgent|Workflow|JoinNode)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(contents)) !== null) {
    const variableName = match[1] ?? "";
    const constructor = match[2] ?? "Agent";
    const openParenIndex = contents.indexOf("(", match.index);
    if (openParenIndex < 0) continue;
    const callBody = extractBalancedSection(contents, openParenIndex, "(", ")");
    if (callBody == null) continue;
    const listItems = splitTopLevelListItems(parsePythonListArg(callBody, "sub_agents") ?? "");
    const subAgentRefs: string[] = [];
    const inlineSubAgents: ParsedAdkInlineNode[] = [];
    for (const item of listItems) {
      const inlineMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*name\s*=\s*["']([^"']+)["']/);
      if (inlineMatch) {
        inlineSubAgents.push({
          className: inlineMatch[1] ?? "",
          name: inlineMatch[2] ?? "",
        });
        continue;
      }
      const refMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      if (refMatch?.[1]) {
        subAgentRefs.push(refMatch[1]);
      }
    }

    const toolItems = splitTopLevelListItems(parsePythonListArg(callBody, "tools") ?? "");
    const toolRefs = toolItems.flatMap((item) => {
      const functionToolMatch = item.match(/^FunctionTool\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)$/);
      if (functionToolMatch?.[1]) return [functionToolMatch[1]];
      const refMatch = item.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
      return refMatch?.[1] ? [refMatch[1]] : [];
    });

    const workflowEdges =
      constructor === "Workflow"
        ? splitTopLevelListItems(parsePythonListArg(callBody, "edges") ?? "").flatMap((item) => {
            const refs = extractIdentifierRefs(item);
            if (refs.length === 0) return [];
            return [
              {
                sourceRefs: refs.slice(0, 1),
                targetRefs: refs.slice(1),
              },
            ];
          })
        : [];

    definitions.push({
      variableName,
      relativePath,
      definitionKind:
        constructor === "LoopAgent"
          ? "loop"
          : constructor === "Workflow"
            ? "workflow"
            : constructor === "JoinNode"
              ? "join"
              : "agent",
      name: parsePythonStringArg(callBody, "name") ?? variableName,
      description: parsePythonStringArg(callBody, "description"),
      systemPrompt: parsePythonStringOrReferenceArg(contents, callBody, "instruction"),
      skillNames: [...callBody.matchAll(/(?:_skill|load_skill(?:_bundle)?)\(\s*["']([^"']+)["']\s*\)/g)]
        .map((skillMatch) => skillMatch[1] ?? "")
        .filter((skillName, index, all) => Boolean(skillName) && all.indexOf(skillName) === index),
      childRefs: subAgentRefs,
      workflowEdges,
      inlineSubAgents,
      toolRefs,
    });
  }
  return definitions;
}

async function resolveAnalysisRoot(resolvedPath: string, stat: Awaited<ReturnType<typeof fs.stat>>) {
  const executionDir = stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const candidateFiles = stat.isDirectory()
    ? [path.join(resolvedPath, "agent.py"), path.join(resolvedPath, "__init__.py")]
    : [resolvedPath];
  const entryContents = (await Promise.all(candidateFiles.map((candidate) => fs.readFile(candidate, "utf8").catch(() => ""))))
    .join("\n");
  const importedPackageDirs = [...entryContents.matchAll(/^\s*(?:from|import)\s+(agents|services|tools)(?:\.|\s|$)/gm)]
    .map((match) => match[1] ?? "");
  if (importedPackageDirs.length === 0) return executionDir;
  const parentDir = path.dirname(executionDir);
  const hasPackageImports = await Promise.all(
    importedPackageDirs.map((dirName) => fs.stat(path.join(parentDir, dirName)).then((value) => value.isDirectory()).catch(() => false)),
  );
  return hasPackageImports.some(Boolean) ? parentDir : executionDir;
}

async function readConfiguredSkills(rootDir: string, skillNames: string[]) {
  if (process.env.BIZBOX_WORKFLOW_CAPTURE_DEFINITION_CONTENT?.trim().toLowerCase() !== "true") {
    return skillNames.map((name) => ({ name, content: "" }));
  }
  const skills: Array<{ name: string; content: string }> = [];
  for (const name of skillNames) {
    const skillDir = path.join(rootDir, "skills", name);
    const candidates = [
      path.join(skillDir, "SKILL.md"),
      ...((await fs.readdir(skillDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md")
        .map((entry) => path.join(skillDir, entry.name))),
      ...((await fs.readdir(path.join(skillDir, "references"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => path.join(skillDir, "references", entry.name))),
    ];
    const documents: string[] = [];
    for (const candidate of candidates) {
      const content = await fs.readFile(candidate, "utf8").catch(() => null);
      if (content != null) documents.push(`# ${path.basename(candidate)}\n\n${content}`);
    }
    if (documents.length > 0) skills.push({ name, content: documents.join("\n\n---\n\n") });
  }
  return skills;
}

function resolveLocalPythonModule(rootDir: string, moduleName: string) {
  const modulePath = moduleName.replaceAll(".", path.sep);
  return [path.join(rootDir, `${modulePath}.py`), path.join(rootDir, modulePath, "__init__.py")];
}

function collectReachablePythonFiles(
  rootDir: string,
  entryPath: string,
  contentsByPath: Map<string, string>,
) {
  const reachable = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const filePath = pending.shift();
    if (!filePath || reachable.has(filePath)) continue;
    reachable.add(filePath);
    const contents = contentsByPath.get(filePath) ?? "";
    const modules = [
      ...contents.matchAll(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/gm),
      ...contents.matchAll(/^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/gm),
    ].map((match) => match[1] ?? "");
    for (const moduleName of modules) {
      for (const candidate of resolveLocalPythonModule(rootDir, moduleName)) {
        if (contentsByPath.has(candidate) && !reachable.has(candidate)) pending.push(candidate);
      }
    }
  }
  return reachable;
}

function chooseEntrypointFromContents(
  rootDir: string,
  pythonFiles: string[],
  contentsByPath: Map<string, string>,
) {
  let bestFile = pythonFiles[0] ?? path.join(rootDir, "agent.py");
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const filePath of pythonFiles) {
    const relativePath = path.relative(rootDir, filePath) || path.basename(filePath);
    const contents = contentsByPath.get(filePath) ?? "";
    let score = relativePathPriority(relativePath);
    if (/^\s*root_agent\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*$/m.test(contents)) score += 500;
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*Workflow\s*\(/m.test(contents)) score += 120;
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(Agent|LoopAgent)\s*\(/m.test(contents)) score += 80;
    if (score > bestScore) {
      bestScore = score;
      bestFile = filePath;
    }
  }
  return bestFile;
}

function findRootAdkVariable(
  entryContents: string,
  definitions: Map<string, ParsedAdkDefinition>,
  entryRelativePath: string,
) {
  const aliasMatch = entryContents.match(/^\s*root_agent\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m);
  if (aliasMatch?.[1] && definitions.has(aliasMatch[1])) return aliasMatch[1];
  const entryDefinitions = [...definitions.values()].filter((definition) => definition.relativePath === entryRelativePath);
  for (const definition of entryDefinitions) {
    if (definition.definitionKind === "workflow") {
      return definition.variableName;
    }
  }
  return (
    entryDefinitions.find(
      (definition) => definition.relativePath === "agent.py" || definition.relativePath.endsWith("/agent.py"),
    )?.variableName ?? entryDefinitions[0]?.variableName ?? definitions.values().next().value?.variableName ?? null
  );
}

function inferNodeKind(name: string, fallback: AdkNodeKind): AdkNodeKind {
  return /checker|validator/i.test(name) ? "validator" : fallback;
}

function resolveExecutionTargetPath(rootDir: string, entryPath: string, originalAgentPath: string) {
  const resolvedOriginal = path.resolve(originalAgentPath);
  const entryDir = path.dirname(entryPath);
  const entryBasename = path.basename(entryPath).toLowerCase();

  if (resolvedOriginal === rootDir && entryDir !== rootDir) {
    if (entryBasename === "agent.py" || entryBasename === "__init__.py") {
      return entryDir;
    }
  }

  return resolvedOriginal;
}

function buildFallbackPipeline(entrypoint: string): WorkflowPipelineDefinition {
  return {
    entrypoint,
    generatedAt: new Date().toISOString(),
    phases: [
      {
        key: "entrypoint",
        label: "Entrypoint",
        kind: "phase",
        filePath: entrypoint,
        functionName: null,
        ordinal: 0,
      },
    ],
  };
}

export async function analyzeWorkflowProject(agentPath: string): Promise<AnalyzedWorkflowProject> {
  const resolvedPath = path.resolve(agentPath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw unprocessable(`Workflow agent path does not exist: ${resolvedPath}`);
  }
  const executionDir = stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const rootDir = await resolveAnalysisRoot(resolvedPath, stat);
  const pythonFiles = await collectPythonFiles(rootDir);
  if (pythonFiles.length === 0) {
    throw unprocessable("Workflow ADK path must contain at least one Python file");
  }
  const hash = createHash("sha256");
  const contentsByPath = new Map<string, string>();
  const topLevelFunctionsByFile = new Map<string, string[]>();
  const adkDefinitions = new Map<string, ParsedAdkDefinition>();
  const adkDefinitionsByPath = new Map<string, ParsedAdkDefinition[]>();

  for (const filePath of pythonFiles) {
    const relativePath = path.relative(rootDir, filePath) || path.basename(filePath);
    const contents = await fs.readFile(filePath, "utf8");
    contentsByPath.set(filePath, contents);
    hash.update(`FILE:${relativePath}\n`);
    hash.update(contents);
    topLevelFunctionsByFile.set(
      relativePath,
      parseFunctionNames(contents)
        .filter((fn) => fn.indent.length === 0)
        .map((fn) => fn.functionName),
    );
    adkDefinitionsByPath.set(filePath, parseAdkDefinitions(relativePath, contents));
  }

  const executionPythonFiles = stat.isDirectory()
    ? pythonFiles.filter((candidate) => candidate === executionDir || candidate.startsWith(`${executionDir}${path.sep}`))
    : [resolvedPath];
  const entryPath = stat.isDirectory()
    ? chooseEntrypointFromContents(rootDir, executionPythonFiles, contentsByPath)
    : resolvedPath;
  const executionTargetPath = resolveExecutionTargetPath(rootDir, entryPath, resolvedPath);
  const entrypoint = path.relative(rootDir, entryPath) || path.basename(entryPath);
  const reachablePythonFiles = collectReachablePythonFiles(rootDir, entryPath, contentsByPath);
  for (const filePath of reachablePythonFiles) {
    for (const definition of adkDefinitionsByPath.get(filePath) ?? []) {
      adkDefinitions.set(definition.variableName, definition);
    }
  }
  const instrumentationTargets: InstrumentationTarget[] = [];
  const pipelineNodes: WorkflowPipelineNode[] = [];
  const workflowFunctionRefs = new Set<string>();
  let appendUnattachedDefinitions = () => {};
  const configuredSkillsByVariable = new Map<string, Array<{ name: string; content: string }>>();
  for (const definition of adkDefinitions.values()) {
    configuredSkillsByVariable.set(definition.variableName, await readConfiguredSkills(rootDir, definition.skillNames));
  }

  if (adkDefinitions.size > 0) {
    const rootVar = findRootAdkVariable(contentsByPath.get(entryPath) ?? "", adkDefinitions, entrypoint);
    const visited = new Set<string>();
    const pipelineNodeByVariableName = new Map<string, WorkflowPipelineNode>();
    const workflowDefinition = rootVar ? adkDefinitions.get(rootVar) ?? null : null;
    const workflowEdges = workflowDefinition?.definitionKind === "workflow" ? workflowDefinition.workflowEdges : [];
    const outgoingWorkflowRefs = new Map<string, string[]>();
    const incomingWorkflowRefs = new Set<string>();
    for (const edge of workflowEdges) {
      for (const ref of [...edge.sourceRefs, ...edge.targetRefs]) workflowFunctionRefs.add(ref);
      for (const sourceRef of edge.sourceRefs) {
        const list = outgoingWorkflowRefs.get(sourceRef) ?? [];
        for (const targetRef of edge.targetRefs) {
          if (!list.includes(targetRef)) {
            list.push(targetRef);
          }
        }
        outgoingWorkflowRefs.set(sourceRef, list);
      }
      for (const targetRef of edge.targetRefs) {
        incomingWorkflowRefs.add(targetRef);
      }
    }
    let ordinal = 0;
    const workflowRefOrder = workflowEdges.flatMap((edge) => [
      ...edge.sourceRefs,
      ...edge.targetRefs,
    ]).filter((ref, index, all) => all.indexOf(ref) === index);
    for (const functionName of workflowRefOrder) {
      if (adkDefinitions.has(functionName)) continue;
      const relativePath = [...reachablePythonFiles]
        .map((filePath) => path.relative(rootDir, filePath) || path.basename(filePath))
        .find((candidate) => (topLevelFunctionsByFile.get(candidate) ?? []).includes(functionName));
      if (!relativePath) continue;
      const key = `${relativePath}:${functionName}`;
      pipelineNodes.push({
        key,
        label: humanizeFunctionName(functionName),
        kind: "phase",
        filePath: relativePath,
        functionName,
        ordinal: ordinal++,
        parentKey: null,
        parentKeys: [],
        depth: 0,
        agentName: null,
        description: null,
        systemPrompt: null,
        configuredSkills: [],
      });
      instrumentationTargets.push({
        relativePath,
        functionName,
        key,
        label: humanizeFunctionName(functionName),
      });
    }
    const addToolTarget = (definition: ParsedAdkDefinition, toolName: string, parentKey: string, depth: number) => {
      const key = `tool:${parentKey}:${toolName}`;
      pipelineNodes.push({
        key,
        label: toolName,
        kind: "tool",
        filePath: definition.relativePath,
        functionName: toolName,
        ordinal: ordinal++,
        parentKey,
        parentKeys: [parentKey],
        depth,
        agentName: null,
        description: null,
        systemPrompt: null,
        configuredSkills: [],
      });
      const topLevelFunctions = topLevelFunctionsByFile.get(definition.relativePath) ?? [];
      if (topLevelFunctions.includes(toolName)) {
        instrumentationTargets.push({
          relativePath: definition.relativePath,
          functionName: toolName,
          key,
          label: toolName,
        });
      }
    };
    const visitDefinition = (variableName: string, parentKey: string | null, depth: number) => {
      const definition = adkDefinitions.get(variableName);
      if (!definition) return;
      const existingNode = pipelineNodeByVariableName.get(variableName);
      if (visited.has(variableName)) {
        if (
          definition.definitionKind === "join" &&
          existingNode &&
          parentKey != null &&
          !existingNode.parentKeys.includes(parentKey)
        ) {
          existingNode.parentKeys.push(parentKey);
          existingNode.depth = Math.min(existingNode.depth, depth);
        }
        return;
      }
      visited.add(variableName);
      if (definition.definitionKind === "workflow") {
        const childRefs =
          workflowDefinition?.variableName === definition.variableName
            ? [...outgoingWorkflowRefs.keys()].filter((childRef) => !incomingWorkflowRefs.has(childRef))
            : definition.childRefs;
        for (const childRef of childRefs) {
          visitDefinition(childRef, parentKey, depth);
        }
        return;
      }
      const key = `${definition.definitionKind}:${definition.name}`;
      const parentKeys = parentKey == null ? [] : [parentKey];
      const node: WorkflowPipelineNode = {
        key,
        label: definition.name,
        kind:
          definition.definitionKind === "join"
            ? "phase"
            : inferNodeKind(definition.name, definition.definitionKind === "loop" ? "loop" : "agent"),
        filePath: definition.relativePath,
        functionName: definition.variableName,
        ordinal: ordinal++,
        parentKey,
        parentKeys,
        depth,
        agentName: definition.name,
        description: definition.description,
        systemPrompt: process.env.BIZBOX_WORKFLOW_CAPTURE_DEFINITION_CONTENT?.trim().toLowerCase() === "true"
          ? definition.systemPrompt
          : null,
        configuredSkills: configuredSkillsByVariable.get(variableName) ?? [],
      };
      pipelineNodeByVariableName.set(variableName, node);
      pipelineNodes.push(node);
      for (const inlineNode of definition.inlineSubAgents) {
        pipelineNodes.push({
          key: `validator:${inlineNode.name}`,
          label: inlineNode.name,
          kind: inferNodeKind(inlineNode.name, "validator"),
          filePath: definition.relativePath,
          functionName: inlineNode.className,
          ordinal: ordinal++,
          parentKey: key,
          parentKeys: [key],
          depth: depth + 1,
          agentName: inlineNode.name,
          description: null,
          systemPrompt: null,
          configuredSkills: [],
        });
      }
      for (const toolName of definition.toolRefs) {
        addToolTarget(definition, toolName, key, depth + 1);
      }
      const childRefs =
        workflowDefinition?.variableName != null
          ? [...new Set([...(definition.childRefs ?? []), ...(outgoingWorkflowRefs.get(definition.variableName) ?? [])])]
          : definition.childRefs;
      for (const childRef of childRefs) {
        visitDefinition(childRef, key, depth + 1);
      }
    };
    if (rootVar) {
      visitDefinition(rootVar, null, 0);
    }
    appendUnattachedDefinitions = () => {
      ordinal = pipelineNodes.reduce((highest, node) => Math.max(highest, node.ordinal + 1), 0);
      for (const definition of adkDefinitions.values()) {
        if (definition.definitionKind === "workflow" || definition.definitionKind === "join") continue;
        if (visited.has(definition.variableName)) continue;
        visitDefinition(definition.variableName, null, 0);
      }
    };
  }

  if (pipelineNodes.length === 0) {
    let ordinal = 0;
    const prioritizedFiles = [
      entryPath,
      ...executionPythonFiles.filter((candidate) => candidate !== entryPath),
    ];
    for (const filePath of prioritizedFiles) {
      const relativePath = path.relative(rootDir, filePath) || path.basename(filePath);
      for (const functionName of topLevelFunctionsByFile.get(relativePath) ?? []) {
        if (workflowFunctionRefs.size > 0 && !workflowFunctionRefs.has(functionName)) continue;
        const key = `${relativePath}:${functionName}`;
        instrumentationTargets.push({
          relativePath,
          functionName,
          key,
          label: humanizeFunctionName(functionName),
        });
        pipelineNodes.push({
          key,
          label: humanizeFunctionName(functionName),
          kind: "phase",
          filePath: relativePath,
          functionName,
          ordinal: ordinal++,
          parentKey: null,
          parentKeys: [],
          depth: 0,
          agentName: null,
          description: null,
          systemPrompt: null,
          configuredSkills: [],
        });
      }
    }
  }
  appendUnattachedDefinitions();

  const pipelineDefinition: WorkflowPipelineDefinition = pipelineNodes.length > 0
    ? {
        entrypoint,
        generatedAt: new Date().toISOString(),
        phases: pipelineNodes.map((node) => ({
          key: node.key,
          label: node.label,
          kind: node.kind,
          filePath: node.filePath,
          functionName: node.functionName,
          ordinal: node.ordinal,
          parentKey: node.parentKey,
          parentKeys: node.parentKeys,
          depth: node.depth,
          agentName: node.agentName,
          description: node.description,
          systemPrompt: node.systemPrompt,
          configuredSkills: node.configuredSkills,
        })),
      }
    : buildFallbackPipeline(entrypoint);

  return {
    sourceHash: hash.digest("hex"),
    entrypoint,
    pipelineDefinition,
    files: instrumentationTargets,
    rootDir,
    entryPath,
    executionTargetPath,
  };
}

function escapePythonString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRuntimeHelperModule() {
  return `import asyncio
import builtins
import contextlib
import contextvars
import datetime
import functools
import hashlib
import inspect
import json
import os
import re
import threading
import time
import urllib.request

_CURRENT_PHASE = contextvars.ContextVar("bizbox_current_phase", default=None)
_CURRENT_SPAN = contextvars.ContextVar("bizbox_current_span", default=None)
_API_BASE = os.environ.get("BIZBOX_API_URL", "").rstrip("/")
_RUN_ID = os.environ.get("BIZBOX_WORKFLOW_RUN_ID", "")
_TOKEN = os.environ.get("BIZBOX_WORKFLOW_RUN_TOKEN", "")
_AGENT_PHASES = json.loads(os.environ.get("BIZBOX_WORKFLOW_AGENT_PHASES", "{}") or "{}")
_TOOL_CALL_SEQUENCE = 0
_TELEMETRY_SEQUENCE = 0
_OPERATION_SEQUENCE = 0
_CURRENT_REVISION = 0
_CAPTURE_MESSAGE_CONTENT = os.environ.get("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "").strip().lower() in {
    "true", "span_only", "event_only", "span_and_event",
}
_OBSERVATION_MAX_PENDING = 500
_OBSERVATION_BATCH_SIZE = 50
_TELEMETRY_PENDING = []
_PHASE_PENDING = []
_TELEMETRY_LOCK = threading.RLock()
_TELEMETRY_WAKE = threading.Event()
_TELEMETRY_DROPPED = 0
_TELEMETRY_THREAD = None

def _request(method, path, payload=None, timeout=30):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{_API_BASE}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read().decode("utf-8")
        return json.loads(raw) if raw else {}

def _phase_payload(key, label, status, metadata=None):
    payload = {"token": _TOKEN, "phaseKey": key, "status": status}
    if label:
        payload["label"] = label
    if metadata is not None:
        payload["metadata"] = metadata
    return payload

def _safe_emit_phase(key, label, status, metadata=None):
    try:
        _enqueue_phase(_phase_payload(key, label, status, metadata))
    except Exception:
        pass

def _reliable_request_context(operation, payload, idempotency_key=None, generation_id=None, revision=None):
    resolved_revision = _CURRENT_REVISION if revision is None else int(revision)
    resolved_generation = str(generation_id or _RUN_ID)
    if idempotency_key is None:
        canonical = json.dumps(
            {"operation": operation, "generationId": resolved_generation, "revision": resolved_revision, "payload": payload},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        idempotency_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return {
        "idempotencyKey": str(idempotency_key),
        "generationId": resolved_generation,
        "revision": resolved_revision,
    }

def publish_review(deliverables, idempotency_key=None, generation_id=None, revision=None):
    """Publish to the opt-in Citro Social CMS review extension."""
    context = _reliable_request_context("publish_review", deliverables, idempotency_key, generation_id, revision)
    return _request(
        "POST",
        f"/api/workflow-runs/{_RUN_ID}/runtime/extensions/citro-social-cms/v1/review",
        {"token": _TOKEN, **context, "deliverables": deliverables},
    )

def publish_assets(assets, idempotency_key=None, generation_id=None, revision=None):
    """Publish assets to the opt-in Citro Social CMS review extension."""
    context = _reliable_request_context("publish_assets", assets, idempotency_key, generation_id, revision)
    return _request(
        "POST",
        f"/api/workflow-runs/{_RUN_ID}/runtime/extensions/citro-social-cms/v1/assets",
        {"token": _TOKEN, **context, "assets": assets},
    )

def _redact_telemetry(value, depth=0):
    if depth > 8:
        return "[depth-limited]"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return value if len(value) <= 20000 else value[:20000] + "...[truncated]"
    if isinstance(value, (list, tuple)):
        return [_redact_telemetry(item, depth + 1) for item in list(value)[:100]]
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:100]:
            key_text = str(key)
            if re.search(r"(?:api[_-]?key|token|secret|password|authorization|cookie)", key_text, re.I):
                result[key_text] = "[redacted]"
            else:
                result[key_text] = _redact_telemetry(item, depth + 1)
        return result
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _redact_telemetry(model_dump(mode="json"), depth + 1)
        except Exception:
            pass
    return _redact_telemetry(str(value), depth + 1)

def _new_span_id(prefix):
    global _OPERATION_SEQUENCE
    _OPERATION_SEQUENCE += 1
    safe_prefix = re.sub(r"[^A-Za-z0-9_.:-]+", "-", str(prefix)).strip("-")[:160] or "operation"
    return f"{safe_prefix}:{_OPERATION_SEQUENCE}"

def _emit_telemetry(event_type, span_id, operation_kind, operation_name, actor_kind, actor_name=None, parent_span_id=None, status=None, input_value=None, output_value=None, attributes=None, error=None):
    global _TELEMETRY_SEQUENCE
    _TELEMETRY_SEQUENCE += 1
    event = {
        "schema": "bizbox.telemetry/v1",
        "event": event_type,
        "eventId": f"{span_id}:{event_type}:{_TELEMETRY_SEQUENCE}",
        "spanId": span_id,
        "parentSpanId": parent_span_id,
        "sequence": _TELEMETRY_SEQUENCE,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "actor": {"kind": actor_kind, "name": actor_name},
        "operation": {"kind": operation_kind, "name": operation_name},
        "status": status,
        "attributes": _redact_telemetry(attributes or {}),
    }
    if _CAPTURE_MESSAGE_CONTENT and input_value is not None:
        event["input"] = _redact_telemetry(input_value)
    if _CAPTURE_MESSAGE_CONTENT and output_value is not None:
        event["output"] = _redact_telemetry(output_value)
    if error is not None:
        event["error"] = _redact_telemetry(str(error))
    _enqueue_telemetry(event)
    return event

def _pending_observation_count():
    return len(_TELEMETRY_PENDING) + len(_PHASE_PENDING)

def _record_dropped_observations(count=1):
    global _TELEMETRY_DROPPED
    with _TELEMETRY_LOCK:
        _TELEMETRY_DROPPED += count

def _enqueue_phase(payload):
    with _TELEMETRY_LOCK:
        if _pending_observation_count() >= _OBSERVATION_MAX_PENDING:
            _record_dropped_observations()
            return False
        _PHASE_PENDING.append(payload)
    _ensure_observation_worker()
    _TELEMETRY_WAKE.set()
    return True

def _enqueue_telemetry(event):
    global _TELEMETRY_DROPPED
    with _TELEMETRY_LOCK:
        if _pending_observation_count() >= _OBSERVATION_MAX_PENDING:
            _record_dropped_observations()
            return False
        if _TELEMETRY_DROPPED:
            attributes = dict(event.get("attributes") or {})
            attributes["observability.droppedEvents"] = _TELEMETRY_DROPPED
            event["attributes"] = attributes
            _TELEMETRY_DROPPED = 0
        _TELEMETRY_PENDING.append(event)
    _ensure_observation_worker()
    _TELEMETRY_WAKE.set()
    return True

def _take_observation_batch():
    with _TELEMETRY_LOCK:
        if _PHASE_PENDING:
            return "phase", [_PHASE_PENDING.pop(0)]
        if _TELEMETRY_PENDING:
            batch = list(_TELEMETRY_PENDING[:_OBSERVATION_BATCH_SIZE])
            del _TELEMETRY_PENDING[:len(batch)]
            return "telemetry", batch
    return None, []

def _send_observation_batch(kind, batch):
    if kind == "phase":
        _request(
            "POST",
            f"/api/workflow-runs/{_RUN_ID}/runtime/phase-events",
            batch[0],
            timeout=1,
        )
        return
    _request(
        "POST",
        f"/api/workflow-runs/{_RUN_ID}/runtime/telemetry-events",
        {"token": _TOKEN, "events": batch},
        timeout=1,
    )

def _observation_worker():
    while True:
        _TELEMETRY_WAKE.wait(timeout=0.25)
        _TELEMETRY_WAKE.clear()
        kind, batch = _take_observation_batch()
        if not batch:
            continue
        try:
            _send_observation_batch(kind, batch)
        except Exception:
            _record_dropped_observations(len(batch))
        with _TELEMETRY_LOCK:
            has_more = _pending_observation_count() > 0
        if has_more:
            _TELEMETRY_WAKE.set()

def _ensure_observation_worker():
    global _TELEMETRY_THREAD
    with _TELEMETRY_LOCK:
        if _TELEMETRY_THREAD is not None and _TELEMETRY_THREAD.is_alive():
            return True
        try:
            thread = threading.Thread(
                target=_observation_worker,
                name="bizbox-observability",
                daemon=True,
            )
            thread.start()
            _TELEMETRY_THREAD = thread
            return True
        except Exception:
            _TELEMETRY_THREAD = None
            return False

def _safe_emit_telemetry(*args, **kwargs):
    try:
        return _emit_telemetry(*args, **kwargs)
    except Exception:
        return None

def emit_operation_started(name, kind="service", input=None, actor_kind="service", actor_name=None, span_id=None, parent_span_id=None, attributes=None):
    resolved_span_id = span_id or _new_span_id(f"{kind}:{name}")
    _safe_emit_telemetry(
        "operation.started", resolved_span_id, kind, str(name), actor_kind,
        actor_name or str(name), parent_span_id if parent_span_id is not None else _CURRENT_SPAN.get(),
        "running", input_value=input, attributes=attributes,
    )
    return resolved_span_id

def emit_operation_completed(span_id, name, kind="service", output=None, actor_kind="service", actor_name=None, parent_span_id=None, attributes=None):
    return _safe_emit_telemetry(
        "operation.completed", span_id, kind, str(name), actor_kind,
        actor_name or str(name), parent_span_id, "succeeded", output_value=output, attributes=attributes,
    )

def emit_operation_failed(span_id, name, error, kind="service", actor_kind="service", actor_name=None, parent_span_id=None, attributes=None):
    return _safe_emit_telemetry(
        "operation.failed", span_id, kind, str(name), actor_kind,
        actor_name or str(name), parent_span_id, "failed", attributes=attributes, error=error,
    )

@contextlib.contextmanager
def telemetry_operation(name, kind="service", input=None, actor_kind="service", actor_name=None, attributes=None):
    parent_span_id = _CURRENT_SPAN.get()
    span_id = emit_operation_started(name, kind, input, actor_kind, actor_name, parent_span_id=parent_span_id, attributes=attributes)
    token = _CURRENT_SPAN.set(span_id)
    state = {"span_id": span_id, "output": None}
    try:
        yield state
        emit_operation_completed(span_id, name, kind, state.get("output"), actor_kind, actor_name, parent_span_id, attributes)
    except Exception as exc:
        emit_operation_failed(span_id, name, exc, kind, actor_kind, actor_name, parent_span_id, attributes)
        raise
    finally:
        _CURRENT_SPAN.reset(token)

def observed_operation(name=None, kind="service", actor_kind="service"):
    def decorator(fn):
        operation_name = name or getattr(fn, "__name__", "operation")
        if asyncio.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args, **kwargs):
                with telemetry_operation(operation_name, kind, {"args": args, "kwargs": kwargs}, actor_kind) as operation:
                    result = await fn(*args, **kwargs)
                    operation["output"] = result
                    return result
            return async_wrapper
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with telemetry_operation(operation_name, kind, {"args": args, "kwargs": kwargs}, actor_kind) as operation:
                result = fn(*args, **kwargs)
                operation["output"] = result
                return result
        return wrapper
    return decorator

def _phase_info_for_agent(agent):
    name = getattr(agent, "name", None)
    if not name:
        return None
    raw = _AGENT_PHASES.get(str(name))
    if not isinstance(raw, dict):
        return None
    key = raw.get("key")
    label = raw.get("label")
    if not key or not label:
        return None
    return {"key": str(key), "label": str(label)}

def _text_from_content(value):
    parts = getattr(value, "parts", None)
    if not isinstance(parts, (list, tuple)):
        return None
    texts = []
    for part in parts:
        text = getattr(part, "text", None)
        if isinstance(text, str) and text.strip():
            texts.append(text.strip())
    return (chr(10) * 2).join(texts) or None

def _json_safe_output(value):
    if value is None or isinstance(value, (str, int, float, bool, dict, list)):
        try:
            json.dumps(value)
            return value
        except Exception:
            pass
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            dumped = model_dump(mode="json")
            json.dumps(dumped)
            return dumped
        except Exception:
            pass
    return str(value)

def _output_from_value(value):
    if value is None:
        return None
    output = getattr(value, "output", None)
    if output is not None:
        return _json_safe_output(output)
    content = getattr(value, "content", None)
    if getattr(content, "role", None) == "model":
        text = _text_from_content(content)
        if text:
            return text
    if isinstance(value, (str, int, float, bool, dict, list)):
        return _json_safe_output(value)
    return None

def _prompt_from_call(args, kwargs):
    for candidate in list(kwargs.values()) + list(args):
        for attr in ("user_content", "content"):
            text = _text_from_content(getattr(candidate, attr, None))
            if text:
                return text
        text = _text_from_content(candidate)
        if text:
            return text
    return None

def _model_name(agent):
    model = getattr(agent, "model", None)
    if isinstance(model, str):
        return model.strip() or None
    for attr in ("model", "model_name"):
        value = getattr(model, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None

def _tool_names(agent):
    result = []
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, (list, tuple)):
        return result
    for tool in tools:
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None)
        if not name:
            fn = getattr(tool, "func", None)
            name = getattr(fn, "__name__", None)
        if isinstance(name, str) and name.strip() and name.strip() not in result:
            result.append(name.strip())
    return result

def _runtime_info_for_agent(agent, args, kwargs):
    name = getattr(agent, "name", None)
    if not isinstance(name, str) or not name.strip():
        return None
    name = name.strip()
    mapped = _phase_info_for_agent(agent)
    safe_name = re.sub(r"[^A-Za-z0-9_.:-]+", "-", name).strip("-")[:180] or "agent"
    metadata = {
        "runtimeAgent": True,
        "agentName": name,
        "model": _model_name(agent),
        "configuredTools": _tool_names(agent),
    }
    if _CAPTURE_MESSAGE_CONTENT:
        instruction = getattr(agent, "instruction", None)
        metadata["systemPrompt"] = instruction if isinstance(instruction, str) and instruction.strip() else None
        metadata["prompt"] = _prompt_from_call(args, kwargs)
    return {
        "key": mapped["key"] if mapped is not None else f"agent-runtime:{safe_name}",
        "label": mapped["label"] if mapped is not None else name,
        "metadata": metadata,
    }

def _start_agent_telemetry(info):
    parent_span_id = _CURRENT_SPAN.get()
    metadata = info["metadata"]
    attributes = {
        "phaseKey": info["key"],
        "model": metadata.get("model"),
        "configuredTools": metadata.get("configuredTools") or [],
    }
    if _CAPTURE_MESSAGE_CONTENT:
        attributes["systemPrompt"] = metadata.get("systemPrompt")
    span_id = emit_operation_started(
        info["label"], "agent", {"prompt": metadata.get("prompt")} if _CAPTURE_MESSAGE_CONTENT else None, "agent",
        metadata.get("agentName") or info["label"], parent_span_id=parent_span_id,
        attributes=attributes,
    )
    return span_id, parent_span_id

def _wrap_tool_class(cls):
    original = getattr(cls, "run_async", None)
    if original is None or getattr(original, "__bizbox_tool_wrapped__", False):
        return
    if not asyncio.iscoroutinefunction(original):
        return

    async def tool_wrapper(self, *args, **kwargs):
        global _TOOL_CALL_SEQUENCE
        _TOOL_CALL_SEQUENCE += 1
        parent_key = _CURRENT_PHASE.get()
        name = getattr(self, "name", None) or self.__class__.__name__
        safe_name = re.sub(r"[^A-Za-z0-9_.:-]+", "-", str(name)).strip("-")[:120] or "tool"
        call_id = f"tool-{_TOOL_CALL_SEQUENCE}"
        phase_key = f"tool-runtime:{safe_name}:{_TOOL_CALL_SEQUENCE}"
        call_args = kwargs.get("args")
        if call_args is None and args:
            call_args = args[0]
        metadata = {
            "runtimePhase": True,
            "runtimeKind": "tool",
            "parentKey": parent_key,
            "runtimeToolName": str(name),
            "runtimeToolId": call_id,
        }
        if _CAPTURE_MESSAGE_CONTENT:
            metadata["runtimeToolInput"] = _json_safe_output(call_args if call_args is not None else {})
        parent_span_id = _CURRENT_SPAN.get()
        telemetry_span_id = emit_operation_started(
            str(name), "tool", call_args if call_args is not None else {}, "tool", str(name),
            parent_span_id=parent_span_id,
            attributes={"phaseKey": phase_key, "parentPhaseKey": parent_key, "toolCallId": call_id},
        )
        span_token = _CURRENT_SPAN.set(telemetry_span_id)
        _safe_emit_phase(phase_key, str(name), "running", metadata)
        try:
            result = await original(self, *args, **kwargs)
            output = _json_safe_output(result)
            _safe_emit_phase(
                phase_key,
                str(name),
                "succeeded",
                {"runtimeToolOutput": output} if _CAPTURE_MESSAGE_CONTENT else None,
            )
            emit_operation_completed(telemetry_span_id, str(name), "tool", output, "tool", str(name), parent_span_id)
            return result
        except Exception as exc:
            _safe_emit_phase(
                phase_key,
                str(name),
                "failed",
                {"error": str(exc)},
            )
            emit_operation_failed(telemetry_span_id, str(name), exc, "tool", "tool", str(name), parent_span_id)
            raise
        finally:
            _CURRENT_SPAN.reset(span_token)
    setattr(tool_wrapper, "__bizbox_tool_wrapped__", True)
    setattr(cls, "run_async", tool_wrapper)

def _wrap_agent_method(cls, method_name):
    original = getattr(cls, method_name, None)
    if original is None or getattr(original, "__bizbox_wrapped__", False):
        return

    if inspect.isasyncgenfunction(original):
        async def asyncgen_wrapper(self, *args, **kwargs):
            info = _runtime_info_for_agent(self, args, kwargs)
            token = None
            span_token = None
            telemetry_span_id = None
            parent_span_id = None
            observed_output = None
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "running", info["metadata"])
                token = _CURRENT_PHASE.set(info["key"])
                telemetry_span_id, parent_span_id = _start_agent_telemetry(info)
                span_token = _CURRENT_SPAN.set(telemetry_span_id)
            try:
                async for item in original(self, *args, **kwargs):
                    candidate_output = _output_from_value(item)
                    if candidate_output is not None:
                        observed_output = candidate_output
                    yield item
                if info is not None:
                    metadata = {"output": observed_output} if _CAPTURE_MESSAGE_CONTENT and observed_output is not None else None
                    _safe_emit_phase(info["key"], info["label"], "succeeded", metadata)
                    emit_operation_completed(
                        telemetry_span_id, info["label"], "agent", observed_output, "agent",
                        info["metadata"].get("agentName") or info["label"], parent_span_id,
                    )
            except Exception as exc:
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
                    emit_operation_failed(
                        telemetry_span_id, info["label"], exc, "agent", "agent",
                        info["metadata"].get("agentName") or info["label"], parent_span_id,
                    )
                raise
            finally:
                if span_token is not None:
                    _CURRENT_SPAN.reset(span_token)
                if token is not None:
                    _CURRENT_PHASE.reset(token)
        setattr(asyncgen_wrapper, "__bizbox_wrapped__", True)
        setattr(cls, method_name, asyncgen_wrapper)
        return

    if asyncio.iscoroutinefunction(original):
        async def async_wrapper(self, *args, **kwargs):
            info = _runtime_info_for_agent(self, args, kwargs)
            token = None
            span_token = None
            telemetry_span_id = None
            parent_span_id = None
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "running", info["metadata"])
                token = _CURRENT_PHASE.set(info["key"])
                telemetry_span_id, parent_span_id = _start_agent_telemetry(info)
                span_token = _CURRENT_SPAN.set(telemetry_span_id)
            try:
                result = await original(self, *args, **kwargs)
                if info is not None:
                    output = _output_from_value(result)
                    metadata = {"output": output} if _CAPTURE_MESSAGE_CONTENT and output is not None else None
                    _safe_emit_phase(info["key"], info["label"], "succeeded", metadata)
                    emit_operation_completed(
                        telemetry_span_id, info["label"], "agent", output, "agent",
                        info["metadata"].get("agentName") or info["label"], parent_span_id,
                    )
                return result
            except Exception as exc:
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
                    emit_operation_failed(
                        telemetry_span_id, info["label"], exc, "agent", "agent",
                        info["metadata"].get("agentName") or info["label"], parent_span_id,
                    )
                raise
            finally:
                if span_token is not None:
                    _CURRENT_SPAN.reset(span_token)
                if token is not None:
                    _CURRENT_PHASE.reset(token)
        setattr(async_wrapper, "__bizbox_wrapped__", True)
        setattr(cls, method_name, async_wrapper)
        return

    def wrapper(self, *args, **kwargs):
        info = _runtime_info_for_agent(self, args, kwargs)
        token = None
        span_token = None
        telemetry_span_id = None
        parent_span_id = None
        if info is not None:
            _safe_emit_phase(info["key"], info["label"], "running", info["metadata"])
            token = _CURRENT_PHASE.set(info["key"])
            telemetry_span_id, parent_span_id = _start_agent_telemetry(info)
            span_token = _CURRENT_SPAN.set(telemetry_span_id)
        try:
            result = original(self, *args, **kwargs)
            if info is not None:
                output = _output_from_value(result)
                metadata = {"output": output} if _CAPTURE_MESSAGE_CONTENT and output is not None else None
                _safe_emit_phase(info["key"], info["label"], "succeeded", metadata)
                emit_operation_completed(
                    telemetry_span_id, info["label"], "agent", output, "agent",
                    info["metadata"].get("agentName") or info["label"], parent_span_id,
                )
            return result
        except Exception as exc:
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
                emit_operation_failed(
                    telemetry_span_id, info["label"], exc, "agent", "agent",
                    info["metadata"].get("agentName") or info["label"], parent_span_id,
                )
            raise
        finally:
            if span_token is not None:
                _CURRENT_SPAN.reset(span_token)
            if token is not None:
                _CURRENT_PHASE.reset(token)
    setattr(wrapper, "__bizbox_wrapped__", True)
    setattr(cls, method_name, wrapper)

def workflow_phase(key, label):
    def decorator(fn):
        if asyncio.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def async_wrapper(*args, **kwargs):
                parent_span_id = _CURRENT_SPAN.get()
                telemetry_span_id = emit_operation_started(
                    label, "phase", None, "workflow", label, parent_span_id=parent_span_id,
                    attributes={"phaseKey": key, "functionName": getattr(fn, "__name__", None)},
                )
                _safe_emit_phase(key, label, "running")
                token = _CURRENT_PHASE.set(key)
                span_token = _CURRENT_SPAN.set(telemetry_span_id)
                try:
                    result = await fn(*args, **kwargs)
                    _safe_emit_phase(key, label, "succeeded")
                    emit_operation_completed(
                        telemetry_span_id, label, "phase", _output_from_value(result), "workflow", label, parent_span_id,
                    )
                    return result
                except Exception as exc:
                    _safe_emit_phase(key, label, "failed", {"error": str(exc)})
                    emit_operation_failed(telemetry_span_id, label, exc, "phase", "workflow", label, parent_span_id)
                    raise
                finally:
                    _CURRENT_SPAN.reset(span_token)
                    _CURRENT_PHASE.reset(token)
            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            parent_span_id = _CURRENT_SPAN.get()
            telemetry_span_id = emit_operation_started(
                label, "phase", None, "workflow", label, parent_span_id=parent_span_id,
                attributes={"phaseKey": key, "functionName": getattr(fn, "__name__", None)},
            )
            _safe_emit_phase(key, label, "running")
            token = _CURRENT_PHASE.set(key)
            span_token = _CURRENT_SPAN.set(telemetry_span_id)
            try:
                result = fn(*args, **kwargs)
                _safe_emit_phase(key, label, "succeeded")
                emit_operation_completed(
                    telemetry_span_id, label, "phase", _output_from_value(result), "workflow", label, parent_span_id,
                )
                return result
            except Exception as exc:
                _safe_emit_phase(key, label, "failed", {"error": str(exc)})
                emit_operation_failed(telemetry_span_id, label, exc, "phase", "workflow", label, parent_span_id)
                raise
            finally:
                _CURRENT_SPAN.reset(span_token)
                _CURRENT_PHASE.reset(token)
        return wrapper
    return decorator

def workflow_input(prompt=""):
    global _CURRENT_REVISION
    phase_key = _CURRENT_PHASE.get() or "entrypoint"
    prompt_text = str(prompt or "")
    stage_match = re.match(r"^\\s*\\[bizbox:review-stage=(content|final)\\]\\s*", prompt_text, re.IGNORECASE)
    review_stage = stage_match.group(1).lower() if stage_match else None
    if stage_match:
        prompt_text = prompt_text[stage_match.end():]
    event_phase_match = re.match(r"^\\s*\\[bizbox:cms-review-phase=(grounding|planning|assets)\\]\\s*", prompt_text, re.IGNORECASE)
    event_phase = event_phase_match.group(1).lower() if event_phase_match else None
    if event_phase_match:
        prompt_text = prompt_text[event_phase_match.end():]
    review_summary_match = re.match(r"^\\s*\\[bizbox:cms-review-summary=([^\\]]+)\\]\\s*", prompt_text, re.IGNORECASE)
    review_summary = review_summary_match.group(1).strip() if review_summary_match else None
    if review_summary_match:
        prompt_text = prompt_text[review_summary_match.end():]
    lowered = prompt_text.lower()
    kind = "approval" if re.search(r"(approve|approval|confirm|yes/no|y/n)", lowered) else "response"
    handoff_payload = {
        "phaseKey": phase_key,
        "kind": kind,
        **({"stage": review_stage} if review_stage else {}),
        **({"eventPhase": event_phase} if event_phase else {}),
        **({"reviewSummary": review_summary} if review_summary else {}),
        "promptMarkdown": prompt_text or "Human input required.",
    }
    if review_stage or event_phase or review_summary:
        canonical_handoff = json.dumps(
            {"revision": _CURRENT_REVISION, "payload": handoff_payload},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        handoff_payload["idempotencyKey"] = hashlib.sha256(canonical_handoff.encode("utf-8")).hexdigest()
    created = _request(
        "POST",
        f"/api/workflow-runs/{_RUN_ID}/handoffs/runtime",
        {
            "token": _TOKEN,
            **handoff_payload,
        },
    )
    handoff_id = created["id"]
    poll_delay = 1.0
    _MAX_POLL_ERRORS = 10
    consecutive_errors = 0
    while True:
        try:
            state = _request("POST", f"/api/workflow-handoffs/{handoff_id}/runtime", {"token": _TOKEN})
            consecutive_errors = 0
        except Exception as poll_exc:
            consecutive_errors += 1
            if consecutive_errors >= _MAX_POLL_ERRORS:
                raise RuntimeError(
                    f"Workflow handoff polling failed after {_MAX_POLL_ERRORS} consecutive errors"
                ) from poll_exc
            time.sleep(poll_delay)
            poll_delay = min(poll_delay * 1.5, 30.0)
            continue
        status = state.get("status")
        response_markdown = state.get("responseMarkdown") or ""
        if response_markdown:
            try:
                response_payload = json.loads(response_markdown)
                if isinstance(response_payload, dict) and isinstance(response_payload.get("revision"), int):
                    _CURRENT_REVISION = response_payload["revision"]
            except (TypeError, ValueError):
                pass
        if status == "approved":
            return "approved"
        if status == "rejected":
            # Rejection is an input to the workflow. The workflow owns the choice
            # to stop, revise, or follow another branch.
            return "rejected"
        if status == "responded":
            return response_markdown
        if status == "cancelled":
            raise RuntimeError("Workflow handoff was cancelled")
        time.sleep(poll_delay)
        poll_delay = min(poll_delay * 1.5, 10.0)

builtins.input = workflow_input

try:
    from google.adk.agents import BaseAgent as _BizboxBaseAgent

    for _method_name in ("run_async",):
        if hasattr(_BizboxBaseAgent, _method_name):
            _wrap_agent_method(_BizboxBaseAgent, _method_name)
except Exception:
    pass

try:
    from google.adk.tools.base_tool import BaseTool as _BizboxBaseTool
    from google.adk.tools.function_tool import FunctionTool as _BizboxFunctionTool

    _wrap_tool_class(_BizboxBaseTool)
    _wrap_tool_class(_BizboxFunctionTool)
    _original_init_subclass = _BizboxBaseTool.__dict__.get("__init_subclass__")

    @classmethod
    def _bizbox_tool_init_subclass(cls, **kwargs):
        if _original_init_subclass is not None:
            _original_init_subclass.__get__(cls, _BizboxBaseTool)(**kwargs)
        else:
            super(_BizboxBaseTool, cls).__init_subclass__(**kwargs)
        _wrap_tool_class(cls)

    _BizboxBaseTool.__init_subclass__ = _bizbox_tool_init_subclass
except Exception:
    pass
`;
}

async function instrumentPythonFile(filePath: string, functionEntries: InstrumentationTarget[]) {
  let contents = await fs.readFile(filePath, "utf8");
  if (functionEntries.length === 0) return;
  if (!contents.includes("from bizbox_workflow_runtime import workflow_phase as __bizbox_workflow_phase")) {
    const runtimeImport = "from bizbox_workflow_runtime import workflow_phase as __bizbox_workflow_phase\n";
    const futureImports = [...contents.matchAll(
      /^from[ \t]+__future__[ \t]+import[ \t]+(?:\([^)]*\)|[^\r\n]*)(?:\r?\n|$)/gm,
    )];
    const lastFutureImport = futureImports.at(-1);
    if (lastFutureImport?.index != null) {
      const insertionIndex = lastFutureImport.index + lastFutureImport[0].length;
      contents = `${contents.slice(0, insertionIndex)}${runtimeImport}${contents.slice(insertionIndex)}`;
    } else {
      contents = `${runtimeImport}${contents}`;
    }
  }
  for (const entry of functionEntries) {
    const pattern = new RegExp(`^(\\s*)(async\\s+def|def)\\s+${escapeRegExp(entry.functionName)}\\s*[(]`, "m");
    contents = contents.replace(
      pattern,
      (_, indent: string, keyword: string) => `${indent}@__bizbox_workflow_phase("${escapePythonString(entry.key)}", "${escapePythonString(entry.label)}")\n${indent}${keyword} ${entry.functionName}(`,
    );
  }
  await fs.writeFile(filePath, contents, "utf8");
}

function maybeMapIntoCopiedTree(originalRoot: string, copiedRoot: string, candidate: unknown) {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return candidate;
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(path.resolve(originalRoot))) return candidate;
  return path.join(copiedRoot, path.relative(originalRoot, resolved));
}

export interface PreparedWorkflowRuntime {
  tempRoot: string;
  runtimeRoot: string;
  copiedAgentPath: string;
  patchedRunnerConfig: Record<string, unknown>;
}

export async function prepareInstrumentedWorkflowRuntime(input: {
  workflowId: string;
  runId: string;
  companyId: string;
  runnerConfig: Record<string, unknown>;
  analysis: AnalyzedWorkflowProject;
  runToken: string;
}) : Promise<PreparedWorkflowRuntime> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `bizbox-workflow-${input.runId}-`));
  const copiedRoot = path.join(tempRoot, "project");
  await fs.cp(input.analysis.rootDir, copiedRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(input.analysis.rootDir, source);
      if (!relative) return true;
      return !relative.split(path.sep).some((segment) => EXCLUDED_DIRS.has(segment));
    },
  });

  const fileEntriesByRelativePath = new Map<string, InstrumentationTarget[]>();
  for (const entry of input.analysis.files) {
    const list = fileEntriesByRelativePath.get(entry.relativePath) ?? [];
    list.push(entry);
    fileEntriesByRelativePath.set(entry.relativePath, list);
  }
  for (const [relativePath, entries] of fileEntriesByRelativePath.entries()) {
    await instrumentPythonFile(path.join(copiedRoot, relativePath), entries);
  }

  await fs.writeFile(path.join(tempRoot, "bizbox_workflow_runtime.py"), buildRuntimeHelperModule(), "utf8");
  // Use sitecustomize.py so the monkey-patch fires unconditionally before any user code runs.
  // .pth files are only processed from site-packages directories — not from arbitrary PYTHONPATH
  // entries — so the .pth approach silently does nothing in venv environments. sitecustomize.py,
  // by contrast, is searched across all of sys.path (including PYTHONPATH dirs) by the Python
  // interpreter itself, making it reliable in venvs. If the agent project already ships its own
  // sitecustomize.py it will be shadowed, but that is an acceptable trade-off given that the
  // alternative (input() hitting EOF in a non-interactive subprocess) is a hard crash.
  await fs.writeFile(path.join(tempRoot, "sitecustomize.py"), "import bizbox_workflow_runtime\n", "utf8");

  const copiedAgentPath = (() => {
    const mapped = maybeMapIntoCopiedTree(input.analysis.rootDir, copiedRoot, input.analysis.executionTargetPath);
    return typeof mapped === "string" && mapped.trim().length > 0
      ? mapped
      : path.join(copiedRoot, path.relative(input.analysis.rootDir, input.analysis.entryPath));
  })();
  const runtimeRoot = path.join(os.tmpdir(), "bizbox-workflow-runs", input.companyId, input.workflowId, input.runId);
  await fs.mkdir(runtimeRoot, { recursive: true });

  const existingPythonPath = typeof process.env.PYTHONPATH === "string" && process.env.PYTHONPATH.length > 0
    ? process.env.PYTHONPATH
    : "";
  const patchedEnv = {
    ...(typeof input.runnerConfig.env === "object" && input.runnerConfig.env !== null
      ? input.runnerConfig.env as Record<string, string>
      : {}),
    PYTHONPATH: [tempRoot, existingPythonPath].filter(Boolean).join(path.delimiter),
    BIZBOX_WORKFLOW_RUN_ID: input.runId,
    BIZBOX_WORKFLOW_RUN_TOKEN: input.runToken,
    BIZBOX_WORKFLOW_AGENT_PHASES: JSON.stringify(
      Object.fromEntries(
        input.analysis.pipelineDefinition.phases
          .filter((phase) => (phase.kind === "agent" || phase.kind === "loop" || phase.kind === "validator") && phase.agentName)
          .map((phase) => [phase.agentName as string, { key: phase.key, label: phase.label }]),
      ),
    ),
  };

  const patchedRunnerConfig: Record<string, unknown> = {
    ...input.runnerConfig,
    agentPath: copiedAgentPath,
    cwd: maybeMapIntoCopiedTree(input.analysis.rootDir, copiedRoot, input.runnerConfig.cwd) ?? path.dirname(copiedAgentPath),
    instructionsFilePath: maybeMapIntoCopiedTree(input.analysis.rootDir, copiedRoot, input.runnerConfig.instructionsFilePath),
    env: patchedEnv,
  };

  return {
    tempRoot,
    runtimeRoot,
    copiedAgentPath,
    patchedRunnerConfig,
  };
}

async function collectFilesRecursive(rootDir: string): Promise<string[]> {
  const collected: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        collected.push(full);
      }
    }
  }
  await walk(rootDir);
  collected.sort();
  return collected;
}

function guessContentType(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

export interface RuntimeArtifactFile {
  relativePath: string;
  originalFilename: string;
  body: Buffer;
  contentType: string;
}

export async function collectWorkflowRuntimeArtifacts(runtimeRoot: string): Promise<RuntimeArtifactFile[]> {
  const artifactDir = path.join(runtimeRoot, "artifacts");
  const files = await collectFilesRecursive(artifactDir);
  const artifacts: RuntimeArtifactFile[] = [];
  for (const filePath of files) {
    const body = await fs.readFile(filePath);
    artifacts.push({
      relativePath: path.relative(artifactDir, filePath),
      originalFilename: path.basename(filePath),
      body,
      contentType: guessContentType(filePath),
    });
  }
  return artifacts;
}
