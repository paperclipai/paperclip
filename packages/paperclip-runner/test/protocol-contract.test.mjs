import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildProtocolManifest } from "../scripts/generate-protocol-manifest.mjs";
import {
  assertAcpxQuestionFixture,
  assertCodexQuestionFixture,
  assertConformanceFixturePair,
  assertQuestionAdapterFixture,
  assertReplayFixtureCompatibility,
  assertSchemaInstance,
  compileProtocolValidators,
  loadSchemaCatalog,
  readJson,
} from "../scripts/protocol-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolRoot = resolve(packageRoot, "protocol");

async function fixture(relativePath) {
  return (await readJson(resolve(protocolRoot, "fixtures", relativePath))).value;
}

test("all schema IDs are unique and all external references resolve", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  assert.equal(schemas.length, 21);
  assert.doesNotThrow(() => compileProtocolValidators(schemas));
});

test("the generated manifest matches all checked-in schemas and fixtures", async () => {
  const expected = `${JSON.stringify(await buildProtocolManifest(), null, 2)}\n`;
  const actual = await readFile(resolve(protocolRoot, "manifest.json"), "utf8");
  assert.equal(actual, expected);
});

test("canonical replay fixtures use supported required versions", async () => {
  for (const name of [
    "duplicate-event.json",
    "failed-run.json",
    "happy-path.json",
    "interrupted-run.json",
    "source-gap.json",
  ]) {
    assert.equal(assertReplayFixtureCompatibility(await fixture(`replay/${name}`)).protocolVersion, 1);
  }
});

test("unknown additive fields remain compatible with PRP v1", async () => {
  const value = await fixture("replay/unknown-optional-fields.json");
  assert.equal(value.futureFixtureHint.producerVersion, "1.1-preview");
  assert.doesNotThrow(() => assertReplayFixtureCompatibility(value));
});

test("unknown required versions and schemas fail closed", async () => {
  const unsupported = await fixture("replay/unsupported-required-version.json");
  assert.throws(
    () => assertReplayFixtureCompatibility(unsupported),
    /unsupported_required_version: protocolVersion=2; supported=1/,
  );

  const eventVersion = structuredClone(await fixture("replay/happy-path.json"));
  eventVersion.events[0].schemaVersion = 2;
  assert.throws(() => assertReplayFixtureCompatibility(eventVersion), /unsupported_required_version/);

  const commandSchema = structuredClone(await fixture("replay/happy-path.json"));
  commandSchema.commands[0].schema = "paperclip.prp.command.v2";
  assert.throws(() => assertReplayFixtureCompatibility(commandSchema), /unsupported_required_schema/);
});

test("accepted fixtures satisfy the complete JSON Schemas", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  const happyPath = await fixture("replay/happy-path.json");
  assert.doesNotThrow(() => assertSchemaInstance(validators.fixture, happyPath, "happy-path"));

  const missingRequiredField = structuredClone(happyPath);
  delete missingRequiredField.commands[0].commandId;
  assert.throws(
    () => assertSchemaInstance(validators.fixture, missingRequiredField, "missing-command-id"),
    /schema_validation_failed: missing-command-id must be accepted: \/commands\/0 must have required property 'commandId'/,
  );

  const unsupported = await fixture("replay/unsupported-required-version.json");
  assert.doesNotThrow(() => assertSchemaInstance(validators.fixture, unsupported, "required-v2", false));
});

test("provider descriptors require coherent provider, driver, and execution combinations", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  const codex = {
    provider: "codex",
    driver: "codex_app_server",
    model: "gpt-5.3-codex",
    executionKind: "local_process",
    providerVersion: "1",
  };
  assert.doesNotThrow(() => assertSchemaInstance(validators.providerDescriptor, codex, "codex-provider"));
  assert.throws(
    () => assertSchemaInstance(
      validators.providerDescriptor,
      { ...codex, driver: "opencode_server" },
      "mismatched-provider",
    ),
    /schema_validation_failed: mismatched-provider must be accepted/,
  );
});

test("the Codex question fixture uses stable provider-neutral IDs", async () => {
  const value = await fixture("questions/codex.json");
  assert.doesNotThrow(() => assertCodexQuestionFixture(value));
  assert.deepEqual(Object.keys(value.canonicalResponse.answers), ["environment"]);
});

