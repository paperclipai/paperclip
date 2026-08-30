import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const PRP_SCHEMA_ID_PREFIX = "https://paperclip.dev/schemas/prp/v1/";
export const SUPPORTED_FIXTURE_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSION = 1;
export const SUPPORTED_EVENT_SCHEMA_VERSION = 1;

function contractError(code, detail) {
  return new Error(`${code}: ${detail}`);
}

export async function readJson(path) {
  const source = await readFile(path, "utf8");
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    throw contractError("invalid_json", `${path}: ${error.message}`);
  }
}

export async function listJsonFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

export function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function collectReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") output.push(child);
    else collectReferences(child, output);
  }
  return output;
}

function resolveJsonPointer(value, fragment) {
  if (fragment === "") return value;
  if (!fragment.startsWith("/")) return undefined;
  return fragment
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      if (current === null || typeof current !== "object") return undefined;
      return Object.hasOwn(current, part) ? current[part] : undefined;
    }, value);
}

export async function loadSchemaCatalog(schemaDirectory) {
  const files = await listJsonFiles(schemaDirectory);
  const records = await Promise.all(files.map(async (path) => ({ path, ...(await readJson(path)) })));
  const ids = new Map();

  for (const record of records) {
    const schema = record.value;
    if (schema.$schema !== JSON_SCHEMA_DIALECT) {
      throw contractError("unsupported_schema_dialect", portableRelative(schemaDirectory, record.path));
    }
    if (typeof schema.$id !== "string" || !schema.$id.startsWith(PRP_SCHEMA_ID_PREFIX)) {
      throw contractError("invalid_schema_id", portableRelative(schemaDirectory, record.path));
    }
    if (ids.has(schema.$id)) throw contractError("duplicate_schema_id", schema.$id);
    if (typeof schema.title !== "string" || schema.title.length === 0) {
      throw contractError("missing_schema_title", schema.$id);
    }
    ids.set(schema.$id, record);
  }

  for (const record of records) {
    for (const reference of collectReferences(record.value)) {
      const [targetId, fragment = ""] = reference.split("#", 2);
      const target = targetId === "" ? record : ids.get(targetId);
      if (target === undefined) {
        throw contractError("unresolved_schema_reference", `${record.value.$id} -> ${reference}`);
      }
      if (resolveJsonPointer(target.value, fragment) === undefined) {
        throw contractError("unresolved_schema_fragment", `${record.value.$id} -> ${reference}`);
      }
    }
  }

  return records;
}

export function compileProtocolValidators(schemaRecords) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
    formats: {
      "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    },
  });
  for (const record of schemaRecords) ajv.addSchema(record.value);

  const get = (name) => {
    const id = `${PRP_SCHEMA_ID_PREFIX}${name}.schema.json`;
    const validator = ajv.getSchema(id);
    if (validator === undefined) throw contractError("missing_schema_validator", id);
    return validator;
  };
  return {
    conformanceFixture: get("conformance-fixture"),
    conformanceOutput: get("conformance-output"),
    fixture: get("fixture"),
    providerDescriptor: get("provider-descriptor"),
    questionAdapterFixture: get("question-adapter-fixture"),
  };
}

