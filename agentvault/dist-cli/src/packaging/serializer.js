"use strict";
/**
 * Agent State Serializer
 *
 * This module handles serialization and deserialization of agent state
 * for storage in canisters and local files.
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
exports.SCHEMA_VERSION = void 0;
exports.serializeState = serializeState;
exports.deserializeState = deserializeState;
exports.writeStateFile = writeStateFile;
exports.readStateFile = readStateFile;
exports.createEmptyState = createEmptyState;
exports.mergeStates = mergeStates;
exports.validateState = validateState;
var fs = require("node:fs");
var path = require("node:path");
/**
 * Agent state schema version
 */
exports.SCHEMA_VERSION = '1.0.0';
/**
 * Default serialization options
 */
var DEFAULT_OPTIONS = {
    pretty: true,
    includeMemories: true,
    includeTasks: true,
    includeContext: true,
};
/**
 * Serialize agent state to JSON
 */
function serializeState(state, options) {
    if (options === void 0) { options = {}; }
    var opts = __assign(__assign({}, DEFAULT_OPTIONS), options);
    var serialized = {
        $schema: "https://agentvault.dev/schemas/agent-state-v".concat(exports.SCHEMA_VERSION, ".json"),
        version: exports.SCHEMA_VERSION,
        agent: {
            name: state.config.name,
            type: state.config.type,
            version: state.config.version,
        },
        metadata: {
            createdAt: new Date().toISOString(),
            sourcePath: state.config.sourcePath,
            entryPoint: state.config.entryPoint,
        },
        state: {
            initialized: state.memories.length > 0 || state.tasks.length > 0,
            data: {},
        },
    };
    if (opts.includeMemories) {
        serialized.state.data.memories = state.memories;
    }
    if (opts.includeTasks) {
        serialized.state.data.tasks = state.tasks;
    }
    if (opts.includeContext) {
        serialized.state.data.context = mapToObject(state.context);
    }
    return JSON.stringify(serialized, null, opts.pretty ? 2 : 0);
}
/**
 * Deserialize agent state from JSON
 */
function deserializeState(json) {
    var _a, _b, _c;
    var serialized = JSON.parse(json);
    return {
        config: {
            name: serialized.agent.name,
            type: serialized.agent.type,
            sourcePath: serialized.metadata.sourcePath,
            entryPoint: serialized.metadata.entryPoint,
            version: serialized.agent.version,
        },
        memories: (_a = serialized.state.data.memories) !== null && _a !== void 0 ? _a : [],
        tasks: (_b = serialized.state.data.tasks) !== null && _b !== void 0 ? _b : [],
        context: new Map(Object.entries((_c = serialized.state.data.context) !== null && _c !== void 0 ? _c : {})),
        version: serialized.version,
        lastUpdated: Date.now(),
    };
}
/**
 * Write serialized state to file
 */
function writeStateFile(state_1, filePath_1) {
    return __awaiter(this, arguments, void 0, function (state, filePath, options) {
        var serialized, dir;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_a) {
            serialized = serializeState(state, options);
            dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Write file
            fs.writeFileSync(filePath, serialized, 'utf-8');
            return [2 /*return*/];
        });
    });
}
/**
 * Read state from file
 */
function readStateFile(filePath) {
    return __awaiter(this, void 0, void 0, function () {
        var content;
        return __generator(this, function (_a) {
            content = fs.readFileSync(filePath, 'utf-8');
            return [2 /*return*/, deserializeState(content)];
        });
    });
}
/**
 * Convert Map to plain object
 */
function mapToObject(map) {
    var obj = {};
    for (var _i = 0, _a = map.entries(); _i < _a.length; _i++) {
        var _b = _a[_i], key = _b[0], value = _b[1];
        obj[key] = value;
    }
    return obj;
}
/**
 * Create empty agent state
 */
function createEmptyState(config) {
    return {
        config: config,
        memories: [],
        tasks: [],
        context: new Map(),
        version: exports.SCHEMA_VERSION,
        lastUpdated: Date.now(),
    };
}
/**
 * Merge two agent states
 */
function mergeStates(base, updates) {
    var _a, _b, _c, _d, _e, _f;
    var merged = __assign(__assign({}, base), { config: (_a = updates.config) !== null && _a !== void 0 ? _a : base.config, memories: (_b = updates.memories) !== null && _b !== void 0 ? _b : base.memories, tasks: (_c = updates.tasks) !== null && _c !== void 0 ? _c : base.tasks, context: (_d = updates.context) !== null && _d !== void 0 ? _d : base.context, version: (_e = updates.version) !== null && _e !== void 0 ? _e : base.version, lastUpdated: (_f = updates.lastUpdated) !== null && _f !== void 0 ? _f : Date.now() });
    return merged;
}
/**
 * Validate serialized state
 */
function validateState(serialized) {
    var _a, _b;
    var errors = [];
    if (!((_a = serialized.agent) === null || _a === void 0 ? void 0 : _a.name)) {
        errors.push('Missing agent name');
    }
    if (!((_b = serialized.agent) === null || _b === void 0 ? void 0 : _b.type)) {
        errors.push('Missing agent type');
    }
    if (!serialized.version) {
        errors.push('Missing version');
    }
    return {
        valid: errors.length === 0,
        errors: errors,
    };
}
