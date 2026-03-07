"use strict";
/**
 * Agent Packaging Module
 *
 * Exports all packaging-related functionality.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.packageAgent = exports.getPackageSummary = exports.DEFAULT_CLINE_CONFIG = exports.DEFAULT_GOOSE_CONFIG = exports.DEFAULT_CLAWDBOT_SETTINGS = exports.deleteAgentConfig = exports.listAgents = exports.readAgentConfig = exports.writeAgentConfig = exports.getConfigPath = exports.findGenericConfigs = exports.parseGenericConfig = exports.findClineConfigs = exports.parseClineConfig = exports.findGooseConfigs = exports.parseGooseConfig = exports.findClawdbotConfigs = exports.parseClawdbotConfig = exports.validateState = exports.mergeStates = exports.createEmptyState = exports.readStateFile = exports.writeStateFile = exports.deserializeState = exports.serializeState = exports.DEFAULT_WASMEDGE_OPTIONS = exports.generateWasmEdgeManifest = exports.generateWasmEdgeConfig = exports.validateWasmEdgeModule = exports.generateWasmEdgeWrapper = exports.validateWasmFile = exports.generateStateJson = exports.generateWat = exports.generateWasm = exports.compileToWasm = exports.validateSourcePath = exports.detectAgentType = exports.detectAgent = void 0;
// Detection
var detector_js_1 = require("./detector.js");
Object.defineProperty(exports, "detectAgent", { enumerable: true, get: function () { return detector_js_1.detectAgent; } });
Object.defineProperty(exports, "detectAgentType", { enumerable: true, get: function () { return detector_js_1.detectAgentType; } });
Object.defineProperty(exports, "validateSourcePath", { enumerable: true, get: function () { return detector_js_1.validateSourcePath; } });
// Compilation
var compiler_js_1 = require("./compiler.js");
Object.defineProperty(exports, "compileToWasm", { enumerable: true, get: function () { return compiler_js_1.compileToWasm; } });
Object.defineProperty(exports, "generateWasm", { enumerable: true, get: function () { return compiler_js_1.generateWasm; } });
Object.defineProperty(exports, "generateWat", { enumerable: true, get: function () { return compiler_js_1.generateWat; } });
Object.defineProperty(exports, "generateStateJson", { enumerable: true, get: function () { return compiler_js_1.generateStateJson; } });
Object.defineProperty(exports, "validateWasmFile", { enumerable: true, get: function () { return compiler_js_1.validateWasmFile; } });
// WasmEdge Compiler
var wasmedge_compiler_js_1 = require("./wasmedge-compiler.js");
Object.defineProperty(exports, "generateWasmEdgeWrapper", { enumerable: true, get: function () { return wasmedge_compiler_js_1.generateWasmEdgeWrapper; } });
Object.defineProperty(exports, "validateWasmEdgeModule", { enumerable: true, get: function () { return wasmedge_compiler_js_1.validateWasmEdgeModule; } });
Object.defineProperty(exports, "generateWasmEdgeConfig", { enumerable: true, get: function () { return wasmedge_compiler_js_1.generateWasmEdgeConfig; } });
Object.defineProperty(exports, "generateWasmEdgeManifest", { enumerable: true, get: function () { return wasmedge_compiler_js_1.generateWasmEdgeManifest; } });
Object.defineProperty(exports, "DEFAULT_WASMEDGE_OPTIONS", { enumerable: true, get: function () { return wasmedge_compiler_js_1.DEFAULT_WASMEDGE_OPTIONS; } });
// Serialization
var serializer_js_1 = require("./serializer.js");
Object.defineProperty(exports, "serializeState", { enumerable: true, get: function () { return serializer_js_1.serializeState; } });
Object.defineProperty(exports, "deserializeState", { enumerable: true, get: function () { return serializer_js_1.deserializeState; } });
Object.defineProperty(exports, "writeStateFile", { enumerable: true, get: function () { return serializer_js_1.writeStateFile; } });
Object.defineProperty(exports, "readStateFile", { enumerable: true, get: function () { return serializer_js_1.readStateFile; } });
Object.defineProperty(exports, "createEmptyState", { enumerable: true, get: function () { return serializer_js_1.createEmptyState; } });
Object.defineProperty(exports, "mergeStates", { enumerable: true, get: function () { return serializer_js_1.mergeStates; } });
Object.defineProperty(exports, "validateState", { enumerable: true, get: function () { return serializer_js_1.validateState; } });
// Parsers
var index_js_1 = require("./parsers/index.js");
Object.defineProperty(exports, "parseClawdbotConfig", { enumerable: true, get: function () { return index_js_1.parseClawdbotConfig; } });
Object.defineProperty(exports, "findClawdbotConfigs", { enumerable: true, get: function () { return index_js_1.findClawdbotConfigs; } });
Object.defineProperty(exports, "parseGooseConfig", { enumerable: true, get: function () { return index_js_1.parseGooseConfig; } });
Object.defineProperty(exports, "findGooseConfigs", { enumerable: true, get: function () { return index_js_1.findGooseConfigs; } });
Object.defineProperty(exports, "parseClineConfig", { enumerable: true, get: function () { return index_js_1.parseClineConfig; } });
Object.defineProperty(exports, "findClineConfigs", { enumerable: true, get: function () { return index_js_1.findClineConfigs; } });
Object.defineProperty(exports, "parseGenericConfig", { enumerable: true, get: function () { return index_js_1.parseGenericConfig; } });
Object.defineProperty(exports, "findGenericConfigs", { enumerable: true, get: function () { return index_js_1.findGenericConfigs; } });
// Config Persistence
var config_persistence_js_1 = require("./config-persistence.js");
Object.defineProperty(exports, "getConfigPath", { enumerable: true, get: function () { return config_persistence_js_1.getConfigPath; } });
Object.defineProperty(exports, "writeAgentConfig", { enumerable: true, get: function () { return config_persistence_js_1.writeAgentConfig; } });
Object.defineProperty(exports, "readAgentConfig", { enumerable: true, get: function () { return config_persistence_js_1.readAgentConfig; } });
Object.defineProperty(exports, "listAgents", { enumerable: true, get: function () { return config_persistence_js_1.listAgents; } });
Object.defineProperty(exports, "deleteAgentConfig", { enumerable: true, get: function () { return config_persistence_js_1.deleteAgentConfig; } });
// Config Schemas
var config_schemas_js_1 = require("./config-schemas.js");
Object.defineProperty(exports, "DEFAULT_CLAWDBOT_SETTINGS", { enumerable: true, get: function () { return config_schemas_js_1.DEFAULT_CLAWDBOT_SETTINGS; } });
Object.defineProperty(exports, "DEFAULT_GOOSE_CONFIG", { enumerable: true, get: function () { return config_schemas_js_1.DEFAULT_GOOSE_CONFIG; } });
Object.defineProperty(exports, "DEFAULT_CLINE_CONFIG", { enumerable: true, get: function () { return config_schemas_js_1.DEFAULT_CLINE_CONFIG; } });
// Summary - used by package command
var packager_js_1 = require("./packager.js");
Object.defineProperty(exports, "getPackageSummary", { enumerable: true, get: function () { return packager_js_1.getPackageSummary; } });
Object.defineProperty(exports, "packageAgent", { enumerable: true, get: function () { return packager_js_1.packageAgent; } });
