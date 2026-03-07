"use strict";
/**
 * Goose Configuration Parser
 *
 * Parses Goose agent configuration from YAML files.
 * Reads goose.yaml, goose.yml, or .gooserc files and constructs configuration object.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGooseConfig = parseGooseConfig;
exports.findGooseConfigs = findGooseConfigs;
var fs = require("node:fs");
var path = require("node:path");
var yaml = require("yaml");
var config_schemas_js_1 = require("../config-schemas.js");
/**
 * Find Goose configuration file
 */
function findGooseConfig(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    var configFiles = ['goose.yaml', 'goose.yml', '.gooserc'];
    for (var _i = 0, configFiles_1 = configFiles; _i < configFiles_1.length; _i++) {
        var file = configFiles_1[_i];
        var filePath = path.join(absolutePath, file);
        if (fs.existsSync(filePath)) {
            return {
                path: filePath,
                type: 'yaml',
            };
        }
    }
    return null;
}
/**
 * Validate Goose configuration
 */
function validateGooseConfig(config) {
    var errors = [];
    var warnings = [];
    // Validate name
    if (!config.name || config.name.trim() === '') {
        errors.push('Agent name is required');
    }
    // Validate model (required for Goose)
    if (!config.model || config.model.trim() === '') {
        errors.push('Model is required for Goose agent');
    }
    // Validate version format
    if (config.version) {
        var versionRegex = /^\d+\.\d+\.\d+$/;
        if (!versionRegex.test(config.version)) {
            errors.push("Invalid version format: ".concat(config.version, ". Expected: X.Y.Z"));
        }
    }
    // Validate temperature (must be between 0 and 2)
    if (config.temperature !== undefined) {
        if (config.temperature < 0 || config.temperature > 2) {
            errors.push("Temperature must be between 0 and 2, got: ".concat(config.temperature));
        }
    }
    // Validate maxTokens (must be positive)
    if (config.maxTokens !== undefined) {
        if (config.maxTokens <= 0) {
            errors.push("maxTokens must be positive, got: ".concat(config.maxTokens));
        }
    }
    // Validate working directory exists (if specified)
    if (config.workingDirectory) {
        var workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
        if (!fs.existsSync(workingDirPath)) {
            warnings.push("Working directory does not exist: ".concat(config.workingDirectory));
        }
    }
    // Warn if no tools defined
    if (!config.tools || config.tools.length === 0) {
        warnings.push('No tools defined in configuration');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
    };
}
/**
 * Parse Goose agent configuration
 *
 * This function reads goose.yaml, goose.yml, or .gooserc file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Goose configuration
 */
function parseGooseConfig(sourcePath_1) {
    return __awaiter(this, arguments, void 0, function (sourcePath, verbose) {
        var configLocation, config, content, parsed, message, validation, errorMessage, _i, _a, warning;
        var _b;
        if (verbose === void 0) { verbose = false; }
        return __generator(this, function (_c) {
            if (verbose) {
                console.log("[Goose] Parsing configuration from: ".concat(sourcePath));
            }
            configLocation = findGooseConfig(sourcePath);
            if (configLocation === null) {
                throw new Error('No Goose configuration found. ' +
                    'Expected goose.yaml, goose.yml, or .gooserc file in the agent source path.');
            }
            if (verbose) {
                console.log("[Goose] Found YAML config: ".concat(configLocation.path));
            }
            try {
                content = fs.readFileSync(configLocation.path, 'utf-8');
                parsed = yaml.parse(content);
                // Merge with defaults
                config = {
                    type: 'goose',
                    name: parsed.name || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.name,
                    version: parsed.version || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.version,
                    description: parsed.description || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.description,
                    model: parsed.model || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.model,
                    temperature: parsed.temperature !== undefined ? parsed.temperature : config_schemas_js_1.DEFAULT_GOOSE_CONFIG.temperature,
                    maxTokens: parsed.maxTokens !== undefined ? parsed.maxTokens : config_schemas_js_1.DEFAULT_GOOSE_CONFIG.maxTokens,
                    systemPrompt: parsed.systemPrompt || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.systemPrompt,
                    tools: parsed.tools || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.tools,
                    workingDirectory: parsed.workingDirectory || config_schemas_js_1.DEFAULT_GOOSE_CONFIG.workingDirectory,
                };
                if (verbose) {
                    console.log("[Goose] Parsed name: ".concat(config.name));
                    console.log("[Goose] Parsed version: ".concat(config.version));
                    console.log("[Goose] Parsed model: ".concat(config.model));
                    console.log("[Goose] Parsed temperature: ".concat(config.temperature));
                    console.log("[Goose] Parsed maxTokens: ".concat(config.maxTokens));
                    console.log("[Goose] Parsed tools: ".concat(((_b = config.tools) === null || _b === void 0 ? void 0 : _b.length) || 0));
                    console.log("[Goose] Parsed workingDirectory: ".concat(config.workingDirectory));
                }
            }
            catch (error) {
                message = error instanceof Error ? error.message : 'Unknown error';
                throw new Error("Failed to parse Goose config: ".concat(message));
            }
            validation = validateGooseConfig(config);
            if (!validation.valid) {
                errorMessage = "Goose configuration validation failed:\n".concat(validation.errors.map(function (e) { return "  - ".concat(e); }).join('\n'));
                throw new Error(errorMessage);
            }
            // Display warnings if verbose
            if (verbose && validation.warnings.length > 0) {
                console.log("[Goose] Warnings:");
                for (_i = 0, _a = validation.warnings; _i < _a.length; _i++) {
                    warning = _a[_i];
                    console.log("[Goose]   - ".concat(warning));
                }
            }
            return [2 /*return*/, config];
        });
    });
}
/**
 * Find all Goose configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Goose configuration files
 */
function findGooseConfigs(rootPath) {
    var configs = [];
    function searchDirectory(dirPath) {
        var entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
            var entry = entries_1[_i];
            var fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                // Skip node_modules and .git
                if (entry.name !== 'node_modules' && entry.name !== '.git') {
                    searchDirectory(fullPath);
                }
            }
            else if (entry.isFile()) {
                // Check for Goose config files
                if (entry.name === 'goose.yaml' || entry.name === 'goose.yml' || entry.name === '.gooserc') {
                    configs.push(fullPath);
                }
            }
        }
    }
    searchDirectory(rootPath);
    return configs;
}
