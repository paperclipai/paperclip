"use strict";
/**
 * List command - List all agents
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
exports.getAgents = getAgents;
exports.displayAgents = displayAgents;
exports.executeList = executeList;
exports.listCommand = listCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var fs = require("node:fs");
var path = require("node:path");
/**
 * Get list of all agents
 */
function getAgents(options) {
    return __awaiter(this, void 0, void 0, function () {
        var agents, localAgents, deployedAgents;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    agents = [];
                    return [4 /*yield*/, getLocalAgents()];
                case 1:
                    localAgents = _a.sent();
                    if (options.local || !options.deployed) {
                        agents.push.apply(agents, localAgents);
                    }
                    if (!(options.deployed || options.all)) return [3 /*break*/, 3];
                    return [4 /*yield*/, getDeployedAgents()];
                case 2:
                    deployedAgents = _a.sent();
                    agents.push.apply(agents, deployedAgents);
                    _a.label = 3;
                case 3: return [2 /*return*/, agents];
            }
        });
    });
}
/**
 * Get local agents from filesystem
 */
function getLocalAgents() {
    return __awaiter(this, void 0, void 0, function () {
        var agents, agentDir, agentsDir, entries, _i, entries_1, entry, agentPath, stateFile, state, distDir, entries, _a, entries_2, entry, name_1, stateFile, state;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            agents = [];
            agentDir = path.join(process.cwd(), '.agentvault');
            if (fs.existsSync(agentDir)) {
                agentsDir = path.join(agentDir, 'agents');
                if (fs.existsSync(agentsDir)) {
                    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
                    for (_i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                        entry = entries_1[_i];
                        if (entry.isDirectory()) {
                            agentPath = path.join(agentsDir, entry.name);
                            stateFile = path.join(agentPath, 'state.json');
                            if (fs.existsSync(stateFile)) {
                                try {
                                    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                                    agents.push({
                                        name: entry.name,
                                        type: ((_b = state.agent) === null || _b === void 0 ? void 0 : _b.type) || 'generic',
                                        sourcePath: agentPath,
                                        deployed: false,
                                        lastUpdated: (_c = state.metadata) === null || _c === void 0 ? void 0 : _c.createdAt,
                                    });
                                }
                                catch (_g) {
                                    // Skip invalid state files
                                }
                            }
                        }
                    }
                }
            }
            distDir = path.join(process.cwd(), 'dist');
            if (fs.existsSync(distDir)) {
                entries = fs.readdirSync(distDir);
                for (_a = 0, entries_2 = entries; _a < entries_2.length; _a++) {
                    entry = entries_2[_a];
                    if (entry.endsWith('.wasm')) {
                        name_1 = entry.replace('.wasm', '');
                        stateFile = path.join(distDir, "".concat(name_1, ".state.json"));
                        if (fs.existsSync(stateFile)) {
                            try {
                                state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
                                agents.push({
                                    name: name_1,
                                    type: ((_d = state.agent) === null || _d === void 0 ? void 0 : _d.type) || 'generic',
                                    sourcePath: process.cwd(),
                                    deployed: false,
                                    lastUpdated: (_e = state.metadata) === null || _e === void 0 ? void 0 : _e.createdAt,
                                });
                            }
                            catch (_h) {
                                agents.push({
                                    name: name_1,
                                    type: 'generic',
                                    sourcePath: process.cwd(),
                                    deployed: false,
                                });
                            }
                        }
                    }
                }
            }
            return [2 /*return*/, agents];
        });
    });
}
/**
 * Get deployed agents (stub)
 */
function getDeployedAgents() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            // Stub: In a real implementation, this would query the canister registry
            return [2 /*return*/, []];
        });
    });
}
/**
 * Display list of agents
 */
function displayAgents(agents, options) {
    if (options.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
    }
    console.log();
    if (agents.length === 0) {
        console.log(chalk_1.default.yellow('No agents found.'));
        console.log();
        console.log('Create a new agent with:', chalk_1.default.bold('agentvault init'));
        return;
    }
    console.log(chalk_1.default.cyan("Found ".concat(agents.length, " agent(s):\n")));
    for (var _i = 0, agents_1 = agents; _i < agents_1.length; _i++) {
        var agent = agents_1[_i];
        console.log(chalk_1.default.bold(agent.name));
        console.log("  Type:     ".concat(agent.type));
        console.log("  Source:    ".concat(agent.sourcePath));
        if (agent.deployed && agent.canisterId) {
            console.log("  Canister:  ".concat(agent.canisterId));
            console.log("  Network:   ".concat(agent.network));
        }
        else {
            console.log("  Status:    ".concat(chalk_1.default.yellow('Not deployed')));
        }
        if (agent.lastUpdated) {
            console.log("  Updated:   ".concat(agent.lastUpdated));
        }
        console.log();
    }
}
/**
 * Execute list command
 */
function executeList(options) {
    return __awaiter(this, void 0, void 0, function () {
        var spinner, agents, error_1, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    spinner = (0, ora_1.default)('Scanning for agents...').start();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, getAgents(options)];
                case 2:
                    agents = _a.sent();
                    spinner.succeed('Scan complete!');
                    displayAgents(agents, options);
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("List failed: ".concat(message));
                    throw error_1;
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Create list command
 */
function listCommand() {
    var _this = this;
    var command = new commander_1.Command('list');
    command
        .description('List all agents')
        .option('-a, --all', 'show all agents (local and deployed)')
        .option('--deployed', 'show only deployed agents')
        .option('--local', 'show only local agents')
        .option('-j, --json', 'output as JSON')
        .action(function (options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📋 AgentVault List\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeList(options)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    error_2 = _a.sent();
                    message = error_2 instanceof Error ? error_2.message : 'Unknown error';
                    console.error(chalk_1.default.red("\nError: ".concat(message)));
                    process.exit(1);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    return command;
}
