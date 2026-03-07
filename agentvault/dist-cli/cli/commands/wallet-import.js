"use strict";
/**
 * Wallet Import Command
 *
 * Import wallets from an exported backup file.
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
exports.handleImport = handleImport;
var index_js_1 = require("../../src/wallet/index.js");
var inquirer_1 = require("inquirer");
var ora_1 = require("ora");
var chalk_1 = require("chalk");
var fs = require("node:fs");
var crypto = require("node:crypto");
/**
 * Decrypt data with password
 */
function decryptData(encryptedData, password, ivHex, saltHex) {
    var iv = Buffer.from(ivHex || '', 'hex');
    var salt = Buffer.from(saltHex || '', 'hex');
    var key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    var _a = encryptedData.split('.'), encrypted = _a[0], authTagHex = _a[1];
    var authTag = Buffer.from(authTagHex || '', 'hex');
    var decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    var decrypted = decipher.update(encrypted || '', 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
/**
 * Load backup file
 */
function loadBackupFile(filepath) {
    if (!fs.existsSync(filepath)) {
        throw new Error("Backup file not found: ".concat(filepath));
    }
    var data = fs.readFileSync(filepath, 'utf-8');
    try {
        return JSON.parse(data);
    }
    catch (_a) {
        throw new Error('Invalid backup file format');
    }
}
/**
 * Decrypt backup if needed
 */
function loadBackup(filepath) {
    return __awaiter(this, void 0, void 0, function () {
        var loaded, encryptedData, password, decrypted;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    loaded = loadBackupFile(filepath);
                    if (!(loaded.encrypted && loaded.iv && loaded.salt && loaded.encrypted)) return [3 /*break*/, 2];
                    encryptedData = loaded.encrypted;
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'password',
                                name: 'password',
                                message: 'Enter decryption password:',
                            },
                        ])];
                case 1:
                    password = (_a.sent()).password;
                    try {
                        decrypted = decryptData(encryptedData, password, loaded.iv, loaded.salt);
                        return [2 /*return*/, JSON.parse(decrypted)];
                    }
                    catch (_b) {
                        throw new Error('Failed to decrypt backup - incorrect password or corrupted file');
                    }
                    _a.label = 2;
                case 2: return [2 /*return*/, loaded];
            }
        });
    });
}
/**
 * Validate backup structure
 */
function validateBackup(backup) {
    if (!backup.version || !backup.agentId || !backup.wallets || !Array.isArray(backup.wallets)) {
        throw new Error('Invalid backup structure');
    }
    if (backup.wallets.length === 0) {
        throw new Error('Backup contains no wallets');
    }
    for (var _i = 0, _a = backup.wallets; _i < _a.length; _i++) {
        var wallet = _a[_i];
        if (!wallet.id || !wallet.chain || !wallet.address) {
            throw new Error('Invalid wallet data in backup');
        }
    }
}
/**
 * Display backup summary
 */
function displayBackupSummary(backup) {
    console.log();
    console.log(chalk_1.default.cyan('Backup Summary:'));
    console.log("  Version:    ".concat(backup.version));
    console.log("  Agent ID:   ".concat(backup.agentId));
    console.log("  Exported:   ".concat(new Date(backup.exportedAt).toISOString()));
    console.log("  Format:     ".concat(backup.format));
    console.log("  Wallets:    ".concat(backup.wallets.length));
    console.log();
    console.log(chalk_1.default.cyan('Wallets:'));
    for (var _i = 0, _a = backup.wallets; _i < _a.length; _i++) {
        var wallet = _a[_i];
        console.log("  - ".concat(wallet.chain.toUpperCase(), ": ").concat(wallet.address));
    }
}
/**
 * Import wallet from backup
 */
