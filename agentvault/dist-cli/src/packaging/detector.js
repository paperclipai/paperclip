"use strict";
/**
 * Agent type detection logic
 *
 * Detects what type of agent is in a given directory based on
 * configuration files and directory structure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectAgentType = detectAgentType;
exports.detectAgent = detectAgent;
exports.validateSourcePath = validateSourcePath;
var fs = require("node:fs");
var path = require("node:path");
var yaml = require("yaml");
/**
 * Configuration file patterns for each agent type
 */
var AGENT_PATTERNS = {
    clawdbot: {
        files: ['clawdbot.json', 'clawdbot.config.json', '.clawdbot'],
        dirs: ['.clawdbot'],
    },
    goose: {
        files: ['goose.yaml', 'goose.yml', 'goose.config.yaml', '.gooserc'],
        dirs: ['.goose'],
    },
    cline: {
        files: ['cline.json', 'cline.config.json', '.cline'],
        dirs: ['.cline'],
    },
    generic: {
        files: ['agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json'],
        dirs: [],
    },
};
/**
 * Check if a file exists at the given path
 */
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }
    catch (_a) {
        return false;
    }
}
/**
 * Check if a directory exists at the given path
 */
function directoryExists(dirPath) {
    try {
        return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
    }
    catch (_a) {
        return false;
    }
}
/**
 * Detect agent type from a source directory
 */
function detectAgentType(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    for (var _i = 0, _a = ['clawdbot', 'goose', 'cline']; _i < _a.length; _i++) {
        var agentType = _a[_i];
        var patterns = AGENT_PATTERNS[agentType];
        for (var _b = 0, _c = patterns.files; _b < _c.length; _b++) {
            var file = _c[_b];
            var filePath = path.join(absolutePath, file);
            if (fileExists(filePath)) {
                return agentType;
            }
        }
        for (var _d = 0, _e = patterns.dirs; _d < _e.length; _d++) {
            var dir = _e[_d];
            var dirPath = path.join(absolutePath, dir);
            if (directoryExists(dirPath)) {
                return agentType;
            }
        }
    }
    return 'generic';
}
/**
 * Extract agent name from the source path or config
 */
function extractAgentName(sourcePath, config) {
    if (config && typeof config.name === 'string' && config.name.trim()) {
        return config.name.trim();
    }
    var dirName = path.basename(path.resolve(sourcePath));
    var sanitizedName = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return sanitizedName;
}
/**
 * Find configuration file for a detected agent type
 */
function findConfigFile(sourcePath, agentType) {
    var absolutePath = path.resolve(sourcePath);
    var patterns = AGENT_PATTERNS[agentType];
    for (var _i = 0, _a = patterns.files; _i < _a.length; _i++) {
        var file = _a[_i];
        var filePath = path.join(absolutePath, file);
        if (fileExists(filePath)) {
            return filePath;
        }
    }
    return null;
}
/**
 * Detect entry point for an agent
 */
function detectEntryPoint(sourcePath, agentType) {
    var absolutePath = path.resolve(sourcePath);
    var entryPoints = [
        'index.ts',
        'index.js',
        'main.ts',
        'main.js',
        'agent.ts',
        'agent.js',
        'src/index.ts',
        'src/index.js',
        'src/main.ts',
        'src/main.js',
    ];
    if (agentType === 'clawdbot') {
        entryPoints.unshift('clawdbot.ts', 'clawdbot.js');
    }
    else if (agentType === 'goose') {
        entryPoints.unshift('goose.ts', 'goose.js');
    }
    else if (agentType === 'cline') {
        entryPoints.unshift('cline.ts', 'cline.js');
    }
    for (var _i = 0, entryPoints_1 = entryPoints; _i < entryPoints_1.length; _i++) {
        var entry = entryPoints_1[_i];
        var entryPath = path.join(absolutePath, entry);
        if (fileExists(entryPath)) {
            return entry;
        }
    }
    return undefined;
}
/**
 * Detect agent configuration from a source directory
 *
 * @param sourcePath - Path to agent directory
 * @returns Agent configuration with basic detection
 */
function detectAgent(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    var agentType = detectAgentType(sourcePath);
    var configFile = findConfigFile(sourcePath, agentType);
    var config = configFile ? tryReadConfig(configFile) : null;
    var name = extractAgentName(sourcePath, config);
    var entryPoint = detectEntryPoint(sourcePath, agentType);
    return {
        name: name,
        type: agentType,
        sourcePath: absolutePath,
        entryPoint: entryPoint,
        version: config === null || config === void 0 ? void 0 : config.version,
    };
}
/**
 * Validate that the source path exists and is a directory
 */
function validateSourcePath(sourcePath) {
    var absolutePath = path.resolve(sourcePath);
    if (!fs.existsSync(absolutePath)) {
        return {
            valid: false,
            error: "Source path does not exist: ".concat(absolutePath),
        };
    }
    if (!fs.statSync(absolutePath).isDirectory()) {
        return {
            valid: false,
            error: "Source path is not a directory: ".concat(absolutePath),
        };
    }
    return { valid: true };
}
/**
 * Try to read configuration file (JSON or YAML)
 */
function tryReadConfig(filePath) {
    try {
        var content = fs.readFileSync(filePath, 'utf-8');
        // Check file extension to determine format
        if (filePath.endsWith('.json')) {
            return JSON.parse(content);
        }
        else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml') || filePath.endsWith('.gooserc')) {
            return yaml.parse(content);
        }
        return null;
    }
    catch (_a) {
        return null;
    }
}
