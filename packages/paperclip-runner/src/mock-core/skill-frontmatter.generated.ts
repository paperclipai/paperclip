// @ts-nocheck -- generated parser and standalone schema validator.

// Generated from packages/shared/src/frontmatter.ts. Do not edit by hand.

// Regenerate: node packages/shared/scripts/generate-runner-skill-frontmatter.ts

export interface MarkdownDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  }

  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  }

  const frontmatterRaw = normalized.slice(4, closing);
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
    hasFrontmatter: true,
  };
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  const firstContentIndex = prepared.findIndex((line) => !line.isBlank && !line.isComment);
  if (firstContentIndex < 0) return {};
  const parsed = parseYamlBlock(prepared, firstContentIndex, prepared[firstContentIndex]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      raw: line,
      content: line.trim(),
      isBlank: line.trim().length === 0,
      isComment: line.trim().startsWith("#"),
    }));
}

function parseYamlBlock(
  lines: Array<{ indent: number; raw: string; content: string; isBlank: boolean; isComment: boolean }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && (lines[index]!.isBlank || lines[index]!.isComment)) {
    index += 1;
  }
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.isBlank || line.isComment) {
        index += 1;
        continue;
      }
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;

      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }

      if (isYamlBlockScalarIndicator(remainder)) {
        const block = parseYamlBlockScalar(lines, index, indentLevel, remainder);
        values.push(block.value);
        index = block.nextIndex;
        continue;
      }

      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0
        && !remainder.startsWith("\"")
        && !remainder.startsWith("{")
        && !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }

      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.isBlank || line.isComment) {
      index += 1;
      continue;
    }
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }

    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }

    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    if (isYamlBlockScalarIndicator(remainder)) {
      const block = parseYamlBlockScalar(lines, index, indentLevel, remainder);
      record[key] = block.value;
      index = block.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }

  return { value: record, nextIndex: index };
}

function isYamlBlockScalarIndicator(rawValue: string) {
  return /^[>|][+-]?$/.test(rawValue.trim());
}

function parseYamlBlockScalar(
  lines: Array<{ indent: number; raw: string; content: string; isBlank: boolean; isComment: boolean }>,
  startIndex: number,
  parentIndent: number,
  indicator: string,
): { value: string; nextIndex: number } {
  const trimmedIndicator = indicator.trim();
  const style = trimmedIndicator[0];
  const chomp = trimmedIndicator.endsWith("+")
    ? "+"
    : trimmedIndicator.endsWith("-")
      ? "-"
      : "";
  let index = startIndex;
  const collected: Array<{ indent: number; raw: string; isBlank: boolean }> = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.isBlank && line.indent <= parentIndent) break;
    collected.push({ indent: line.indent, raw: line.raw, isBlank: line.isBlank });
    index += 1;
  }

  const contentLines = collected.filter((line) => !line.isBlank);
  if (contentLines.length === 0) return { value: "", nextIndex: index };

  const blockIndent = Math.min(...contentLines.map((line) => line.indent));
  const normalizedLines = collected.map((line) => (
    line.isBlank ? "" : line.raw.slice(Math.min(blockIndent, line.raw.length))
  ));

  const baseValue = style === "|"
    ? normalizedLines.join("\n")
    : foldYamlBlockScalarLines(normalizedLines);

  return {
    value: applyYamlBlockChomp(baseValue, chomp),
    nextIndex: index,
  };
}

function foldYamlBlockScalarLines(lines: string[]) {
  let value = "";
  let pendingBlankLines = 0;
  for (const line of lines) {
    if (line === "") {
      pendingBlankLines += 1;
      continue;
    }
    if (value.length === 0) {
      value = `${"\n".repeat(pendingBlankLines)}${line}`;
    } else if (pendingBlankLines > 0) {
      value += `${"\n".repeat(pendingBlankLines + 1)}${line}`;
    } else {
      value += ` ${line}`;
    }
    pendingBlankLines = 0;
  }

  if (pendingBlankLines > 0 && value.length > 0) {
    value += "\n".repeat(pendingBlankLines);
  }
  return value;
}

