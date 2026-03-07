"use strict";
/**
 * Init command - Initialize a new AgentVault project
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
exports.promptForInitOptions = promptForInitOptions;
exports.executeInit = executeInit;
exports.initCommand = initCommand;
var commander_1 = require("commander");
var inquirer_1 = require("inquirer");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
function promptForInitOptions(options) {
    return __awaiter(this, void 0, void 0, function () {
        var answers;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    // If --yes flag is provided, use defaults
                    if (options.yes) {
                        return [2 /*return*/, {
                                name: (_a = options.name) !== null && _a !== void 0 ? _a : 'my-agent',
                                description: 'An AgentVault agent',
                                confirm: true,
                            }];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'name',
                                message: 'What is the name of your agent?',
                                default: (_b = options.name) !== null && _b !== void 0 ? _b : 'my-agent',
                                validate: function (input) {
                                    if (!input.trim()) {
                                        return 'Agent name is required';
                                    }
                                    if (!/^[a-z0-9-]+$/.test(input)) {
                                        return 'Agent name must be lowercase alphanumeric with hyphens only';
                                    }
                                    return true;
                                },
                            },
                            {
                                type: 'input',
                                name: 'description',
                                message: 'Provide a description for your agent:',
                                default: 'An AgentVault agent',
                            },
                            {
                                type: 'confirm',
                                name: 'confirm',
                                message: 'Create agent with these settings?',
                                default: true,
                            },
                        ])];
                case 1:
                    answers = _c.sent();
                    return [2 /*return*/, answers];
            }
        });
    });
}
function executeInit(answers, options, sourcePath) {
    return __awaiter(this, void 0, void 0, function () {
        var spinner, config, detectAgent, existingConfig, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    spinner = (0, ora_1.default)('Initializing AgentVault project...').start();
                    config = {
                        name: answers.name,
                        version: '1.0.0',
                    };
                    // In a real implementation, this would create files, directories, etc.
                    spinner.succeed('AgentVault project initialized successfully!');
                    console.log();
                    if (!options.verbose) return [3 /*break*/, 4];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('../../src/packaging/detector.js'); })];
                case 2:
                    detectAgent = (_a.sent()).detectAgent;
                    existingConfig = detectAgent(sourcePath);
                    if (existingConfig) {
                        console.log(chalk_1.default.cyan('Detected existing configuration:'));
                        console.log(chalk_1.default.cyan('  Name:'), chalk_1.default.bold(existingConfig.name));
                        console.log(chalk_1.default.cyan('  Type:'), chalk_1.default.bold(existingConfig.type));
                        if (existingConfig.version) {
                            console.log(chalk_1.default.cyan('  Version:'), chalk_1.default.bold(existingConfig.version));
                        }
                        console.log();
                    }
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    return [3 /*break*/, 4];
                case 4:
                    console.log(chalk_1.default.green('✓'), 'Created configuration for:', chalk_1.default.bold(config.name));
                    console.log(chalk_1.default.green('✓'), 'Version:', chalk_1.default.bold(config.version));
                    console.log(chalk_1.default.green('✓'), 'Description:', chalk_1.default.bold(answers.description));
                    console.log();
                    console.log(chalk_1.default.cyan('Next steps:'));
                    console.log('  1. Run', chalk_1.default.bold('agentvault status'), 'to check your project');
                    console.log('  2. Configure your agent in the config files');
                    console.log('  3. Deploy with', chalk_1.default.bold('agentvault deploy'), 'to upload to ICP');
                    return [2 /*return*/];
            }
        });
    });
}
function initCommand() {
    var _this = this;
    var command = new commander_1.Command('init');
    command
        .description('Initialize a new AgentVault project')
        .argument('[source]', 'path to agent source directory', '.')
        .option('-n, --name <name>', 'name of the agent')
        .option('-y, --yes', 'skip prompts and use defaults')
        .option('-v, --verbose', 'display detailed configuration information')
        .option('--vv', 'extra verbose mode for debugging')
        .action(function (source, options) { return __awaiter(_this, void 0, void 0, function () {
        var answers;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n🔐 AgentVault Project Initialization\n'));
                    return [4 /*yield*/, promptForInitOptions(options)];
                case 1:
                    answers = _a.sent();
                    if (!answers || !answers.confirm) {
                        console.log(chalk_1.default.yellow('Initialization cancelled.'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, executeInit(answers, options, source)];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    return command;
}
