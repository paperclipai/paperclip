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
  kind: "agent" | "loop";
  name: string;
  description: string | null;
  subAgentRefs: string[];
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
  depth: number;
  agentName: string | null;
  description: string | null;
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
  const pattern = /^(\s*)(async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
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
    `${argName}\\s*=\\s*(?:"""([\\s\\S]*?)"""|'''([\\s\\S]*?)'''|"([^"]*)"|'([^']*)')`,
    "m",
  );
  const match = block.match(pattern);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim() || null;
}

function parsePythonListArg(block: string, argName: string) {
  const startMatch = new RegExp(`${argName}\\s*=\\s*\\[`, "m").exec(block);
  if (!startMatch) return null;
  const bracketIndex = block.indexOf("[", startMatch.index);
  if (bracketIndex < 0) return null;
  return extractBalancedSection(block, bracketIndex, "[", "]");
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
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(Agent|LoopAgent)\s*\(/gm;
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

    definitions.push({
      variableName,
      relativePath,
      kind: constructor === "LoopAgent" ? "loop" : "agent",
      name: parsePythonStringArg(callBody, "name") ?? variableName,
      description: parsePythonStringArg(callBody, "description"),
      subAgentRefs,
      inlineSubAgents,
      toolRefs,
    });
  }
  return definitions;
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
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(Agent|LoopAgent)\s*\(/m.test(contents)) score += 80;
    if (score > bestScore) {
      bestScore = score;
      bestFile = filePath;
    }
  }
  return bestFile;
}

function findRootAdkVariable(entryContents: string, definitions: Map<string, ParsedAdkDefinition>) {
  const aliasMatch = entryContents.match(/^\s*root_agent\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m);
  if (aliasMatch?.[1] && definitions.has(aliasMatch[1])) return aliasMatch[1];
  for (const definition of definitions.values()) {
    if (definition.relativePath === "agent.py" || definition.relativePath.endsWith("/agent.py")) {
      return definition.variableName;
    }
  }
  return definitions.values().next().value?.variableName ?? null;
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
  const rootDir = stat.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const pythonFiles = stat.isDirectory() ? await collectPythonFiles(rootDir) : [resolvedPath];
  if (pythonFiles.length === 0) {
    throw unprocessable("Workflow ADK path must contain at least one Python file");
  }
  const hash = createHash("sha256");
  const contentsByPath = new Map<string, string>();
  const topLevelFunctionsByFile = new Map<string, string[]>();
  const adkDefinitions = new Map<string, ParsedAdkDefinition>();

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
    for (const definition of parseAdkDefinitions(relativePath, contents)) {
      adkDefinitions.set(definition.variableName, definition);
    }
  }

  const entryPath = stat.isDirectory()
    ? chooseEntrypointFromContents(rootDir, pythonFiles, contentsByPath)
    : resolvedPath;
  const executionTargetPath = resolveExecutionTargetPath(rootDir, entryPath, resolvedPath);
  const entrypoint = path.relative(rootDir, entryPath) || path.basename(entryPath);
  const instrumentationTargets: InstrumentationTarget[] = [];
  const pipelineNodes: WorkflowPipelineNode[] = [];

  if (adkDefinitions.size > 0) {
    const rootVar = findRootAdkVariable(contentsByPath.get(entryPath) ?? "", adkDefinitions);
    const visited = new Set<string>();
    let ordinal = 0;
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
        depth,
        agentName: null,
        description: null,
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
      if (visited.has(variableName)) return;
      const definition = adkDefinitions.get(variableName);
      if (!definition) return;
      visited.add(variableName);
      const key = `${definition.kind}:${definition.name}`;
      pipelineNodes.push({
        key,
        label: definition.name,
        kind: inferNodeKind(definition.name, definition.kind),
        filePath: definition.relativePath,
        functionName: definition.variableName,
        ordinal: ordinal++,
        parentKey,
        depth,
        agentName: definition.name,
        description: definition.description,
      });
      for (const subAgentRef of definition.subAgentRefs) {
        visitDefinition(subAgentRef, key, depth + 1);
      }
      for (const inlineNode of definition.inlineSubAgents) {
        pipelineNodes.push({
          key: `validator:${inlineNode.name}`,
          label: inlineNode.name,
          kind: inferNodeKind(inlineNode.name, "validator"),
          filePath: definition.relativePath,
          functionName: inlineNode.className,
          ordinal: ordinal++,
          parentKey: key,
          depth: depth + 1,
          agentName: inlineNode.name,
          description: null,
        });
      }
      for (const toolName of definition.toolRefs) {
        addToolTarget(definition, toolName, key, depth + 1);
      }
    };
    if (rootVar) {
      visitDefinition(rootVar, null, 0);
    }
  }

  if (pipelineNodes.length === 0) {
    let ordinal = 0;
    const prioritizedFiles = [
      entryPath,
      ...pythonFiles.filter((candidate) => candidate !== entryPath),
    ];
    for (const filePath of prioritizedFiles) {
      const relativePath = path.relative(rootDir, filePath) || path.basename(filePath);
      for (const functionName of topLevelFunctionsByFile.get(relativePath) ?? []) {
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
          depth: 0,
          agentName: null,
          description: null,
        });
      }
    }
  }

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
          depth: node.depth,
          agentName: node.agentName,
          description: node.description,
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
import contextvars
import inspect
import json
import os
import re
import time
import urllib.request

_CURRENT_PHASE = contextvars.ContextVar("bizbox_current_phase", default=None)
_API_BASE = os.environ.get("BIZBOX_API_URL", "").rstrip("/")
_RUN_ID = os.environ.get("BIZBOX_WORKFLOW_RUN_ID", "")
_TOKEN = os.environ.get("BIZBOX_WORKFLOW_RUN_TOKEN", "")
_AGENT_PHASES = json.loads(os.environ.get("BIZBOX_WORKFLOW_AGENT_PHASES", "{}") or "{}")

