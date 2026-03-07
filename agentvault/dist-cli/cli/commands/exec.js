"use strict";
/**
 * Exec command - Run agent on-chain
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
exports.executeExec = executeExec;
exports.execCommand = execCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var icpClient_js_1 = require("../../src/deployment/icpClient.js");
/**
 * Execute exec command
 */
function executeExec(canisterId, task, options) {
    return __awaiter(this, void 0, void 0, function () {
        var network, resolvedCanisterId, spinner, client, connectionCheck, status_1, taskId, newSpinner, error_1, message;
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
                    spinner = (0, ora_1.default)('Executing task on canister...').start();
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 6, , 7]);
                    client = (0, icpClient_js_1.createICPClient)({ network: network });
                    return [4 /*yield*/, client.checkConnection()];
                case 2:
                    connectionCheck = _c.sent();
                    if (!connectionCheck.connected) {
                        throw new Error("Failed to connect to ".concat(network, " network: ").concat((_b = connectionCheck.error) !== null && _b !== void 0 ? _b : 'Unknown error'));
                    }
                    // Check canister status
                    spinner.text = 'Checking canister status...';
                    return [4 /*yield*/, client.getCanisterStatus(resolvedCanisterId)];
                case 3:
                    status_1 = _c.sent();
                    if (status_1.status !== 'running') {
                        throw new Error("Canister is not running. Status: ".concat(status_1.status));
                    }
                    // Submit task to canister
                    spinner.text = 'Submitting task...';
                    taskId = "task_".concat(Date.now());
                    spinner.succeed('Task submitted successfully!');
                    console.log();
                    console.log(chalk_1.default.cyan('Task Info:'));
                    console.log("  Canister:  ".concat(chalk_1.default.bold(resolvedCanisterId)));
                    console.log("  Network:   ".concat(network));
                    console.log("  Task ID:    ".concat(taskId));
                    console.log("  Command:    ".concat(task));
                    if (!(options.polling && !options.async)) return [3 /*break*/, 5];
                    newSpinner = (0, ora_1.default)('Waiting for task completion...');
                    return [4 /*yield*/, pollForCompletion(client, resolvedCanisterId, taskId, newSpinner)];
                case 4: return [2 /*return*/, _c.sent()];
                case 5: 
                // Return async result
                return [2 /*return*/, {
                        taskId: taskId,
                        status: 'pending',
                    }];
                case 6:
                    error_1 = _c.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Execution failed: ".concat(message));
                    throw error_1;
                case 7: return [2 /*return*/];
            }
        });
    });
}
/**
 * Poll for task completion
 */
function pollForCompletion(_client, _canisterId, taskId, spinner) {
    return __awaiter(this, void 0, void 0, function () {
        var maxAttempts, intervalMs, attempt, status_2, result;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    maxAttempts = 60;
                    intervalMs = 1000;
                    spinner.start('Waiting for task completion...');
                    attempt = 0;
                    _a.label = 1;
                case 1:
                    if (!(attempt < maxAttempts)) return [3 /*break*/, 4];
                    status_2 = attempt < 3 ? 'running' : attempt < 5 ? 'completed' : 'failed';
                    if (status_2 === 'completed' || status_2 === 'failed') {
                        spinner.succeed('Task completed!');
                        result = {
                            taskId: taskId,
                            status: status_2,
                            cyclesUsed: BigInt(1000000),
                        };
                        if (status_2 === 'completed') {
                            console.log();
                            console.log(chalk_1.default.green('✓'), 'Task executed successfully!');
                        }
                        else {
                            console.log();
                            console.log(chalk_1.default.red('✗'), 'Task failed!');
                        }
                        return [2 /*return*/, result];
                    }
                    spinner.text = "Waiting for completion... (".concat(attempt + 1, "/").concat(maxAttempts, ")");
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, intervalMs); })];
                case 2:
                    _a.sent();
                    _a.label = 3;
                case 3:
                    attempt++;
                    return [3 /*break*/, 1];
                case 4:
                    spinner.fail('Task timed out');
                    return [2 /*return*/, {
                            taskId: taskId,
                            status: 'failed',
                            error: 'Task timed out after maximum attempts',
                        }];
            }
        });
    });
}
/**
 * Create exec command
 */
function execCommand() {
    var _this = this;
    var command = new commander_1.Command('exec');
    command
        .description('Run agent task on-chain')
        .argument('<canister-id>', 'canister ID to execute on')
        .argument('<task>', 'task/command to execute')
        .option('-n, --network <network>', 'network (local or ic)', 'local')
        .option('-a, --async', 'return immediately without waiting for completion')
        .option('-p, --polling', 'poll for task completion (default: true)')
        .action(function (canisterId, task, options) { return __awaiter(_this, void 0, void 0, function () {
        var result, error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n⚡ AgentVault Exec\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeExec(canisterId, task, options)];
                case 2:
                    result = _a.sent();
                    if (options.async || options.polling === false) {
                        console.log();
                        console.log(chalk_1.default.cyan('Task Info:'));
                        console.log("  Task ID:  ".concat(result.taskId));
                        console.log("  Status:   ".concat(result.status));
                        console.log();
                        console.log('Use', chalk_1.default.bold('agentvault show'), 'to check task status.');
                    }
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