function importWallet(wallet, agentId, resolution) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            try {
                if (wallet.privateKey) {
                    (0, index_js_1.importWalletFromPrivateKey)(agentId, wallet.chain, wallet.privateKey);
                }
                else if (wallet.mnemonic) {
                    (0, index_js_1.importWalletFromSeed)(agentId, wallet.chain, wallet.mnemonic, wallet.seedDerivationPath);
                }
                else {
                    console.log(chalk_1.default.yellow("\u26A0 Skipping ".concat(wallet.id, ": No private key or mnemonic")));
                    return [2 /*return*/, false];
                }
                return [2 /*return*/, true];
            }
            catch (error) {
                if ((_a = error.message) === null || _a === void 0 ? void 0 : _a.includes('already exists')) {
                    if (resolution === 'skip') {
                        console.log(chalk_1.default.yellow("\u2298 Skipping ".concat(wallet.id, ": Already exists")));
                    }
                    else if (resolution === 'overwrite') {
                        console.log(chalk_1.default.yellow("\u26A0 Overwriting ".concat(wallet.id)));
                    }
                }
                else {
                    console.log(chalk_1.default.red("\u2717 Failed to import ".concat(wallet.id, ": ").concat(error.message)));
                }
                return [2 /*return*/, false];
            }
            return [2 /*return*/];
        });
    });
}
/**
 * Handle wallet import command
 */
function handleImport(agentId, filePath) {
    return __awaiter(this, void 0, void 0, function () {
        var inputPath, spinner, backup, confirm_1, resolution, successCount, skipCount, failCount, _i, _a, wallet, result, error_1, message;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📥 Import Wallets\n'));
                    if (!!filePath) return [3 /*break*/, 2];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'path',
                                message: 'Path to backup file:',
                                validate: function (input) { return input.length > 0; },
                            },
                        ])];
                case 1:
                    inputPath = (_b.sent()).path;
                    filePath = inputPath;
                    _b.label = 2;
                case 2:
                    spinner = (0, ora_1.default)('Loading backup file...').start();
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 11, , 12]);
                    return [4 /*yield*/, loadBackup(filePath)];
                case 4:
                    backup = _b.sent();
                    validateBackup(backup);
                    spinner.succeed('Backup loaded');
                    displayBackupSummary(backup);
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'confirm',
                                message: "Import ".concat(backup.wallets.length, " wallet(s) to agent ").concat(agentId, "?"),
                                default: false,
                            },
                        ])];
                case 5:
                    confirm_1 = (_b.sent()).confirm;
                    if (!confirm_1) {
                        console.log(chalk_1.default.yellow('\nImport cancelled'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'resolution',
                                message: 'How to handle existing wallets?',
                                choices: [
                                    { name: 'Skip existing wallets', value: 'skip' },
                                    { name: 'Overwrite existing wallets', value: 'overwrite' },
                                    { name: 'Rename with suffix', value: 'rename' },
                                ],
                                default: 'skip',
                            },
                        ])];
                case 6:
                    resolution = (_b.sent()).resolution;
                    console.log();
                    console.log(chalk_1.default.cyan('Importing wallets...'));
                    successCount = 0;
                    skipCount = 0;
                    failCount = 0;
                    _i = 0, _a = backup.wallets;
                    _b.label = 7;
                case 7:
                    if (!(_i < _a.length)) return [3 /*break*/, 10];
                    wallet = _a[_i];
                    return [4 /*yield*/, importWallet(wallet, agentId, resolution)];
                case 8:
                    result = _b.sent();
                    if (result) {
                        successCount++;
                        console.log(chalk_1.default.green("\u2713 Imported: ".concat(wallet.id, " (").concat(wallet.chain, ")")));
                    }
                    else {
                        failCount++;
                    }
                    _b.label = 9;
                case 9:
                    _i++;
                    return [3 /*break*/, 7];
                case 10:
                    console.log();
                    console.log(chalk_1.default.cyan('Import Summary:'));
                    console.log("  \u2713 Successful: ".concat(successCount));
                    console.log("  \u2298 Skipped:    ".concat(skipCount));
                    console.log("  \u2717 Failed:     ".concat(failCount));
                    if (successCount > 0) {
                        console.log();
                        console.log(chalk_1.default.green('✓'), 'Wallets imported successfully');
                        console.log(chalk_1.default.yellow('⚠'), 'Keep your backup file secure until you verify all wallets work correctly');
                    }
                    return [3 /*break*/, 12];
                case 11:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Failed to import wallets: ".concat(message));
                    return [3 /*break*/, 12];
                case 12: return [2 /*return*/];
            }
        });
    });
}
