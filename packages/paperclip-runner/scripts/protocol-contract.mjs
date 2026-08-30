import { spawnSync } from "node:child_process";
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
    const semanticToolVersion = event.payload?.semantic_tool?.schemaVersion;
    if (semanticToolVersion !== undefined) {
      requireVersion(semanticToolVersion, 1, `events[${index}].payload.semantic_tool.schemaVersion`);
    }
  }

  requireSchema(fixture.result, "paperclip.run_result.v1", "result");
  return fixture;
}

export function assertQuestionAdapterFixture(fixture) {
  requireSchema(fixture, "paperclip.question_adapter_fixture.v1", "question fixture");
  requireSchema(fixture.canonicalQuestionSet, "paperclip.question_set.v1", "canonicalQuestionSet");
  requireSchema(fixture.canonicalResponse, "paperclip.question_response.v1", "canonicalResponse");

  const questions = fixture.canonicalQuestionSet.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw contractError("invalid_question_adapter_fixture", "questions must be non-empty");
  }
  const questionsById = new Map();
  const optionIdsByQuestion = new Map();
  for (const question of questions) {
    if (typeof question.id !== "string" || question.id.length === 0 || questionsById.has(question.id)) {
      throw contractError("invalid_question_adapter_fixture", "question IDs must be unique");
    }
    questionsById.set(question.id, question);
    const optionIds = new Set();
    for (const option of question.options ?? []) {
      if (typeof option.id !== "string" || option.id.length === 0 || optionIds.has(option.id)) {
        throw contractError("invalid_question_adapter_fixture", `option IDs for ${question.id} must be unique`);
      }
      optionIds.add(option.id);
    }
    optionIdsByQuestion.set(question.id, optionIds);
    const validation = question.textValidation;
    if (
      validation?.minLength !== undefined
      && validation.maxLength !== undefined
      && validation.minLength > validation.maxLength
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minLength greater than maxLength`);
    }
    if (
      validation?.minimum !== undefined
      && validation.maximum !== undefined
      && validation.minimum > validation.maximum
    ) {
      throw contractError("invalid_question_adapter_fixture", `text validation for ${question.id} has minimum greater than maximum`);
    }
    if (validation?.pattern !== undefined) {
      try {
        new RegExp(validation.pattern);
      } catch {
        throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
      }
    }
  }
  const answers = fixture.canonicalResponse.answers ?? {};
  for (const [answerId, answer] of Object.entries(answers)) {
    if (!questionsById.has(answerId)) {
      throw contractError("invalid_question_adapter_fixture", `answer has unknown question ID ${answerId}`);
    }
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} must be an object`);
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    if (!Array.isArray(selectedOptionIds) || selectedOptionIds.some((id) => typeof id !== "string")) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} has invalid option IDs`);
    }
    if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw contractError("invalid_question_adapter_fixture", `answer for ${answerId} repeats an option ID`);
    }
    for (const optionId of selectedOptionIds) {
      if (!optionIdsByQuestion.get(answerId)?.has(optionId)) {
        throw contractError("invalid_question_adapter_fixture", `answer has unknown option ID ${optionId}`);
      }
    }
  }
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) {
      if (question.required) {
        throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is missing`);
      }
      continue;
    }
    const selectedOptionIds = answer.selectedOptionIds ?? [];
    const text = answer.text;
    const customText = answer.customText;
    if (question.answerMode === "text") {
      if (selectedOptionIds.length > 0 || customText !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `text answer for ${question.id} carries select-only fields`);
      }
    } else {
      if (text !== undefined) {
        throw contractError("invalid_question_adapter_fixture", `select answer for ${question.id} carries text`);
      }
      if (question.answerMode === "single_select" && selectedOptionIds.length > 1) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} chooses more than one option`);
      }
      if (customText !== undefined && question.customAnswer?.enabled !== true) {
        throw contractError("invalid_question_adapter_fixture", `custom answer for ${question.id} is not enabled`);
      }
      if (
        question.answerMode === "single_select"
        && typeof customText === "string"
        && customText.trim().length > 0
        && selectedOptionIds.length > 0
      ) {
        throw contractError("invalid_question_adapter_fixture", `single-select answer for ${question.id} mixes option and custom values`);
      }
    }
    const hasValue = fixtureAnswerHasValue(answer);
    if (question.required && !hasValue) {
      throw contractError("invalid_question_adapter_fixture", `answer for required question ${question.id} is empty`);
    }
    const boundedText = question.answerMode === "text" ? text : customText;
    if (boundedText !== undefined) {
      const validation = question.textValidation;
      if (validation?.minLength !== undefined && boundedText.length < validation.minLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at least ${validation.minLength} characters`);
      }
      if (validation?.maxLength !== undefined && boundedText.length > validation.maxLength) {
        throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must contain at most ${validation.maxLength} characters`);
      }
      if (validation?.pattern !== undefined) {
        let pattern;
        try {
          pattern = new RegExp(validation.pattern);
        } catch {
          throw contractError("invalid_question_adapter_fixture", `text validation pattern for ${question.id} is invalid`);
        }
        if (!testFixturePatternWithDeadline(pattern.source, boundedText, question.id)) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} does not match the required format`);
        }
      }
      if (validation?.inputType === "number" || validation?.inputType === "integer") {
        const numeric = Number(boundedText);
        if (!Number.isFinite(numeric) || (validation.inputType === "integer" && !Number.isInteger(numeric))) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be a valid ${validation.inputType}`);
        }
        if (validation.minimum !== undefined && numeric < validation.minimum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at least ${validation.minimum}`);
        }
        if (validation.maximum !== undefined && numeric > validation.maximum) {
          throw contractError("invalid_question_adapter_fixture", `answer for ${question.id} must be at most ${validation.maximum}`);
        }
      }
    }
  }
  return fixture;
}

