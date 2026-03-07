"use strict";
/**
 * Clawdbot Configuration Parser
 *
 * Parses Clawdbot agent configuration from .clawdbot directory.
 * Reads JSON files and constructs full configuration object.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.parseClawdbotConfig = parseClawdbotConfig;
exports.findClawdbotConfigs = findClawdbotConfigs;
var fs = require("node:fs");
var path = require("node:path");
var config_schemas_js_1 = require("../config-schemas.js");
/**
 * Find Clawdbot directory or configuration file
 */
function findClawdbotConfig(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    // Check for .clawdbot directory
    var clawdbotDir = path.join(absolutePath, '.clawdbot');
    if (fs.existsSync(clawdbotDir)) {
        return {
            path: clawdbotDir,
            type: 'directory',
        };
    }
    // Check for clawdbot.json or clawdbot.config.json
    var configFiles = ['clawdbot.json', 'clawdbot.config.json'];
    for (var _i = 0, configFiles_1 = configFiles; _i < configFiles_1.length; _i++) {
        var file = configFiles_1[_i];
        var filePath = path.join(absolutePath, file);
        if (fs.existsSync(filePath)) {
            return {
                path: filePath,
                type: 'json',
            };
        }
    }
    return null;
}
/**
 * Read and parse .clawdbot directory structure
 */
function readClawdbotDirectory(dirPath) {
    try {
        // Read projects
        var projectsPath = path.join(dirPath, 'projects.json');
        var projects = [];
        if (fs.existsSync(projectsPath)) {
            var projectsContent = fs.readFileSync(projectsPath, 'utf-8');
            projects = JSON.parse(projectsContent);
        }
        // Read tasks
        var tasksPath = path.join(dirPath, 'tasks.json');
        var tasks = [];
        if (fs.existsSync(tasksPath)) {
            var tasksContent = fs.readFileSync(tasksPath, 'utf-8');
            tasks = JSON.parse(tasksContent);
        }
        // Read context
        var contextPath = path.join(dirPath, 'context.json');
        var context = {};
        if (fs.existsSync(contextPath)) {
            var contextContent = fs.readFileSync(contextPath, 'utf-8');
            context = JSON.parse(contextContent);
        }
        // Read settings
        var settingsPath = path.join(dirPath, 'settings.json');
        var settings = __assign({}, config_schemas_js_1.DEFAULT_CLAWDBOT_SETTINGS);
        if (fs.existsSync(settingsPath)) {
            var settingsContent = fs.readFileSync(settingsPath, 'utf-8');
            var parsedSettings = JSON.parse(settingsContent);
            settings = __assign(__assign({}, config_schemas_js_1.DEFAULT_CLAWDBOT_SETTINGS), parsedSettings);
        }
        // Read main config file if exists
        var name_1 = 'clawdbot-agent';
        var version = '1.0.0';
        var description = '';
        var configPath = path.join(dirPath, 'config.json');
        if (fs.existsSync(configPath)) {
            var configContent = fs.readFileSync(configPath, 'utf-8');
            var configFile = JSON.parse(configContent);
            name_1 = configFile.name || name_1;
            version = configFile.version || version;
            description = configFile.description || description;
        }
        var parsedConfig = {
            type: 'clawdbot',
            name: name_1,
            version: version,
            description: description,
            projects: projects,
            tasks: tasks,
            context: context,
            settings: settings,
        };
        return parsedConfig;
    }
    catch (error) {
        var message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error("Failed to parse Clawdbot config: ".concat(message));
    }
}
/**
 * Validate Clawdbot configuration
 */
function validateClawdbotConfig(config) {
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
    // Validate settings
    if (config.settings) {
        // Validate temperature (must be between 0 and 2)
        if (config.settings.temperature !== undefined) {
            if (config.settings.temperature < 0 || config.settings.temperature > 2) {
                errors.push("Temperature must be between 0 and 2, got: ".concat(config.settings.temperature));
            }
        }
        // Validate maxTokens (must be positive)
        if (config.settings.maxTokens !== undefined) {
            if (config.settings.maxTokens <= 0) {
                errors.push("maxTokens must be positive, got: ".concat(config.settings.maxTokens));
            }
        }
    }
    // Validate projects
    if (config.projects && config.projects.length === 0) {
        warnings.push('No projects defined in configuration');
    }
    // Validate tasks
    if (config.tasks && config.tasks.length === 0) {
        warnings.push('No tasks defined in configuration');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
    };
}
/**
 * Parse Clawdbot agent configuration
 *
 * This function reads .clawdbot directory or clawdbot.json file
 * and returns a fully validated configuration object.
 */
