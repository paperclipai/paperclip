"use strict";
/**
 * Generic Configuration Parser
 *
 * Parses generic agent configuration from JSON or YAML files.
 * Reads agent.json, agent.yaml, agent.yml, or .agentvault.json file
 * and constructs configuration object.
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
exports.parseGenericConfig = parseGenericConfig;
exports.findGenericConfigs = findGenericConfigs;
var fs = require("node:fs");
var path = require("node:path");
var yaml = require("yaml");
/**
 * Find Generic configuration file
 */
function findGenericConfig(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    // Check for config files (priority order)
    var configFiles = ['agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json', '.agentvault.json'];
    for (var _i = 0, configFiles_1 = configFiles; _i < configFiles_1.length; _i++) {
        var file = configFiles_1[_i];
        var filePath = path.join(absolutePath, file);
        if (fs.existsSync(filePath)) {
            // Determine type based on extension
            var type = file.endsWith('.yaml') || file.endsWith('.yml') ? 'yaml' : 'json';
            return {
                path: filePath,
                type: type,
            };
        }
    }
    return null;
}
/**
 * Validate Generic configuration
 */
function validateGenericConfig(config) {
    var errors = [];
    var warnings = [];
    // Validate name
    if (!config.name || config.name.trim() === '') {
        errors.push('Agent name is required');
    }
    // Validate version format
    if (config.version) {
        var versionRegex = /^\d+\.\d+\.\d+$/;
        if (!versionRegex.test(config.version)) {
            errors.push("Invalid version format: ".concat(config.version, ". Expected: X.Y.Z"));
        }
    }
    // Validate entry point exists (if specified)
    if (config.entryPoint) {
        var sourcePath = process.cwd();
        var entryPath = path.join(sourcePath, config.entryPoint);
        if (!fs.existsSync(entryPath)) {
            warnings.push("Entry point does not exist: ".concat(config.entryPoint));
        }
    }
    // Validate working directory exists (if specified)
    if (config.workingDirectory) {
        var workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
        if (!fs.existsSync(workingDirPath)) {
            warnings.push("Working directory does not exist: ".concat(config.workingDirectory));
        }
    }
    // Validate allowedFiles format if specified
    if (config.allowedFiles) {
        if (!Array.isArray(config.allowedFiles)) {
            errors.push('allowedFiles must be an array');
        }
        else {
            for (var _i = 0, _a = config.allowedFiles; _i < _a.length; _i++) {
                var pattern = _a[_i];
                if (typeof pattern !== 'string' || pattern.trim() === '') {
                    errors.push("Invalid file pattern in allowedFiles: ".concat(pattern));
                }
            }
        }
    }
    // Validate maxFileSize if specified
    if (config.maxFileSize !== undefined) {
        if (typeof config.maxFileSize !== 'number' || config.maxFileSize <= 0) {
            errors.push("maxFileSize must be a positive number, got: ".concat(config.maxFileSize));
        }
        else {
            // Warn if maxFileSize is very large (> 100MB)
            if (config.maxFileSize > 100 * 1024 * 1024) {
                warnings.push("maxFileSize is very large (".concat((config.maxFileSize / 1024 / 1024).toFixed(0), "MB)"));
            }
        }
    }
    // Validate environment variables if specified
    if (config.environment) {
        if (typeof config.environment !== 'object' || config.environment === null) {
            errors.push('environment must be an object');
        }
        else {
            for (var _b = 0, _c = Object.entries(config.environment); _b < _c.length; _b++) {
                var _d = _c[_b], key = _d[0], value = _d[1];
                if (typeof value !== 'string') {
                    errors.push("Environment variable ".concat(key, " must be a string"));
                }
            }
        }
    }
    // Warn if no entry point defined
    if (!config.entryPoint) {
        warnings.push('No entry point defined. Agent may not be executable.');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
    };
}
/**
 * Parse Generic agent configuration
 *
 * This function reads agent.json, agent.yaml, agent.yml, or .agentvault.json file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Generic configuration
 */
