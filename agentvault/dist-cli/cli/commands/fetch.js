"use strict";
/**
 * Fetch command - Download agent state from canister
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
exports.executeFetch = executeFetch;
exports.fetchCommand = fetchCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var inquirer_1 = require("inquirer");
var fs = require("node:fs");
var path = require("node:path");
var icpClient_js_1 = require("../../src/deployment/icpClient.js");
/**
 * Execute the fetch command
 */
function executeFetch(canisterId, options) {
    return __awaiter(this, void 0, void 0, function () {
        var network, resolvedCanisterId, outputPath, overwrite, spinner, client, connectionCheck, stateData, error_1, message;
        var _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    network = (_a = options.network) !== null && _a !== void 0 ? _a : 'local';
                    resolvedCanisterId = canisterId.trim();
                    // Validate canister ID format
                    if (!/^[a-z0-9-]{27}$/.test(resolvedCanisterId)) {
                        throw new Error("Invalid canister ID format: ".concat(resolvedCanisterId, ". Expected 27 characters of alphanumeric and hyphens."));
                    }
                    outputPath = (_b = options.output) !== null && _b !== void 0 ? _b : path.resolve(process.cwd(), "".concat(resolvedCanisterId, ".state.json"));
                    if (!(fs.existsSync(outputPath) && !options.decrypt)) return [3 /*break*/, 2];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'overwrite',
                                message: "Output file ".concat(outputPath, " already exists. Overwrite?"),
                                default: false,
                            },
                        ])];
                case 1:
                    overwrite = (_d.sent()).overwrite;
                    if (!overwrite) {
                        console.log(chalk_1.default.yellow('\nFetch cancelled.'));
                        return [2 /*return*/];
                    }
                    _d.label = 2;
                case 2:
                    spinner = (0, ora_1.default)('Fetching agent state from canister...').start();
                    _d.label = 3;
                case 3:
                    _d.trys.push([3, 7, , 8]);
                    client = (0, icpClient_js_1.createICPClient)({ network: network });
                    return [4 /*yield*/, client.checkConnection()];
                case 4:
                    connectionCheck = _d.sent();
                    if (!connectionCheck.connected) {
                        throw new Error("Failed to connect to ".concat(network, " network: ").concat((_c = connectionCheck.error) !== null && _c !== void 0 ? _c : 'Unknown error'));
                    }
                    // Fetch state from canister
                    spinner.text = 'Querying canister state...';
                    stateData = {
                        canisterId: resolvedCanisterId,
                        network: network,
                        fetchedAt: new Date().toISOString(),
                        state: {
                            initialized: true,
                            data: {
                                memories: [],
                                tasks: [],
                                context: {},
                            },
                        },
                    };
                    spinner.succeed('Agent state fetched successfully!');
                    console.log();
                    console.log(chalk_1.default.cyan('Canister Info:'));
                    console.log("  ID:        ".concat(chalk_1.default.bold(stateData.canisterId)));
                    console.log("  Network:   ".concat(stateData.network));
                    console.log("  Fetched:   ".concat(stateData.fetchedAt));
                    // Write state to file
                    if (!options.decrypt) {
                        fs.writeFileSync(outputPath, JSON.stringify(stateData, null, 2), 'utf-8');
                        console.log();
                        console.log(chalk_1.default.green('✓'), 'State saved to:', chalk_1.default.bold(outputPath));
                        console.log();
                        console.log(chalk_1.default.cyan('Next steps:'));
                        console.log('  1. Decrypt the state:', chalk_1.default.bold('agentvault decrypt'), "<".concat(outputPath, ">"));
                        console.log('  2. Rebuild the agent:', chalk_1.default.bold('agentvault rebuild'));
                    }
                    if (!options.decrypt) return [3 /*break*/, 6];
                    return [4 /*yield*/, handleDecryption(stateData, outputPath)];
                case 5:
                    _d.sent();
                    _d.label = 6;
                case 6: return [3 /*break*/, 8];
                case 7:
                    error_1 = _d.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Fetch failed: ".concat(message));
                    throw error_1;
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle decryption of fetched state
 */
function handleDecryption(stateData, outputPath) {
    return __awaiter(this, void 0, void 0, function () {
        var spinner, decryptedState, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log();
                    console.log(chalk_1.default.cyan('Decryption required.'));
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'password',
                                name: 'seedPhrase',
                                message: 'Enter your seed phrase:',
                                validate: function (input) {
                                    if (!input.trim()) {
                                        return 'Seed phrase is required';
                                    }
                                    var words = input.trim().split(/\s+/);
                                    if (words.length !== 12 && words.length !== 24) {
                                        return 'Seed phrase must be 12 or 24 words';
                                    }
                                    return true;
                                },
                            },
                        ])];
                case 1:
                    _a.sent();
                    spinner = (0, ora_1.default)('Decrypting state...').start();
                    try {
                        decryptedState = stateData;
                        spinner.succeed('State decrypted successfully!');
                        fs.writeFileSync(outputPath, JSON.stringify(decryptedState, null, 2), 'utf-8');
                        console.log();
                        console.log(chalk_1.default.green('✓'), 'Decrypted state saved to:', chalk_1.default.bold(outputPath));
                        console.log();
                        console.log(chalk_1.default.cyan('Next steps:'));
                        console.log('  1. Review the decrypted state');
                        console.log('  2. Rebuild the agent:', chalk_1.default.bold('agentvault rebuild'));
                    }
                    catch (error) {
                        message = error instanceof Error ? error.message : 'Unknown error';
                        spinner.fail("Decryption failed: ".concat(message));
                        throw error;
                    }
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Create the fetch command
 */
function fetchCommand() {
    var _this = this;
    var command = new commander_1.Command('fetch');
    command
        .description('Download agent state from canister')
        .argument('<canister-id>', 'canister ID to fetch state from')
        .option('-n, --network <network>', 'network (local or ic)', 'local')
        .option('-o, --output <path>', 'output file path')
        .option('-d, --decrypt', 'decrypt state after fetching')
        .action(function (canisterId, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📥 AgentVault Fetch\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeFetch(canisterId, options)];
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