export function assertCodexQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "codex") throw contractError("unsupported_provider", String(fixture.adapter));
  if (fixture.nativeRequest?.method !== "item/tool/requestUserInput") {
    throw contractError("invalid_codex_question_fixture", "native request method");
  }
  return fixture;
}

export function assertAcpxQuestionFixture(fixture) {
  assertQuestionAdapterFixture(fixture);
  if (fixture.adapter !== "acpx") {
    throw contractError("unsupported_provider", String(fixture.adapter));
  }
  const request = fixture.nativeRequest;
  if (!isPlainRecord(request) || request.method !== "elicitation/create") {
    throw contractError("invalid_acpx_question_fixture", "native request method");
  }
  const params = request.params;
  const requestedSchema = isPlainRecord(params) ? params.requestedSchema : null;
  if (
    !isPlainRecord(params)
    || params.mode !== "form"
    || !isPlainRecord(requestedSchema)
    || !isPlainRecord(requestedSchema.properties)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native form request");
  }
  const properties = Object.entries(requestedSchema.properties);
  if (properties.length === 0 || properties.length > 64) {
    throw contractError("invalid_acpx_question_fixture", "native form property count");
  }
  const required = normalizedAcpxRequired(requestedSchema);
  for (const [name, property] of properties) {
    assertAcpxProperty(name, property);
    if (
      isPlainRecord(property)
      && property.type === "string"
      && acpxEnumValues(property, "oneOf").length === 0
      && optionalFixtureText(property.pattern) !== undefined
    ) {
      throw contractError(
        "invalid_acpx_question_fixture",
        `native property ${name} uses an unsupported pattern`,
      );
    }
  }

  const response = fixture.nativeResponse;
  if (
    !isPlainRecord(response)
    || response.action !== "accept"
    || !isPlainRecord(response.content)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native accept response");
  }
  for (const [name] of properties) {
    if (required.has(name) && !Object.hasOwn(response.content, name)) {
      throw contractError("invalid_acpx_question_fixture", `native response omits required property ${name}`);
    }
  }
  for (const [name, value] of Object.entries(response.content)) {
    const property = requestedSchema.properties[name];
    if (!isPlainRecord(property)) {
      throw contractError("invalid_acpx_question_fixture", `native response has unknown property ${name}`);
    }
    assertAcpxPropertyValue(name, property, value);
  }
  const projected = projectAcpxFixture(params, fixture.canonicalResponse);
  if (canonicalFixtureJson(projected.questionSet) !== canonicalFixtureJson(fixture.canonicalQuestionSet)) {
    throw contractError("invalid_acpx_question_fixture", "native and canonical question sets differ");
  }
  if (canonicalFixtureJson(projected.nativeResponse) !== canonicalFixtureJson(fixture.nativeResponse)) {
    throw contractError("invalid_acpx_question_fixture", "canonical and native responses differ");
  }
  return fixture;
}