export function assertSchemaInstance(validator, value, location, expectedValid = true) {
  const valid = validator(value);
  if (valid !== expectedValid) {
    const detail = (validator.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    const expectation = expectedValid ? "accepted" : "rejected";
    throw contractError("schema_validation_failed", `${location} must be ${expectation}: ${detail || "no AJV error"}`);
  }
  return value;
}

function requireSchema(value, expected, location) {
  if (value?.schema !== expected) {
    throw contractError("unsupported_required_schema", `${location} requires ${String(value?.schema)}`);
  }
}

function requireVersion(value, expected, name) {
  if (value !== expected) {
    throw contractError("unsupported_required_version", `${name}=${String(value)}; supported=${expected}`);
  }
}

export function assertReplayFixtureCompatibility(fixture) {
  requireSchema(fixture, "paperclip.prp.fixture.v1", "fixture");
  requireVersion(fixture.fixtureVersion, SUPPORTED_FIXTURE_VERSION, "fixtureVersion");
  requireVersion(fixture.protocolVersion, SUPPORTED_PROTOCOL_VERSION, "protocolVersion");
  requireSchema(fixture.identity, "paperclip.prp.identity.v1", "identity");
  requireSchema(fixture.capabilities, "paperclip.prp.capabilities.v1", "capabilities");

  if (!Array.isArray(fixture.commands)) throw contractError("invalid_fixture", "commands must be an array");
  for (const [index, command] of fixture.commands.entries()) {
    requireSchema(command, "paperclip.prp.command.v1", `commands[${index}]`);
  }

  if (!Array.isArray(fixture.events) || fixture.events.length === 0) {
    throw contractError("invalid_fixture", "events must be a non-empty array");
  }
  for (const [index, event] of fixture.events.entries()) {
    requireSchema(event, "paperclip.prp.event.v1", `events[${index}]`);
    requireVersion(event.schemaVersion, SUPPORTED_EVENT_SCHEMA_VERSION, `events[${index}].schemaVersion`);
  }

  requireSchema(fixture.result, "paperclip.run_result.v1", "result");
  return fixture;
}

export function assertCodexQuestionFixture(fixture) {
  requireSchema(fixture, "paperclip.question_adapter_fixture.v1", "question fixture");
  if (fixture.adapter !== "codex") throw contractError("unsupported_provider", String(fixture.adapter));
  requireSchema(fixture.canonicalQuestionSet, "paperclip.question_set.v1", "canonicalQuestionSet");
  requireSchema(fixture.canonicalResponse, "paperclip.question_response.v1", "canonicalResponse");
  if (fixture.nativeRequest?.method !== "item/tool/requestUserInput") {
    throw contractError("invalid_codex_question_fixture", "native request method");
  }

  const questions = fixture.canonicalQuestionSet.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw contractError("invalid_codex_question_fixture", "questions must be non-empty");
  }
  const questionIds = new Set();
  const optionIdsByQuestion = new Map();
  for (const question of questions) {
    if (typeof question.id !== "string" || question.id.length === 0 || questionIds.has(question.id)) {
      throw contractError("invalid_codex_question_fixture", "question IDs must be unique");
    }
    questionIds.add(question.id);
    const optionIds = new Set();
    for (const option of question.options ?? []) {
      if (typeof option.id !== "string" || option.id.length === 0 || optionIds.has(option.id)) {
        throw contractError("invalid_codex_question_fixture", `option IDs for ${question.id} must be unique`);
      }
      optionIds.add(option.id);
    }
    optionIdsByQuestion.set(question.id, optionIds);
  }
  for (const [answerId, answer] of Object.entries(fixture.canonicalResponse.answers ?? {})) {
    if (!questionIds.has(answerId)) {
      throw contractError("invalid_codex_question_fixture", `answer has unknown question ID ${answerId}`);
    }
    for (const optionId of answer.selectedOptionIds ?? []) {
      if (!optionIdsByQuestion.get(answerId)?.has(optionId)) {
        throw contractError("invalid_codex_question_fixture", `answer has unknown option ID ${optionId}`);
      }
    }
  }
  return fixture;
}

export function assertConformanceFixturePair(fixture, output) {
  if (fixture?.schemaVersion !== "paperclip.runner.conformance.fixture.v1") {
    throw contractError("unsupported_required_schema", `conformance fixture requires ${String(fixture?.schemaVersion)}`);
  }
  if (output?.schemaVersion !== "paperclip.runner.conformance.output.v1") {
    throw contractError("unsupported_required_schema", `conformance output requires ${String(output?.schemaVersion)}`);
  }
  if (fixture.run?.runId !== output.runIdentity?.runId || fixture.run?.sessionId !== output.runIdentity?.sessionId) {
    throw contractError("conformance_identity_mismatch", "run or session identity differs");
  }
  for (const [index, event] of (fixture.events ?? []).entries()) {
    if (event.runId !== fixture.run.runId || event.sequence !== index + 1) {
      throw contractError("invalid_conformance_event", `events[${index}] does not match the run sequence`);
    }
  }
  if (
    fixture.result?.status !== output.result?.status
    || fixture.result?.summary !== output.result?.summary
    || fixture.result?.runId !== fixture.run.runId
  ) {
    throw contractError("conformance_result_mismatch", "expected output does not match the fixture result");
  }
  return { fixture, output };
}
