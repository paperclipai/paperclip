"use strict";
/**
 * Show command - Show agent state
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
exports.executeShow = executeShow;
exports.displayState = displayState;
exports.showCommand = showCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var icpClient_js_1 = require("../../src/deployment/icpClient.js");
/**
 * Execute show command
 */
function executeShow(canisterId, options) {
    return __awaiter(this, void 0, void 0, function () {
        var network, resolvedCanisterId, spinner, client, connectionCheck, status_1, state, error_1, message;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    network = (_a = options.network) !== null && _a !== void 0 ? _a : 'local';
                    resolvedCanisterId = canisterId.trim();
                    // Validate canister ID
                    if (!/^[a-z0-9-]{27}$/.test(resolvedCanisterId)) {
                        throw new Error("Invalid canister ID format: ".concat(resolvedCanisterId, ". Expected 27 characters of alphanumeric and hyphens."));
                    }
                    spinner = (0, ora_1.default)('Fetching agent state...').start();
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 4, , 5]);
                    client = (0, icpClient_js_1.createICPClient)({ network: network });
                    return [4 /*yield*/, client.checkConnection()];
                case 2:
                    connectionCheck = _c.sent();
                    if (!connectionCheck.connected) {
                        throw new Error("Failed to connect to ".concat(network, " network: ").concat((_b = connectionCheck.error) !== null && _b !== void 0 ? _b : 'Unknown error'));
                    }
                    return [4 /*yield*/, client.getCanisterStatus(resolvedCanisterId)];
                case 3:
                    status_1 = _c.sent();
                    spinner.succeed('Agent state fetched successfully!');
                    state = {
                        canisterId: resolvedCanisterId,
                        network: network,
                        status: status_1.status,
                        memorySize: status_1.memorySize,
                        cycles: status_1.cycles,
                        lastUpdated: new Date().toISOString(),
                    };
                    // In a real implementation, this would query actual canister for tasks/memories
                    if (options.tasks) {
                        state.tasks = [];
                    }
                    if (options.memories) {
                        state.memories = [];
                    }
                    if (options.context) {
                        state.context = {};
                    }
                    // Display
                    if (options.json) {
                        console.log(JSON.stringify(state, null, 2));
                        return [2 /*return*/];
                    }
                    displayState(state, options);
                    return [3 /*break*/, 5];
                case 4:
                    error_1 = _c.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Show failed: ".concat(message));
                    throw error_1;
                case 5: return [2 /*return*/];
            }
        });
    });
}
/**
 * Format cycles for display
 */
function formatCycles(cycles) {
    if (cycles >= BigInt(1000000000000)) {
        return "".concat((Number(cycles) / 1000000000000).toFixed(2), " T");
    }
    if (cycles >= BigInt(1000000000)) {
        return "".concat((Number(cycles) / 1000000000).toFixed(2), " B");
    }
    if (cycles >= BigInt(1000000)) {
        return "".concat((Number(cycles) / 1000000).toFixed(2), " M");
    }
    return "".concat(cycles.toString());
}
/**
 * Format memory size for display
 */
function formatMemory(bytes) {
    if (bytes >= BigInt(1024 * 1024 * 1024)) {
        return "".concat((Number(bytes) / (1024 * 1024 * 1024)).toFixed(2), " GiB");
    }
    if (bytes >= BigInt(1024 * 1024)) {
        return "".concat((Number(bytes) / (1024 * 1024)).toFixed(2), " MiB");
    }
    if (bytes >= BigInt(1024)) {
        return "".concat((Number(bytes) / 1024).toFixed(2), " KiB");
    }
    return "".concat(bytes.toString(), " B");
}
/**
 * Display state
 */
function displayState(state, options) {
    var _a;
    console.log();
    console.log(chalk_1.default.cyan('Canister Status:'));
    console.log("  ID:        ".concat(chalk_1.default.bold(state.canisterId)));
    console.log("  Network:   ".concat(state.network));
    console.log("  Status:    ".concat(getStatusColor(state.status)));
    console.log("  Cycles:    ".concat(formatCycles(state.cycles)));
    console.log("  Memory:    ".concat(formatMemory(state.memorySize)));
    console.log("  Updated:   ".concat((_a = state.lastUpdated) !== null && _a !== void 0 ? _a : 'N/A'));
    if (options.tasks && state.tasks) {
        console.log();
        console.log(chalk_1.default.cyan("Tasks (".concat(state.tasks.length, "):")));
        if (state.tasks.length === 0) {
            console.log('  No tasks found.');
        }
        else {
            for (var _i = 0, _b = state.tasks; _i < _b.length; _i++) {
                var task = _b[_i];
                var t = task;
                console.log("  - ".concat(t.id, ": ").concat(t.status, " - ").concat(t.description));
            }
        }
    }
    if (options.memories && state.memories) {
        console.log();
        console.log(chalk_1.default.cyan("Memories (".concat(state.memories.length, "):")));
        if (state.memories.length === 0) {
            console.log('  No memories found.');
        }
        else {
            for (var _c = 0, _d = state.memories; _c < _d.length; _c++) {
                var memory = _d[_c];
                var m = memory;
                console.log("  - ".concat(m.type, ": ").concat(m.content.substring(0, 50), "..."));
            }
        }
    }
    if (options.context && state.context) {
        var keys = Object.keys(state.context);
        console.log();
        console.log(chalk_1.default.cyan("Context (".concat(keys.length, " entries):")));
        if (keys.length === 0) {
            console.log('  No context entries found.');
        }
        else {
            for (var _e = 0, keys_1 = keys; _e < keys_1.length; _e++) {
                var key = keys_1[_e];
                console.log("  - ".concat(key, ": ").concat(JSON.stringify(state.context[key])));
            }
        }
    }
}
/**
 * Get status with color
 */
function getStatusColor(status) {
    switch (status) {
        case 'running':
            return chalk_1.default.green('Running');
        case 'stopping':
            return chalk_1.default.yellow('Stopping');
        case 'stopped':
            return chalk_1.default.red('Stopped');
        default:
            return status;
    }
}
/**
 * Create show command
 */
function showCommand() {
    var _this = this;
    var command = new commander_1.Command('show');
    command
        .description('Show agent state from canister')
        .argument('<canister-id>', 'canister ID to show state for')
        .option('-n, --network <network>', 'network (local or ic)', 'local')
        .option('-j, --json', 'output as JSON')
        .option('-t, --tasks', 'show task queue')
        .option('-m, --memories', 'show memories')
        .option('-c, --context', 'show context')
        .action(function (canisterId, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n👁️  AgentVault Show\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeShow(canisterId, options)];
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
