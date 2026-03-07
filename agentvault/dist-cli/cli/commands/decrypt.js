"use strict";
/**
 * Decrypt command - Decrypt agent state using seed phrase
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
exports.executeDecrypt = executeDecrypt;
exports.decryptCommand = decryptCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var inquirer_1 = require("inquirer");
var fs = require("node:fs");
var path = require("node:path");
var vetkeys_js_1 = require("../../src/security/vetkeys.js");
/**
 * Execute decrypt command
 */
function executeDecrypt(filePath, options) {
    return __awaiter(this, void 0, void 0, function () {
        var resolvedPath, content, data, seedPhrase, spinner, encrypted, decrypted, outputPath, error_1, message;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    resolvedPath = path.resolve(filePath);
                    // Validate input file exists
                    if (!fs.existsSync(resolvedPath)) {
                        throw new Error("File not found: ".concat(resolvedPath));
                    }
                    content = fs.readFileSync(resolvedPath, 'utf-8');
                    try {
                        data = JSON.parse(content);
                    }
                    catch (_c) {
                        throw new Error('Invalid JSON format');
                    }
                    // Check if already decrypted
                    if (!('encrypted' in data && data.encrypted)) {
                        console.log(chalk_1.default.yellow('State is already decrypted.'));
                        return [2 /*return*/];
                    }
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
                    seedPhrase = (_b.sent()).seedPhrase;
                    spinner = (0, ora_1.default)('Decrypting agent state...').start();
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    encrypted = data;
                    return [4 /*yield*/, (0, vetkeys_js_1.decryptJSON)(encrypted, seedPhrase)];
                case 3:
                    decrypted = _b.sent();
                    spinner.succeed('State decrypted successfully!');
                    console.log();
                    console.log(chalk_1.default.cyan('Decryption Info:'));
                    console.log("  Algorithm:      ".concat(encrypted.algorithm));
                    console.log("  Encrypted at:   ".concat(encrypted.encryptedAt));
                    outputPath = (_a = options.output) !== null && _a !== void 0 ? _a : resolvedPath.replace('.json', '.decrypted.json');
                    // Write decrypted state
                    fs.writeFileSync(outputPath, JSON.stringify(decrypted, null, 2), 'utf-8');
                    console.log();
                    console.log(chalk_1.default.green('✓'), 'Decrypted state saved to:', chalk_1.default.bold(outputPath));
                    console.log();
                    console.log(chalk_1.default.cyan('Next steps:'));
                    console.log('  1. Review the decrypted state');
                    console.log('  2. Rebuild agent:', chalk_1.default.bold('agentvault rebuild'));
                    return [3 /*break*/, 5];
                case 4:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Decryption failed: ".concat(message));
                    throw error_1;
                case 5: return [2 /*return*/];
            }
        });
    });
}
/**
 * Create decrypt command
 */
function decryptCommand() {
    var _this = this;
    var command = new commander_1.Command('decrypt');
    command
        .description('Decrypt agent state using seed phrase')
        .argument('<file>', 'encrypted state file to decrypt')
        .option('-o, --output <path>', 'output file path')
        .action(function (file, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n🔓 AgentVault Decrypt\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executeDecrypt(file, options)];
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