function projectAcpxFixture(params, canonicalResponse) {
  const schema = params.requestedSchema;
  const required = normalizedAcpxRequired(schema);
  const bindings = Object.entries(schema.properties).map(([name, property], index) =>
    projectAcpxProperty(name, property, index, required.has(name))
  );
  const title = optionalFixtureText(schema.title) ?? "Additional information needed";
  const descriptions = [
    optionalFixtureText(params.message),
    optionalFixtureText(schema.description),
  ].filter((value, index, all) => value !== undefined && value !== title && all.indexOf(value) === index);
  const questionSet = {
    schema: "paperclip.question_set.v1",
    title,
    ...(descriptions.length > 0 ? { description: descriptions.join("\n\n") } : {}),
    submitLabel: "Submit answers",
    questions: bindings.map((binding) => binding.question),
  };
  const content = {};
  for (const binding of bindings) {
    const answer = canonicalResponse.answers?.[binding.question.id];
    // The production parser accepts explicit empty optional answers and omits
    // them from its normalized response. Mirror that before projecting ACP
    // content so the fixture gate certifies the same wire behavior.
    if (!answer || !fixtureAnswerHasValue(answer)) continue;
    if (binding.type === "string" && binding.question.answerMode === "text") {
      if (answer.text !== undefined) defineAcpxResponseProperty(content, binding.name, answer.text);
    } else if (binding.type === "number" || binding.type === "integer") {
      if (answer.text !== undefined) {
        defineAcpxResponseProperty(content, binding.name, Number(answer.text));
      }
    } else if (binding.type === "boolean") {
      const selected = answer.selectedOptionIds?.[0];
      if (selected !== undefined) {
        defineAcpxResponseProperty(
          content,
          binding.name,
          binding.optionValues.get(selected) === "true",
        );
      }
    } else {
      const selected = (answer.selectedOptionIds ?? []).map((id) => binding.optionValues.get(id));
      if (binding.type === "array") {
        defineAcpxResponseProperty(content, binding.name, selected);
      } else if (selected[0] !== undefined) {
        defineAcpxResponseProperty(content, binding.name, selected[0]);
      }
    }
  }
  return { questionSet, nativeResponse: { action: "accept", content } };
}

function fixtureAnswerHasValue(answer) {
  return (
    (typeof answer.text === "string" && answer.text.trim().length > 0)
    || (typeof answer.customText === "string" && answer.customText.trim().length > 0)
    || (Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0)
  );
}

function defineAcpxResponseProperty(content, name, value) {
  Object.defineProperty(content, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizedAcpxRequired(schema) {
  const propertyNames = new Set(
    isPlainRecord(schema.properties) ? Object.keys(schema.properties) : [],
  );
  return new Set(
    Array.isArray(schema.required)
      ? schema.required
          .filter(
            (value) => typeof value === "string" && propertyNames.has(value),
          )
      : []
  );
}

function projectAcpxProperty(name, property, index, required) {
  const id = stableAcpxFieldId(name, index);
  const header = optionalFixtureText(property.title) ?? name;
  const base = {
    id,
    header,
    prompt: optionalFixtureText(property.description) ?? header,
    required,
  };
  if (property.type === "string") {
    const options = acpxNativeOptions(property, "oneOf");
    if (options.length > 0) return projectedAcpxOptions(name, property.type, base, options, "single_select");
    const pattern = optionalFixtureText(property.pattern);
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: "text",
          ...(finiteNonNegativeFixtureInteger(property.minLength) !== undefined
            ? { minLength: property.minLength }
            : {}),
          ...(finiteNonNegativeFixtureInteger(property.maxLength) !== undefined
            ? { maxLength: property.maxLength }
            : {}),
          ...(pattern !== undefined ? { pattern } : {}),
        },
      },
    };
  }
  if (property.type === "number" || property.type === "integer") {
    return {
      name,
      type: property.type,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: property.type,
          ...(Number.isFinite(property.minimum) ? { minimum: property.minimum } : {}),
          ...(Number.isFinite(property.maximum) ? { maximum: property.maximum } : {}),
        },
      },
    };
  }
  if (property.type === "boolean") {
    return projectedAcpxOptions(name, property.type, base, [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ], "single_select");
  }
  return projectedAcpxOptions(
    name,
    property.type,
    base,
    acpxNativeOptions(property.items, "anyOf"),
    "multi_select",
  );
}

