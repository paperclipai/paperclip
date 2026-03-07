"use strict";
/**
 * Deploy command - Deploy agent WASM to ICP canister
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
exports.displayPreview = displayPreview;
exports.displayResult = displayResult;
exports.executeDeploy = executeDeploy;
exports.deployCommand = deployCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var inquirer_1 = require("inquirer");
var path = require("node:path");
var index_js_1 = require("../../src/deployment/index.js");
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
 * Format file size for display
 */
function formatSize(bytes) {
    if (bytes < 1024) {
        return "".concat(bytes, " B");
    }
    if (bytes < 1024 * 1024) {
        return "".concat((bytes / 1024).toFixed(1), " KB");
    }
    return "".concat((bytes / (1024 * 1024)).toFixed(2), " MB");
}
/**
 * Display deployment preview (dry-run)
 */
function displayPreview(wasmPath, options) {
    var _a;
    var summary = (0, index_js_1.getDeploySummary)({
        wasmPath: path.resolve(wasmPath),
        network: (_a = options.network) !== null && _a !== void 0 ? _a : 'local',
        canisterId: options.canisterId,
        skipConfirmation: options.yes,
    });
    console.log(chalk_1.default.bold('\nDeployment Preview\n'));
    console.log(chalk_1.default.cyan('Agent:'));
    console.log("  Name:      ".concat(chalk_1.default.bold(summary.agentName)));
    console.log("  WASM:      ".concat(summary.wasmPath));
    console.log("  Size:      ".concat(formatSize(summary.wasmSize)));
    if (summary.wasmHash) {
        console.log("  Hash:      ".concat(summary.wasmHash.substring(0, 16), "..."));
    }
    console.log();
    console.log(chalk_1.default.cyan('Target:'));
    console.log("  Network:   ".concat(chalk_1.default.bold(summary.network)));
    console.log("  Operation: ".concat(summary.isUpgrade ? chalk_1.default.yellow('Upgrade') : chalk_1.default.green('New Deploy')));
    if (summary.canisterId) {
        console.log("  Canister:  ".concat(summary.canisterId));
    }
    console.log();
    if (summary.validation.warnings.length > 0) {
        console.log(chalk_1.default.yellow('Warnings:'));
        for (var _i = 0, _b = summary.validation.warnings; _i < _b.length; _i++) {
            var warning = _b[_i];
            console.log(chalk_1.default.yellow("  \u26A0 ".concat(warning)));
        }
        console.log();
    }
    if (summary.validation.errors.length > 0) {
        console.log(chalk_1.default.red('Errors:'));
        for (var _c = 0, _d = summary.validation.errors; _c < _d.length; _c++) {
            var error = _d[_c];
            console.log(chalk_1.default.red("  \u2716 ".concat(error.message)));
        }
        console.log();
    }
}
/**
 * Display deployment result
 */
function displayResult(result) {
    console.log();
    console.log(chalk_1.default.green('✓'), 'Agent deployed successfully!');
    console.log();
    console.log(chalk_1.default.cyan('Canister Info:'));
    console.log("  Canister ID: ".concat(chalk_1.default.bold(result.canister.canisterId)));
    console.log("  Network:     ".concat(result.canister.network));
    console.log("  Agent:       ".concat(result.canister.agentName));
    console.log("  Deployed:    ".concat(result.canister.deployedAt.toISOString()));
    if (result.canister.wasmHash) {
        console.log("  WASM Hash:   ".concat(result.canister.wasmHash.substring(0, 16), "..."));
    }
    if (result.cyclesUsed) {
        console.log("  Cycles Used: ".concat(formatCycles(result.cyclesUsed)));
    }
    if (result.warnings.length > 0) {
        console.log();
        console.log(chalk_1.default.yellow('Warnings:'));
        for (var _i = 0, _a = result.warnings; _i < _a.length; _i++) {
            var warning = _a[_i];
            console.log(chalk_1.default.yellow("  \u26A0 ".concat(warning)));
        }
    }
    console.log();
    console.log(chalk_1.default.cyan('Next steps:'));
    if (result.canister.network === 'local') {
        console.log('  1. Test your agent locally with dfx');
        console.log('  2. Deploy to IC mainnet with', chalk_1.default.bold('--network ic'));
    }
    else {
        console.log('  1. Interact with your canister at:');
        console.log("     ".concat(chalk_1.default.bold("https://".concat(result.canister.canisterId, ".ic0.app"))));
        console.log('  2. Monitor cycles balance with', chalk_1.default.bold('dfx canister status'));
    }
}
/**
 * Prompt for deployment confirmation
 */
function confirmDeployment(network, isUpgrade) {
    return __awaiter(this, void 0, void 0, function () {
        var action, networkLabel, confirmed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    action = isUpgrade ? 'upgrade' : 'deploy';
                    networkLabel = network === 'ic' ? 'IC mainnet' : 'local network';
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'confirmed',
                                message: "".concat(action.charAt(0).toUpperCase() + action.slice(1), " to ").concat(networkLabel, "?"),
                                default: network === 'local',
                            },
                        ])];
                case 1:
                    confirmed = (_a.sent()).confirmed;
                    return [2 /*return*/, confirmed];
            }
        });
    });
}
/**
 * Execute the deploy command
 */
function executeDeploy(wasmPath, options) {
    return __awaiter(this, void 0, void 0, function () {
        var resolvedPath, network, confirmed, spinner, deployOptions, result, action, error_1, message;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    resolvedPath = path.resolve(wasmPath);
                    network = (_a = options.network) !== null && _a !== void 0 ? _a : 'local';
                    // Handle dry-run mode
                    if (options.dryRun) {
                        displayPreview(resolvedPath, options);
                        return [2 /*return*/, null];
                    }
                    if (!!options.yes) return [3 /*break*/, 2];
                    return [4 /*yield*/, confirmDeployment(network, !!options.canisterId)];
                case 1:
                    confirmed = _b.sent();
                    if (!confirmed) {
                        console.log(chalk_1.default.yellow('\nDeployment cancelled.'));
                        return [2 /*return*/, null];
                    }
                    _b.label = 2;
                case 2:
                    spinner = (0, ora_1.default)('Deploying agent to ICP...').start();
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 5, , 6]);
                    deployOptions = {
                        wasmPath: resolvedPath,
                        network: network,
                        canisterId: options.canisterId,
                        skipConfirmation: options.yes,
                    };
                    return [4 /*yield*/, (0, index_js_1.deployAgent)(deployOptions)];
                case 4:
                    result = _b.sent();
                    action = result.isUpgrade ? 'upgraded' : 'deployed';
                    spinner.succeed("Agent '".concat(result.canister.agentName, "' ").concat(action, " successfully!"));
                    displayResult(result);
                    return [2 /*return*/, result];
                case 5:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Deployment failed: ".concat(message));
                    throw error_1;
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Create the deploy command
 */
function deployCommand() {
    var _this = this;
    var command = new commander_1.Command('deploy');
    command
        .description('Deploy agent WASM to ICP canister')
        .argument('<wasm>', 'path to compiled WASM file')
        .option('-n, --network <network>', 'target network (local or ic)', 'local')
        .option('-c, --canister-id <id>', 'existing canister ID (for upgrades)')
        .option('-y, --yes', 'skip confirmation prompts')
        .option('--dry-run', 'show what would be deployed without executing')
        .action(function (wasm, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n🚀 AgentVault Deploy\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeDeploy(wasm, options)];
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