def _request(method, path, payload=None):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"{_API_BASE}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as res:
        raw = res.read().decode("utf-8")
        return json.loads(raw) if raw else {}

def _phase_payload(key, label, status, metadata=None):
    payload = {"token": _TOKEN, "phaseKey": key, "status": status}
    if label:
        payload["label"] = label
    if metadata is not None:
        payload["metadata"] = metadata
    return payload

def _emit_phase(key, label, status, metadata=None):
    _request("POST", f"/api/workflow-runs/{_RUN_ID}/runtime/phase-events", _phase_payload(key, label, status, metadata))

def _safe_emit_phase(key, label, status, metadata=None):
    try:
        _emit_phase(key, label, status, metadata)
    except Exception:
        pass

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

def _wrap_agent_method(cls, method_name):
    original = getattr(cls, method_name, None)
    if original is None or getattr(original, "__bizbox_wrapped__", False):
        return

    if inspect.isasyncgenfunction(original):
        async def asyncgen_wrapper(self, *args, **kwargs):
            info = _phase_info_for_agent(self)
            token = None
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "running")
                token = _CURRENT_PHASE.set(info["key"])
            try:
                async for item in original(self, *args, **kwargs):
                    yield item
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "succeeded")
            except Exception as exc:
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
                raise
            finally:
                if token is not None:
                    _CURRENT_PHASE.reset(token)
        setattr(asyncgen_wrapper, "__bizbox_wrapped__", True)
        setattr(cls, method_name, asyncgen_wrapper)
        return

    if asyncio.iscoroutinefunction(original):
        async def async_wrapper(self, *args, **kwargs):
            info = _phase_info_for_agent(self)
            token = None
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "running")
                token = _CURRENT_PHASE.set(info["key"])
            try:
                result = await original(self, *args, **kwargs)
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "succeeded")
                return result
            except Exception as exc:
                if info is not None:
                    _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
                raise
            finally:
                if token is not None:
                    _CURRENT_PHASE.reset(token)
        setattr(async_wrapper, "__bizbox_wrapped__", True)
        setattr(cls, method_name, async_wrapper)
        return

    def wrapper(self, *args, **kwargs):
        info = _phase_info_for_agent(self)
        token = None
        if info is not None:
            _safe_emit_phase(info["key"], info["label"], "running")
            token = _CURRENT_PHASE.set(info["key"])
        try:
            result = original(self, *args, **kwargs)
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "succeeded")
            return result
        except Exception as exc:
            if info is not None:
                _safe_emit_phase(info["key"], info["label"], "failed", {"error": str(exc)})
            raise
        finally:
            if token is not None:
                _CURRENT_PHASE.reset(token)
    setattr(wrapper, "__bizbox_wrapped__", True)
    setattr(cls, method_name, wrapper)

def workflow_phase(key, label):
    def decorator(fn):
        if asyncio.iscoroutinefunction(fn):
            async def async_wrapper(*args, **kwargs):
                _safe_emit_phase(key, label, "running")
                token = _CURRENT_PHASE.set(key)
                try:
                    result = await fn(*args, **kwargs)
                    _safe_emit_phase(key, label, "succeeded")
                    return result
                except Exception as exc:
                    _safe_emit_phase(key, label, "failed", {"error": str(exc)})
                    raise
                finally:
                    _CURRENT_PHASE.reset(token)
            return async_wrapper

        def wrapper(*args, **kwargs):
            _safe_emit_phase(key, label, "running")
            token = _CURRENT_PHASE.set(key)
            try:
                result = fn(*args, **kwargs)
                _safe_emit_phase(key, label, "succeeded")
                return result
            except Exception as exc:
                _safe_emit_phase(key, label, "failed", {"error": str(exc)})
                raise
            finally:
                _CURRENT_PHASE.reset(token)
        return wrapper
    return decorator

def workflow_input(prompt=""):
    phase_key = _CURRENT_PHASE.get() or "entrypoint"
    prompt_text = str(prompt or "")
    lowered = prompt_text.lower()
    kind = "approval" if re.search(r"(approve|approval|confirm|yes/no|y/n)", lowered) else "response"
    created = _request(
        "POST",
        f"/api/workflow-runs/{_RUN_ID}/handoffs/runtime",
        {
            "token": _TOKEN,
            "phaseKey": phase_key,
            "kind": kind,
            "promptMarkdown": prompt_text or "Human input required.",
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
        if status == "approved":
            return "approved"
        if status == "rejected":
            return "rejected"
        if status == "responded":
            return state.get("responseMarkdown") or ""
        if status == "cancelled":
            raise RuntimeError("Workflow handoff was cancelled")
        time.sleep(poll_delay)
        poll_delay = min(poll_delay * 1.5, 10.0)

builtins.input = workflow_input

try:
    from google.adk.agents import BaseAgent as _BizboxBaseAgent

    for _method_name in ("run_async", "_run_async_impl"):
        if hasattr(_BizboxBaseAgent, _method_name):
            _wrap_agent_method(_BizboxBaseAgent, _method_name)
except Exception:
    pass
`;
}

async function instrumentPythonFile(filePath: string, functionEntries: InstrumentationTarget[]) {
  let contents = await fs.readFile(filePath, "utf8");
  if (functionEntries.length === 0) return;
  if (!contents.includes("from bizbox_workflow_runtime import workflow_phase as __bizbox_workflow_phase")) {
    contents = `from bizbox_workflow_runtime import workflow_phase as __bizbox_workflow_phase\n${contents}`;
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
  await fs.cp(input.analysis.rootDir, copiedRoot, { recursive: true });

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