function parseGenericConfig(sourcePath_1) {
    return __awaiter(this, arguments, void 0, function (sourcePath, verbose) {
        var configLocation, config, content, parsed, parsed, message, validation, errorMessage, _i, _a, warning;
        var _b;
        if (verbose === void 0) { verbose = false; }
        return __generator(this, function (_c) {
            if (verbose) {
                console.log("[Generic] Parsing configuration from: ".concat(sourcePath));
            }
            configLocation = findGenericConfig(sourcePath);
            if (configLocation === null) {
                throw new Error('No Generic agent configuration found. ' +
                    'Expected agent.json, agent.yaml, agent.yml, or .agentvault.json file in the agent source path.');
            }
            if (verbose) {
                console.log("[Generic] Found ".concat(configLocation.type.toUpperCase(), " config: ").concat(configLocation.path));
            }
            try {
                content = fs.readFileSync(configLocation.path, 'utf-8');
                // Parse based on file type
                if (configLocation.type === 'json') {
                    parsed = JSON.parse(content);
                    config = {
                        type: 'generic',
                        name: parsed.name || 'generic-agent',
                        version: parsed.version,
                        description: parsed.description,
                        entryPoint: parsed.entryPoint,
                        workingDirectory: parsed.workingDirectory,
                        environment: parsed.environment || {},
                        allowedFiles: parsed.allowedFiles,
                        maxFileSize: parsed.maxFileSize,
                    };
                }
                else {
                    parsed = yaml.parse(content);
                    config = {
                        type: 'generic',
                        name: parsed.name || 'generic-agent',
                        version: parsed.version,
                        description: parsed.description,
                        entryPoint: parsed.entryPoint,
                        workingDirectory: parsed.workingDirectory,
                        environment: parsed.environment || {},
                        allowedFiles: parsed.allowedFiles,
                        maxFileSize: parsed.maxFileSize,
                    };
                }
                if (verbose) {
                    console.log("[Generic] Parsed name: ".concat(config.name));
                    console.log("[Generic] Parsed version: ".concat(config.version));
                    console.log("[Generic] Parsed entryPoint: ".concat(config.entryPoint || 'none'));
                    console.log("[Generic] Parsed workingDirectory: ".concat(config.workingDirectory || 'none'));
                    console.log("[Generic] Parsed environment keys: ".concat(Object.keys(config.environment || {}).length));
                    console.log("[Generic] Parsed allowedFiles: ".concat(((_b = config.allowedFiles) === null || _b === void 0 ? void 0 : _b.length) || 0));
                    console.log("[Generic] Parsed maxFileSize: ".concat(config.maxFileSize || 'unlimited'));
                }
            }
            catch (error) {
                message = error instanceof Error ? error.message : 'Unknown error';
                throw new Error("Failed to parse Generic config: ".concat(message));
            }
            validation = validateGenericConfig(config);
            if (!validation.valid) {
                errorMessage = "Generic agent configuration validation failed:\n".concat(validation.errors.map(function (e) { return "  - ".concat(e); }).join('\n'));
                throw new Error(errorMessage);
            }
            // Display warnings if verbose
            if (verbose && validation.warnings.length > 0) {
                console.log("[Generic] Warnings:");
                for (_i = 0, _a = validation.warnings; _i < _a.length; _i++) {
                    warning = _a[_i];
                    console.log("[Generic]   - ".concat(warning));
                }
            }
            return [2 /*return*/, config];
        });
    });
}
/**
 * Find all Generic configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Generic configuration files
 */
function findGenericConfigs(rootPath) {
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
                // Check for Generic config files
                if (entry.name === 'agent.json' ||
                    entry.name === 'agent.yaml' ||
                    entry.name === 'agent.yml' ||
                    entry.name === 'agentvault.json' ||
                    entry.name === '.agentvault.json') {
                    configs.push(fullPath);
                }
            }
        }
    }
    searchDirectory(rootPath);
    return configs;
}