function parseClawdbotConfig(sourcePath_1) {
    return __awaiter(this, arguments, void 0, function (sourcePath, verbose) {
        var configLocation, config, content, parsed, settings, validation;
        var _a, _b;
        if (verbose === void 0) { verbose = false; }
        return __generator(this, function (_c) {
            if (verbose) {
                console.log("[Clawdbot] Parsing configuration from: ".concat(sourcePath));
            }
            configLocation = findClawdbotConfig(sourcePath);
            if (configLocation === null) {
                throw new Error('No Clawdbot configuration found. ' +
                    'Expected .clawdbot directory or clawdbot.json file in the agent source path.');
            }
            if (configLocation.type === 'json') {
                if (verbose) {
                    console.log("[Clawdbot] Found JSON config: ".concat(configLocation.path));
                }
                content = fs.readFileSync(configLocation.path, 'utf-8');
                parsed = JSON.parse(content);
                settings = __assign(__assign({}, config_schemas_js_1.DEFAULT_CLAWDBOT_SETTINGS), parsed.settings);
                config = {
                    type: 'clawdbot',
                    name: parsed.name || 'clawdbot-agent',
                    version: parsed.version || '1.0.0',
                    description: parsed.description || '',
                    settings: settings,
                    projects: parsed.projects || [],
                    tasks: parsed.tasks || [],
                    context: parsed.context || {},
                };
            }
            else {
                if (verbose) {
                    console.log("[Clawdbot] Found directory: ".concat(configLocation.path));
                }
                config = readClawdbotDirectory(configLocation.path);
                if (verbose) {
                    console.log("[Clawdbot] Parsed projects: ".concat(((_a = config.projects) === null || _a === void 0 ? void 0 : _a.length) || 0));
                    console.log("[Clawdbot] Parsed tasks: ".concat(((_b = config.tasks) === null || _b === void 0 ? void 0 : _b.length) || 0));
                    console.log("[Clawdbot] Parsed context keys: ".concat(Object.keys(config.context || {}).length));
                    if (config.settings) {
                        console.log("[Clawdbot] Model: ".concat(config.settings.model));
                        console.log("[Clawdbot] Temperature: ".concat(config.settings.temperature));
                        console.log("[Clawdbot] Max Tokens: ".concat(config.settings.maxTokens));
                    }
                }
            }
            validation = validateClawdbotConfig(config);
            if (verbose || !validation.valid) {
                if (validation.errors.length > 0) {
                    console.error('[Clawdbot] Validation errors:');
                    validation.errors.forEach(function (error) { return console.error("  - ".concat(error)); });
                }
                if (validation.warnings.length > 0) {
                    console.warn('[Clawdbot] Warnings:');
                    validation.warnings.forEach(function (warning) { return console.warn("  - ".concat(warning)); });
                }
            }
            if (!validation.valid) {
                throw new Error("Clawdbot configuration validation failed: ".concat(validation.errors.join('; ')));
            }
            return [2 /*return*/, config];
        });
    });
}
/**
 * Find all Clawdbot configurations in a directory
 */
function findClawdbotConfigs(dir) {
    return __awaiter(this, void 0, void 0, function () {
        var results, entries, _i, entries_1, entry, entryPath, config, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    results = [];
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                    _i = 0, entries_1 = entries;
                    _b.label = 1;
                case 1:
                    if (!(_i < entries_1.length)) return [3 /*break*/, 6];
                    entry = entries_1[_i];
                    entryPath = path.join(dir, entry.name);
                    if (!entry.isDirectory()) return [3 /*break*/, 5];
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, parseClawdbotConfig(entryPath)];
                case 3:
                    config = _b.sent();
                    results.push(entry.name);
                    return [3 /*break*/, 5];
                case 4:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 5:
                    _i++;
                    return [3 /*break*/, 1];
                case 6: return [2 /*return*/, results];
            }
        });
    });
}