test("the ACPX question fixture enforces its provider-native contract", async () => {
  const canonical = await fixture("questions/acpx.json");
  assert.doesNotThrow(() => assertAcpxQuestionFixture(canonical));

  const implicitObjectSchema = structuredClone(canonical);
  delete implicitObjectSchema.nativeRequest.params.requestedSchema.type;
  assert.doesNotThrow(() => assertAcpxQuestionFixture(implicitObjectSchema));

  const unionObjectSchema = structuredClone(canonical);
  unionObjectSchema.nativeRequest.params.requestedSchema.type = ["object", "null"];
  assert.doesNotThrow(() => assertAcpxQuestionFixture(unionObjectSchema));

  const malformedRequest = structuredClone(canonical);
  malformedRequest.nativeRequest.params.requestedSchema.properties.environment.type = "object";
  assert.throws(
    () => assertAcpxQuestionFixture(malformedRequest),
    /unsupported native property environment/,
  );

  const malformedResponse = structuredClone(canonical);
  malformedResponse.nativeResponse.content.environment = "unknown";
  assert.throws(
    () => assertAcpxQuestionFixture(malformedResponse),
    /native response option for environment/,
  );

  const patternBearingQuestion = structuredClone(canonical);
  const patternBearingProperty = patternBearingQuestion.nativeRequest.params
    .requestedSchema.properties.environment;
  delete patternBearingProperty.oneOf;
  patternBearingProperty.pattern = "^staging$";
  patternBearingQuestion.canonicalQuestionSet.questions[0] = {
    id: "field-1-environment-ba5285161ba6",
    header: "Environment",
    prompt: "Where should we deploy?",
    required: true,
    answerMode: "text",
    textValidation: { inputType: "text", pattern: "^staging$" },
  };
  patternBearingQuestion.canonicalResponse.answers = {
    "field-1-environment-ba5285161ba6": { text: "staging" },
  };
  assert.throws(
    () => assertAcpxQuestionFixture(patternBearingQuestion),
    /native property environment uses an unsupported pattern/,
  );

  const optionPattern = structuredClone(canonical);
  optionPattern.nativeRequest.params.requestedSchema.properties.environment
    .pattern = "^staging$";
  assert.doesNotThrow(() => assertAcpxQuestionFixture(optionPattern));

  const emptyOptionalAnswer = structuredClone(canonical);
  emptyOptionalAnswer.nativeRequest.params.requestedSchema.required = [];
  emptyOptionalAnswer.nativeResponse.content = {};
  emptyOptionalAnswer.canonicalQuestionSet.questions[0] = {
    ...emptyOptionalAnswer.canonicalQuestionSet.questions[0],
    required: false,
  };
  emptyOptionalAnswer.canonicalResponse.answers = {
    [emptyOptionalAnswer.canonicalQuestionSet.questions[0].id]: {},
  };
  assert.doesNotThrow(() => assertAcpxQuestionFixture(emptyOptionalAnswer));

  const emptyOption = structuredClone(canonical);
  emptyOption.nativeRequest.params.requestedSchema.properties.environment
    .oneOf[0].const = "";
  assert.throws(
    () => assertAcpxQuestionFixture(emptyOption),
    /native options must be non-empty bounded strings/,
  );

  const missingResponse = structuredClone(canonical);
  missingResponse.nativeResponse.content = {};
  assert.throws(
    () => assertAcpxQuestionFixture(missingResponse),
    /native response omits required property environment/,
  );

  const divergentQuestion = structuredClone(canonical);
  divergentQuestion.nativeRequest.params.requestedSchema.required = [];
  assert.throws(
    () => assertAcpxQuestionFixture(divergentQuestion),
    /native and canonical question sets differ/,
  );

  const normalizedRequired = structuredClone(canonical);
  normalizedRequired.nativeRequest.params.requestedSchema.required = [
    "environment",
    "environment",
    42,
    "not-a-property",
  ];
  assert.doesNotThrow(() => assertAcpxQuestionFixture(normalizedRequired));

  const manyUnknownRequired = structuredClone(canonical);
  manyUnknownRequired.nativeRequest.params.requestedSchema.required = [
    ...Array.from({ length: 80 }, (_, index) => `unknown-${index}`),
    "environment",
  ];
  assert.doesNotThrow(() => assertAcpxQuestionFixture(manyUnknownRequired));

  const divergentResponse = structuredClone(canonical);
  divergentResponse.nativeResponse.content.environment = "production";
  assert.throws(
    () => assertAcpxQuestionFixture(divergentResponse),
    /canonical and native responses differ/,
  );

  const arrayWithBothOptionForms = structuredClone(canonical);
  const environment = arrayWithBothOptionForms.nativeRequest.params
    .requestedSchema.properties.environment;
  environment.type = "array";
  environment.items = {
    anyOf: environment.oneOf,
    oneOf: [{ const: "wrong", title: "Wrong precedence" }],
  };
  delete environment.oneOf;
  arrayWithBothOptionForms.canonicalQuestionSet.questions[0].answerMode = "multi_select";
  arrayWithBothOptionForms.nativeResponse.content.environment = ["staging"];
  assert.doesNotThrow(() => assertAcpxQuestionFixture(arrayWithBothOptionForms));

  const malformedPreferredUnion = structuredClone(arrayWithBothOptionForms);
  malformedPreferredUnion.nativeRequest.params.requestedSchema.properties
    .environment.items.anyOf = { const: "staging" };
  assert.throws(
    () => assertAcpxQuestionFixture(malformedPreferredUnion),
    /native array property environment requires options/,
  );

  const enumFallback = structuredClone(malformedPreferredUnion);
  enumFallback.nativeRequest.params.requestedSchema.properties.environment.items = {
    anyOf: { const: "ignored-malformed-preferred-union" },
    oneOf: [{ const: "wrong", title: "Wrong alternate union" }],
    enum: ["staging", "production"],
  };
  enumFallback.canonicalQuestionSet.questions[0].options = [
    { id: "option-1", label: "staging" },
    { id: "option-2", label: "production" },
  ];
  assert.doesNotThrow(() => assertAcpxQuestionFixture(enumFallback));

  const specialPropertyName = "__proto__";
  const specialProperty = structuredClone(
    canonical.nativeRequest.params.requestedSchema.properties.environment,
  );
  const specialPropertyFixture = structuredClone(canonical);
  const specialProperties = specialPropertyFixture.nativeRequest.params
    .requestedSchema.properties;
  delete specialProperties.environment;
  Object.defineProperty(specialProperties, specialPropertyName, {
    value: specialProperty,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  specialPropertyFixture.nativeRequest.params.requestedSchema.required = [
    specialPropertyName,
  ];
  const specialQuestionId = `field-1-__proto__-${createHash("sha256")
    .update(specialPropertyName)
    .digest("hex")
    .slice(0, 12)}`;
  specialPropertyFixture.canonicalQuestionSet.questions[0].id = specialQuestionId;
  specialPropertyFixture.canonicalResponse.answers = {
    [specialQuestionId]: { selectedOptionIds: ["option-1"] },
  };
  specialPropertyFixture.nativeResponse.content = {};
  Object.defineProperty(
    specialPropertyFixture.nativeResponse.content,
    specialPropertyName,
    {
      value: "staging",
      enumerable: true,
      configurable: true,
      writable: true,
    },
  );
  assert.doesNotThrow(() => assertAcpxQuestionFixture(specialPropertyFixture));
});

test("the ACPX question fixture ignores scalar enums the adapter does not project", async () => {
  const base = await fixture("questions/acpx.json");
  const id = "field-1-environment-ba5285161ba6";
  const cases = [
    {
      type: "boolean",
      property: { type: "boolean", title: "Confirm", enum: [true] },
      question: {
        id,
        header: "Confirm",
        prompt: "Confirm",
        required: true,
        answerMode: "single_select",
        options: [
          { id: "option-1", label: "Yes" },
          { id: "option-2", label: "No" },
        ],
      },
      canonicalAnswer: { selectedOptionIds: ["option-2"] },
      nativeAnswer: false,
    },
    {
      type: "number",
      property: { type: "number", title: "Threshold", enum: [1.5] },
      question: {
        id,
        header: "Threshold",
        prompt: "Threshold",
        required: true,
        answerMode: "text",
        textValidation: { inputType: "number" },
      },
      canonicalAnswer: { text: "2.5" },
      nativeAnswer: 2.5,
    },
    {
      type: "integer",
      property: { type: "integer", title: "Replicas", enum: [1] },
      question: {
        id,
        header: "Replicas",
        prompt: "Replicas",
        required: true,
        answerMode: "text",
        textValidation: { inputType: "integer" },
      },
      canonicalAnswer: { text: "2" },
      nativeAnswer: 2,
    },
  ];

  for (const testCase of cases) {
    const value = structuredClone(base);
    value.nativeRequest.params.requestedSchema.properties.environment = testCase.property;
    value.canonicalQuestionSet.questions[0] = testCase.question;
    value.canonicalResponse.answers[id] = testCase.canonicalAnswer;
    value.nativeResponse.content.environment = testCase.nativeAnswer;
    assert.doesNotThrow(
      () => assertAcpxQuestionFixture(value),
      `${testCase.type} enum must not constrain the adapter's projected scalar answer`,
    );
  }

  const invalidNativeType = structuredClone(base);
  invalidNativeType.nativeRequest.params.requestedSchema.properties.environment =
    cases[0].property;
  invalidNativeType.canonicalQuestionSet.questions[0] = cases[0].question;
  invalidNativeType.canonicalResponse.answers[id] = cases[0].canonicalAnswer;
  invalidNativeType.nativeResponse.content.environment = "false";
  assert.throws(
    () => assertAcpxQuestionFixture(invalidNativeType),
    /native response type for environment/,
  );
});

test("every question adapter fixture satisfies its declared schema", async () => {
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  for (const adapter of ["codex", "acpx"]) {
    const value = await fixture(`questions/${adapter}.json`);
    assert.doesNotThrow(() =>
      assertSchemaInstance(
        validators.questionAdapterFixture,
        value,
        `${adapter}-question-fixture`,
      ),
    );
    assert.doesNotThrow(() => assertQuestionAdapterFixture(value));
  }

  const malformed = structuredClone(await fixture("questions/acpx.json"));
  delete malformed.canonicalQuestionSet.schema;
  assert.throws(
    () =>
      assertSchemaInstance(
        validators.questionAdapterFixture,
        malformed,
        "malformed-acpx-question-fixture",
      ),
    /schema_validation_failed/,
  );

  const unknownQuestion = structuredClone(await fixture("questions/acpx.json"));
  unknownQuestion.canonicalResponse.answers = {
    "unknown-question": { selectedOptionIds: ["option-1"] },
  };
  assert.throws(
    () => assertQuestionAdapterFixture(unknownQuestion),
    /answer has unknown question ID unknown-question/,
  );

  const unknownOption = structuredClone(await fixture("questions/acpx.json"));
  const [questionId] = Object.keys(unknownOption.canonicalResponse.answers);
  unknownOption.canonicalResponse.answers[questionId].selectedOptionIds = [
    "unknown-option",
  ];
  assert.throws(
    () => assertQuestionAdapterFixture(unknownOption),
    /answer has unknown option ID unknown-option/,
  );

  const canonical = await fixture("questions/acpx.json");
  const [requiredQuestion] = canonical.canonicalQuestionSet.questions;
  const requiredQuestionId = requiredQuestion.id;
  const malformedAnswers = [
    {
      label: "missing required answer",
      answer: undefined,
      pattern: /required question .* is missing/,
    },
    {
      label: "empty required answer",
      answer: {},
      pattern: /required question .* is empty/,
    },
    {
      label: "multiple single-select values",
      answer: { selectedOptionIds: requiredQuestion.options.map((option) => option.id) },
      pattern: /single-select answer .* chooses more than one option/,
    },
    {
      label: "text on a select question",
      answer: { text: "staging" },
      pattern: /select answer .* carries text/,
    },
    {
      label: "disabled custom answer",
      answer: { customText: "canary" },
      pattern: /custom answer .* is not enabled/,
    },
  ];
  for (const malformedAnswer of malformedAnswers) {
    const malformedResponse = structuredClone(canonical);
    malformedResponse.canonicalResponse.answers = malformedAnswer.answer === undefined
      ? {}
      : { [requiredQuestionId]: malformedAnswer.answer };
    assert.throws(
      () => assertQuestionAdapterFixture(malformedResponse),
      malformedAnswer.pattern,
      malformedAnswer.label,
    );
  }

  const emptyOptionalAnswer = structuredClone(canonical);
  emptyOptionalAnswer.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    required: false,
  };
  emptyOptionalAnswer.canonicalResponse.answers = {
    [requiredQuestionId]: {},
  };
  assert.doesNotThrow(() => assertQuestionAdapterFixture(emptyOptionalAnswer));

  const textModeMismatch = structuredClone(canonical);
  textModeMismatch.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    answerMode: "text",
    options: [],
  };
  textModeMismatch.canonicalResponse.answers[requiredQuestionId] = {
    customText: "select-only custom value",
  };
  assert.throws(
    () => assertQuestionAdapterFixture(textModeMismatch),
    /text answer .* carries select-only fields/,
  );

  const invalidTextAnswers = [
    {
      label: "minimum text length",
      validation: { minLength: 4 },
      text: "abc",
      pattern: /must contain at least 4 characters/,
    },
    {
      label: "maximum text length",
      validation: { maxLength: 2 },
      text: "abc",
      pattern: /must contain at most 2 characters/,
    },
    {
      label: "text pattern",
      validation: { pattern: "^z+$" },
      text: "abc",
      pattern: /does not match the required format/,
    },
    {
      label: "numeric input",
      validation: { inputType: "number" },
      text: "not-a-number",
      pattern: /must be a valid number/,
    },
    {
      label: "integer input",
      validation: { inputType: "integer" },
      text: "1.5",
      pattern: /must be a valid integer/,
    },
    {
      label: "numeric minimum",
      validation: { inputType: "number", minimum: 2 },
      text: "1",
      pattern: /must be at least 2/,
    },
    {
      label: "numeric maximum",
      validation: { inputType: "number", maximum: 2 },
      text: "3",
      pattern: /must be at most 2/,
    },
  ];
  for (const invalid of invalidTextAnswers) {
    const malformedResponse = structuredClone(canonical);
    malformedResponse.canonicalQuestionSet.questions[0] = {
      ...requiredQuestion,
      answerMode: "text",
      options: [],
      textValidation: invalid.validation,
    };
    malformedResponse.canonicalResponse.answers[requiredQuestionId] = {
      text: invalid.text,
    };
    assert.throws(
      () => assertQuestionAdapterFixture(malformedResponse),
      invalid.pattern,
      invalid.label,
    );
  }

  const invalidCustomText = structuredClone(canonical);
  invalidCustomText.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    customAnswer: { enabled: true },
    textValidation: { minLength: 2, inputType: "text" },
  };
  invalidCustomText.canonicalResponse.answers[requiredQuestionId] = {
    customText: "x",
  };
  assert.throws(
    () => assertQuestionAdapterFixture(invalidCustomText),
    /must contain at least 2 characters/,
    "select custom text validation",
  );

  for (const invalid of [
    {
      label: "contradictory optional text lengths",
      validation: { minLength: 3, maxLength: 2 },
      pattern: /minLength greater than maxLength/,
    },
    {
      label: "contradictory optional numeric bounds",
      validation: { inputType: "number", minimum: 3, maximum: 2 },
      pattern: /minimum greater than maximum/,
    },
  ]) {
    const malformedQuestion = structuredClone(canonical);
    malformedQuestion.canonicalQuestionSet.questions[0] = {
      ...requiredQuestion,
      required: false,
      answerMode: "text",
      options: [],
      textValidation: invalid.validation,
    };
    malformedQuestion.canonicalResponse.answers = {};
    assert.throws(
      () => assertQuestionAdapterFixture(malformedQuestion),
      invalid.pattern,
      invalid.label,
    );
  }

  const pathologicalPattern = structuredClone(canonical);
  pathologicalPattern.canonicalQuestionSet.questions[0] = {
    ...requiredQuestion,
    answerMode: "text",
    options: [],
    textValidation: { pattern: "(a+)+$" },
  };
  pathologicalPattern.canonicalResponse.answers[requiredQuestionId] = {
    text: `${"a".repeat(100_000)}!`,
  };
  assert.throws(
    () => assertQuestionAdapterFixture(pathologicalPattern),
    /could not be evaluated safely/,
  );
});

test("the cross-language conformance input and output have one stable identity", async () => {
  const input = await fixture("conformance-minimal-run.json");
  const output = await fixture("conformance-expected-output.json");
  const schemas = await loadSchemaCatalog(resolve(protocolRoot, "schemas"));
  const validators = compileProtocolValidators(schemas);
  assert.doesNotThrow(() => assertSchemaInstance(validators.conformanceFixture, input, "conformance-input"));
  assert.doesNotThrow(() => assertSchemaInstance(validators.conformanceOutput, output, "conformance-output"));
  assert.doesNotThrow(() => assertConformanceFixturePair(input, output));
  assert.equal(input.result.summary, output.result.summary);

  const missingSessionId = structuredClone(output);
  delete missingSessionId.runIdentity.sessionId;
  assert.throws(
    () => assertSchemaInstance(validators.conformanceOutput, missingSessionId, "missing-session-id"),
    /schema_validation_failed: missing-session-id must be accepted: \/runIdentity must have required property 'sessionId'/,
  );
});
