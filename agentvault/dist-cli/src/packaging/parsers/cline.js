"use strict";
/**
 * Cline Configuration Parser
 *
 * Parses Cline agent configuration from JSON files.
 * Reads cline.json, cline.config.json, or .cline file and constructs configuration object.
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
exports.parseClineConfig = parseClineConfig;
exports.findClineConfigs = findClineConfigs;
var fs = require("node:fs");
var path = require("node:path");
var config_schemas_js_1 = require("../config-schemas.js");
/**
 * Find Cline configuration file
 */
function findClineConfig(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    // Check for JSON config files
    var configFiles = ['cline.json', 'cline.config.json', '.cline'];
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
 * Validate Cline configuration
 */
function validateClineConfig(config) {
    var errors = [];
    var warnings = [];
    // Validate name
    if (!config.name || config.name.trim() === '') {
        errors.push('Agent name is required');
    }
    // Validate mode
    if (config.mode && !['auto', 'request'].includes(config.mode)) {
        errors.push("Invalid mode: ".concat(config.mode, ". Must be 'auto' or 'request'"));
    }
    // Validate claudeVersion format if specified
    if (config.claudeVersion) {
        // Basic version format validation
        var versionRegex = /^\d+\.\d+/;
        if (!versionRegex.test(config.claudeVersion)) {
            warnings.push("Unusual claudeVersion format: ".concat(config.claudeVersion));
        }
    }
    // Validate version format
    if (config.version) {
        var versionRegex = /^\d+\.\d+\.\d+$/;
        if (!versionRegex.test(config.version)) {
            errors.push("Invalid version format: ".concat(config.version, ". Expected: X.Y.Z"));
        }
    }
    // Validate working directory exists (if specified)
    if (config.workingDirectory) {
        var workingDirPath = path.resolve(process.cwd(), config.workingDirectory);
        if (!fs.existsSync(workingDirPath)) {
            warnings.push("Working directory does not exist: ".concat(config.workingDirectory));
        }
    }
    // Validate allowedCommands format if specified
    if (config.allowedCommands) {
        if (!Array.isArray(config.allowedCommands)) {
            errors.push('allowedCommands must be an array');
        }
        else {
            for (var _i = 0, _a = config.allowedCommands; _i < _a.length; _i++) {
                var cmd = _a[_i];
                if (typeof cmd !== 'string' || cmd.trim() === '') {
                    errors.push("Invalid command in allowedCommands: ".concat(cmd));
                }
            }
        }
    }
    // Warn if no allowedCommands defined in auto mode
    if (config.mode === 'auto' && (!config.allowedCommands || config.allowedCommands.length === 0)) {
        warnings.push('Auto mode without allowedCommands may execute dangerous commands');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
    };
}
/**
 * Parse Cline agent configuration
 *
 * This function reads cline.json, cline.config.json, or .cline file
 * and returns a fully validated configuration object.
 *
 * @param sourcePath - Path to agent source directory
 * @param verbose - Enable verbose logging
 * @returns Parsed and validated Cline configuration
 */
function parseClineConfig(sourcePath_1) {
    return __awaiter(this, arguments, void 0, function (sourcePath, verbose) {
        var configLocation, config, content, parsed, message, validation, errorMessage, _i, _a, warning;
        var _b;
        if (verbose === void 0) { verbose = false; }
        return __generator(this, function (_c) {
            if (verbose) {
                console.log("[Cline] Parsing configuration from: ".concat(sourcePath));
            }
            configLocation = findClineConfig(sourcePath);
            if (configLocation === null) {
                throw new Error('No Cline configuration found. ' +
                    'Expected cline.json, cline.config.json, or .cline file in the agent source path.');
            }
            if (verbose) {
                console.log("[Cline] Found JSON config: ".concat(configLocation.path));
            }
            try {
                content = fs.readFileSync(configLocation.path, 'utf-8');
                parsed = JSON.parse(content);
                // Merge with defaults
                config = {
                    type: 'cline',
                    name: parsed.name || config_schemas_js_1.DEFAULT_CLINE_CONFIG.name,
                    version: parsed.version || config_schemas_js_1.DEFAULT_CLINE_CONFIG.version,
                    description: parsed.description || config_schemas_js_1.DEFAULT_CLINE_CONFIG.description,
                    mode: parsed.mode || config_schemas_js_1.DEFAULT_CLINE_CONFIG.mode,
                    claudeVersion: parsed.claudeVersion,
                    workingDirectory: parsed.workingDirectory || config_schemas_js_1.DEFAULT_CLINE_CONFIG.workingDirectory,
                    autoConfirm: parsed.autoConfirm !== undefined ? parsed.autoConfirm : config_schemas_js_1.DEFAULT_CLINE_CONFIG.autoConfirm,
                    useReadline: parsed.useReadline !== undefined ? parsed.useReadline : config_schemas_js_1.DEFAULT_CLINE_CONFIG.useReadline,
                    allowedCommands: parsed.allowedCommands || [],
                };
                if (verbose) {
                    console.log("[Cline] Parsed name: ".concat(config.name));
                    console.log("[Cline] Parsed version: ".concat(config.version));
                    console.log("[Cline] Parsed mode: ".concat(config.mode));
                    console.log("[Cline] Parsed claudeVersion: ".concat(config.claudeVersion || 'default'));
                    console.log("[Cline] Parsed workingDirectory: ".concat(config.workingDirectory));
                    console.log("[Cline] Parsed autoConfirm: ".concat(config.autoConfirm));
                    console.log("[Cline] Parsed useReadline: ".concat(config.useReadline));
                    console.log("[Cline] Parsed allowedCommands: ".concat(((_b = config.allowedCommands) === null || _b === void 0 ? void 0 : _b.length) || 0));
                }
            }
            catch (error) {
                message = error instanceof Error ? error.message : 'Unknown error';
                throw new Error("Failed to parse Cline config: ".concat(message));
            }
            validation = validateClineConfig(config);
            if (!validation.valid) {
                errorMessage = "Cline configuration validation failed:\n".concat(validation.errors.map(function (e) { return "  - ".concat(e); }).join('\n'));
                throw new Error(errorMessage);
            }
            // Display warnings if verbose
            if (verbose && validation.warnings.length > 0) {
                console.log("[Cline] Warnings:");
                for (_i = 0, _a = validation.warnings; _i < _a.length; _i++) {
                    warning = _a[_i];
                    console.log("[Cline]   - ".concat(warning));
                }
            }
            return [2 /*return*/, config];
        });
    });
}
/**
 * Find all Cline configurations in a directory tree
 *
 * @param rootPath - Root directory to search
 * @returns Array of paths to Cline configuration files
 */
function findClineConfigs(rootPath) {
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
                // Check for Cline config files
                if (entry.name === 'cline.json' || entry.name === 'cline.config.json' || entry.name === '.cline') {
                    configs.push(fullPath);
                }
            }
        }
    }
    searchDirectory(rootPath);
    return configs;
}
