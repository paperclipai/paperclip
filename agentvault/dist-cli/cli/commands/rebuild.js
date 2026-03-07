"use strict";
/**
 * Rebuild command - Rebuild local agent from canister state
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
exports.executeRebuild = executeRebuild;
exports.rebuildCommand = rebuildCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var inquirer_1 = require("inquirer");
var fs = require("node:fs");
var path = require("node:path");
var compiler_js_1 = require("../../src/packaging/compiler.js");
function executeRebuild(stateFile, options) {
    return __awaiter(this, void 0, void 0, function () {
        var resolvedPath, spinner, content, state, message, confirm_1, compileSpinner, compileOptions, result, error_1, message;
        var _a, _b, _c, _d, _e, _f;
        return __generator(this, function (_g) {
            switch (_g.label) {
                case 0:
                    resolvedPath = path.resolve(stateFile);
                    // Validate state file exists
                    if (!fs.existsSync(resolvedPath)) {
                        throw new Error("State file not found: ".concat(resolvedPath));
                    }
                    spinner = (0, ora_1.default)('Reading agent state...').start();
                    try {
                        content = fs.readFileSync(resolvedPath, 'utf-8');
                        state = JSON.parse(content);
                        spinner.succeed('Agent state loaded successfully!');
                        console.log();
                        console.log(chalk_1.default.cyan('Agent Configuration:'));
                        console.log("  Name:        ".concat(chalk_1.default.bold(state.config.name)));
                        console.log("  Type:        ".concat(state.config.type));
                        console.log("  Source:      ".concat(state.config.sourcePath));
                        console.log("  Version:     ".concat((_a = state.config.version) !== null && _a !== void 0 ? _a : 'N/A'));
                        console.log();
                        console.log(chalk_1.default.cyan('State Info:'));
                        console.log("  Memories:    ".concat(((_b = state.memories) === null || _b === void 0 ? void 0 : _b.length) || 0));
                        console.log("  Tasks:       ".concat(((_c = state.tasks) === null || _c === void 0 ? void 0 : _c.length) || 0));
                        console.log("  Context:     ".concat(Object.keys(state.context || {}).length, " entries"));
                        console.log();
                        console.log(chalk_1.default.yellow('Agent tasks can be resumed'));
                        console.log('Context is preserved');
                        spinner.stop();
                        return [2 /*return*/];
                    }
                    catch (error) {
                        spinner.stop();
                        message = error instanceof Error ? error.message : 'Unknown error';
                        throw new Error("Failed to parse state file: ".concat(message));
                    }
                    // Check if source directory exists
                    if (!fs.existsSync(state.config.sourcePath)) {
                        console.log();
                        console.log(chalk_1.default.yellow('⚠'), 'Source directory not found:', state.config.sourcePath);
                        console.log();
                        console.log('You need to provide a source code to rebuild agent.');
                        console.log('Options:');
                        console.log('  1. Clone original repository');
                        console.log('  2. Provide a new source directory');
                        spinner.stop();
                        return [2 /*return*/];
                    }
                    if (!!options.force) return [3 /*break*/, 2];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'confirm',
                                message: 'Rebuild agent with this configuration?',
                                default: true,
                            },
                        ])];
                case 1:
                    confirm_1 = (_g.sent()).confirm;
                    if (!confirm_1) {
                        console.log(chalk_1.default.yellow('\nRebuild cancelled.'));
                        spinner.stop();
                        return [2 /*return*/];
                    }
                    _g.label = 2;
                case 2:
                    // Skip compilation if requested
                    if (options.skipCompile) {
                        console.log();
                        console.log(chalk_1.default.green('✓'), 'Rebuild skipped compilation step.');
                        console.log();
                        console.log(chalk_1.default.cyan('Agent state ready for use'));
                        console.log('Memories can be restored');
                        spinner.stop();
                        return [2 /*return*/];
                    }
                    compileSpinner = (0, ora_1.default)('Compiling agent to WASM...').start();
                    _g.label = 3;
                case 3:
                    _g.trys.push([3, 5, , 6]);
                    compileOptions = {
                        sourcePath: state.config.sourcePath,
                        target: (_d = options.target) !== null && _d !== void 0 ? _d : 'wasmedge',
                        debug: (_e = options.debug) !== null && _e !== void 0 ? _e : false,
                        optimize: (_f = options.optimize) !== null && _f !== void 0 ? _f : 2,
                    };
                    return [4 /*yield*/, (0, compiler_js_1.compileToWasm)(state.config, compileOptions, path.dirname(resolvedPath))];
                case 4:
                    result = _g.sent();
                    compileSpinner.succeed("Agent compiled successfully!");
                    console.log();
                    console.log(chalk_1.default.cyan('Output Files:'));
                    console.log("  WASM:  ".concat(result.wasmPath));
                    console.log("  WAT:   ".concat(result.watPath));
                    console.log("  State: ".concat(result.statePath));
                    console.log();
                    console.log(chalk_1.default.green('✓'), 'Agent rebuilt successfully!');
                    console.log();
                    console.log(chalk_1.default.cyan('Next steps:'));
                    console.log('  1. Test rebuilt agent locally');
                    console.log('  2. Deploy with:', chalk_1.default.bold('agentvault deploy'));
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _g.sent();
                    compileSpinner.fail('Compilation failed');
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Rebuild failed: ".concat(message));
                    throw error_1;
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Create rebuild command
 */
function rebuildCommand() {
    var _this = this;
    var command = new commander_1.Command('rebuild');
    command
        .description('Rebuild local agent from canister state')
        .argument('<state-file>', 'agent state file (JSON)')
        .option('-o, --output <path>', 'output directory for rebuilt agent')
        .option('-f, --force', 'skip confirmation prompts')
        .option('--skip-compile', 'skip WASM compilation')
        .option('-t, --target <target>', 'compilation target (wasmedge|motoko|pure-wasm)', 'wasmedge')
        .option('--debug', 'enable debugging features')
        .option('--optimize <level>', 'optimization level (0-3)', '2')
        .action(function (stateFile, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n🔧 AgentVault Rebuild\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeRebuild(stateFile, options)];
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