function applyYamlBlockChomp(value: string, chomp: "" | "+" | "-") {
  if (chomp === "+") return value;
  if (chomp === "-") return value.replace(/\n+$/u, "");
  if (value.length === 0) return value;
  return value.replace(/\n+$/u, "") + "\n";
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

"use strict";
export const validateSkillFrontmatter = validate10;
const schema11 = {"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"name":{"type":"string","pattern":"^[a-z0-9]+(?:-[a-z0-9]+)*$"},"description":{"type":"string","minLength":1},"allowed-tools":{"type":"array","items":{"type":"string"}},"metadata":{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}},"required":["name","description"],"additionalProperties":{},"definitions":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]}}};
const pattern0 = new RegExp("^[a-z0-9]+(?:-[a-z0-9]+)*$", "u");
const func2 = ((value: string) => [...value].length);
const schema12 = {"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]};
const wrapper0 = {validate: validate11};

function validate11(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
const _errs0 = errors;
let valid0 = false;
const _errs1 = errors;
if(typeof data !== "string"){
const err0 = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs1 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs3 = errors;
if(!(typeof data == "number")){
const err1 = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "number"},message:"must be number"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
}
var _valid0 = _errs3 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs5 = errors;
if(typeof data !== "boolean"){
const err2 = {instancePath,schemaPath:"#/anyOf/2/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var _valid0 = _errs5 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs7 = errors;
if(data !== null){
const err3 = {instancePath,schemaPath:"#/anyOf/3/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var _valid0 = _errs7 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs9 = errors;
if(errors === _errs9){
if(Array.isArray(data)){
var valid1 = true;
const len0 = data.length;
for(let i0=0; i0<len0; i0++){
const _errs11 = errors;
if(!(wrapper0.validate(data[i0], {instancePath:instancePath+"/" + i0,parentData:data,parentDataProperty:i0,rootData}))){
vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);
errors = vErrors.length;
}
var valid1 = _errs11 === errors;
if(!valid1){
break;
}
}
}
else {
const err4 = {instancePath,schemaPath:"#/anyOf/4/type",keyword:"type",params:{type: "array"},message:"must be array"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
var _valid0 = _errs9 === errors;
valid0 = valid0 || _valid0;
if(!valid0){
const _errs12 = errors;
if(errors === _errs12){
if(data && typeof data == "object" && !Array.isArray(data)){
for(const key0 in data){
const _errs14 = errors;
if(typeof key0 !== "string"){
const err5 = {instancePath,schemaPath:"#/anyOf/5/propertyNames/type",keyword:"type",params:{type: "string"},message:"must be string",propertyName:key0};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid2 = _errs14 === errors;
if(!valid2){
const err6 = {instancePath,schemaPath:"#/anyOf/5/propertyNames",keyword:"propertyNames",params:{propertyName: key0},message:"property name must be valid"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
break;
}
}
if(valid2){
for(const key1 in data){
const _errs17 = errors;
if(!(wrapper0.validate(data[key1], {instancePath:instancePath+"/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"),parentData:data,parentDataProperty:key1,rootData}))){
vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);
errors = vErrors.length;
}
var valid3 = _errs17 === errors;
if(!valid3){
break;
}
}
}
}
else {
const err7 = {instancePath,schemaPath:"#/anyOf/5/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
var _valid0 = _errs12 === errors;
valid0 = valid0 || _valid0;
}
}
}
}
}
if(!valid0){
const err8 = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
validate11.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate11.errors = vErrors;
return errors === 0;
}


function validate10(data, {instancePath="", parentData, parentDataProperty, rootData=data}={}){
let vErrors = null;
let errors = 0;
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.name === undefined) && (missing0 = "name")) || ((data.description === undefined) && (missing0 = "description"))){
validate10.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
if(data.name !== undefined){
let data0 = data.name;
const _errs2 = errors;
if(errors === _errs2){
if(typeof data0 === "string"){
if(!pattern0.test(data0)){
validate10.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$"},message:"must match pattern \""+"^[a-z0-9]+(?:-[a-z0-9]+)*$"+"\""}];
return false;
}
}
else {
validate10.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.description !== undefined){
let data1 = data.description;
const _errs4 = errors;
if(errors === _errs4){
if(typeof data1 === "string"){
if(func2(data1) < 1){
validate10.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1},message:"must NOT have fewer than 1 characters"}];
return false;
}
}
else {
validate10.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data["allowed-tools"] !== undefined){
let data2 = data["allowed-tools"];
const _errs6 = errors;
if(errors === _errs6){
if(Array.isArray(data2)){
var valid1 = true;
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
const _errs8 = errors;
if(typeof data2[i0] !== "string"){
validate10.errors = [{instancePath:instancePath+"/allowed-tools/" + i0,schemaPath:"#/properties/allowed-tools/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid1 = _errs8 === errors;
if(!valid1){
break;
}
}
}
else {
validate10.errors = [{instancePath:instancePath+"/allowed-tools",schemaPath:"#/properties/allowed-tools/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.metadata !== undefined){
let data4 = data.metadata;
const _errs10 = errors;
if(errors === _errs10){
if(data4 && typeof data4 == "object" && !Array.isArray(data4)){
for(const key0 in data4){
const _errs12 = errors;
if(typeof key0 !== "string"){
const err0 = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames/type",keyword:"type",params:{type: "string"},message:"must be string",propertyName:key0};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var valid2 = _errs12 === errors;
if(!valid2){
const err1 = {instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/propertyNames",keyword:"propertyNames",params:{propertyName: key0},message:"property name must be valid"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate10.errors = vErrors;
return false;
break;
}
}
if(valid2){
for(const key1 in data4){
const _errs15 = errors;
if(!(validate11(data4[key1], {instancePath:instancePath+"/metadata/" + key1.replace(/~/g, "~0").replace(/\//g, "~1"),parentData:data4,parentDataProperty:key1,rootData}))){
vErrors = vErrors === null ? validate11.errors : vErrors.concat(validate11.errors);
errors = vErrors.length;
}
var valid3 = _errs15 === errors;
if(!valid3){
break;
}
}
}
}
else {
validate10.errors = [{instancePath:instancePath+"/metadata",schemaPath:"#/properties/metadata/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate10.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate10.errors = vErrors;
return errors === 0;
}