function testFixturePatternWithDeadline(pattern, value, questionId) {
  const outcome = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const {pattern,value}=JSON.parse(Buffer.concat(chunks).toString());process.stdout.write(new RegExp(pattern).test(value)?'1':'0');",
    ],
    {
      input: JSON.stringify({ pattern, value }),
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1_024,
      windowsHide: true,
    },
  );
  if (outcome.error || outcome.signal || outcome.status !== 0) {
    throw contractError(
      "invalid_question_adapter_fixture",
      `text validation pattern for ${questionId} could not be evaluated safely`,
    );
  }
  return outcome.stdout === "1";
}

function projectedAcpxOptions(name, type, base, nativeOptions, answerMode) {
  const optionValues = new Map();
  const options = nativeOptions.map((option, index) => {
    const id = `option-${index + 1}`;
    optionValues.set(id, option.value);
    return {
      id,
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    };
  });
  return { name, type, optionValues, question: { ...base, answerMode, options } };
}

function acpxNativeOptions(property, preferredTitledKey) {
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  if (Array.isArray(titled)) {
    return titled.map((entry) => ({
      value: entry.const,
      label: optionalFixtureText(entry.title) ?? entry.const,
      ...(optionalFixtureText(entry.description) !== undefined
        ? { description: entry.description }
        : {}),
    }));
  }
  return (Array.isArray(property.enum) ? property.enum : [])
    .map((value) => ({ value, label: value }));
}

function stableAcpxFieldId(value, index) {
  const readable = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `field-${index + 1}-${readable || "value"}-${sha256(value).slice(0, 12)}`;
}

function optionalFixtureText(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNonNegativeFixtureInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function canonicalFixtureJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAcpxProperty(name, value) {
  if (!isPlainRecord(value)) {
    throw contractError("invalid_acpx_question_fixture", `native property ${name}`);
  }
  if (!["string", "number", "integer", "boolean", "array"].includes(value.type)) {
    throw contractError("invalid_acpx_question_fixture", `unsupported native property ${name}`);
  }
  if (value.type === "array") {
    if (!isPlainRecord(value.items) || acpxEnumValues(value.items, "anyOf").length === 0) {
      throw contractError("invalid_acpx_question_fixture", `native array property ${name} requires options`);
    }
  } else if (value.type === "string") {
    acpxEnumValues(value, "oneOf");
  }
}

function assertAcpxPropertyValue(name, property, value) {
  const typeMatches = property.type === "string"
    ? typeof value === "string"
    : property.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : property.type === "integer"
        ? Number.isInteger(value)
        : property.type === "boolean"
          ? typeof value === "boolean"
          : Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!typeMatches) {
    throw contractError("invalid_acpx_question_fixture", `native response type for ${name}`);
  }
  const enumValues = property.type === "array"
    ? acpxEnumValues(property.items, "anyOf")
    : property.type === "string"
      ? acpxEnumValues(property, "oneOf")
      : [];
  const responseValues = Array.isArray(value) ? value : [value];
  if (enumValues.length > 0 && responseValues.some((item) => !enumValues.includes(item))) {
    throw contractError("invalid_acpx_question_fixture", `native response option for ${name}`);
  }
}

function acpxEnumValues(property, preferredTitledKey) {
  if (!isPlainRecord(property)) return [];
  const alternateTitledKey = preferredTitledKey === "anyOf" ? "oneOf" : "anyOf";
  const titled = property[preferredTitledKey]
    ?? property[alternateTitledKey];
  const values = Array.isArray(titled)
    ? titled.map((entry) => isPlainRecord(entry) ? entry.const : undefined)
    : Array.isArray(property.enum)
      ? property.enum
      : [];
  if (
    !Array.isArray(values)
    || values.length > 128
    || values.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw contractError("invalid_acpx_question_fixture", "native options must be non-empty bounded strings");
  }
  return values;
}

function isPlainRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
