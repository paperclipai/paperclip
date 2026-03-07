"use strict";
/**
 * Wallet Export Command
 *
 * Export all wallets for an agent to a backup file.
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
exports.handleExport = handleExport;
var index_js_1 = require("../../src/wallet/index.js");
var inquirer_1 = require("inquirer");
var ora_1 = require("ora");
var chalk_1 = require("chalk");
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
/**
 * Create backup directory
 */
function ensureBackupDir() {
    var backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
}
/**
 * Generate backup filename
 */
function generateBackupFilename(agentId, format) {
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    var ext = format === 'encrypted' ? 'backup' : 'json';
    return "agentvault-backup-".concat(agentId, "-").concat(timestamp, ".").concat(ext);
}
/**
 * Display wallet summary
 */
function displayWalletSummary(wallets) {
    console.log();
    console.log(chalk_1.default.cyan('Wallets to export:'));
    for (var _i = 0, wallets_1 = wallets; _i < wallets_1.length; _i++) {
        var wallet = wallets_1[_i];
        console.log("  - ".concat(wallet.chain.toUpperCase(), ": ").concat(wallet.address));
    }
    console.log("  Total: ".concat(wallets.length, " wallet(s)"));
}
/**
 * Encrypt data with password
 */
function encryptData(data, password) {
    var salt = crypto.randomBytes(16);
    var iv = crypto.randomBytes(16);
    var key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
    var cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    var encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    var authTag = cipher.getAuthTag();
    var encryptedWithAuth = "".concat(encrypted, ".").concat(authTag.toString('hex'));
    return {
        encrypted: encryptedWithAuth,
        iv: iv.toString('hex'),
        salt: salt.toString('hex'),
    };
}
/**
 * Handle wallet export command
 */
function handleExport(agentId_1) {
    return __awaiter(this, arguments, void 0, function (agentId, options) {
        var walletIds, wallets, format, backupDir, filename, filepath, confirm, spinner, backup, data, password, _a, encrypted, iv, salt, error_1, message;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📦 Export Wallets\n'));
                    walletIds = (0, index_js_1.listAgentWallets)(agentId);
                    if (walletIds.length === 0) {
                        console.log(chalk_1.default.yellow('No wallets found for this agent'));
                        return [2 /*return*/];
                    }
                    wallets = walletIds.map(function (id) { return (0, index_js_1.getWallet)(agentId, id); }).filter(Boolean);
                    displayWalletSummary(wallets);
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'format',
                                message: 'Select export format:',
                                choices: [
                                    { name: 'JSON (plain text, easy to read)', value: 'json' },
                                    { name: 'Encrypted (password-protected)', value: 'encrypted' },
                                ],
                                default: options.format || 'json',
                            },
                        ])];
                case 1:
                    format = (_b.sent()).format;
                    backupDir = ensureBackupDir();
                    filename = options.output || generateBackupFilename(agentId, format);
                    filepath = path.join(backupDir, filename);
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'confirm',
                                message: "Export ".concat(wallets.length, " wallet(s) to ").concat(filepath, "?"),
                                default: true,
                            },
                        ])];
                case 2:
                    confirm = (_b.sent()).confirm;
                    if (!confirm) {
                        console.log(chalk_1.default.yellow('\nExport cancelled'));
                        return [2 /*return*/];
                    }
                    spinner = (0, ora_1.default)('Exporting wallets...').start();
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 6, , 7]);
                    backup = {
                        version: '1.0',
                        agentId: agentId,
                        exportedAt: Date.now(),
                        format: format,
                        wallets: wallets,
                    };
                    data = JSON.stringify(backup, null, 2);
                    if (!(format === 'encrypted')) return [3 /*break*/, 5];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'password',
                                name: 'password',
                                message: 'Enter encryption password:',
                                validate: function (input) { return input.length >= 8; },
                            },
                        ])];
                case 4:
                    password = (_b.sent()).password;
                    _a = encryptData(data, password), encrypted = _a.encrypted, iv = _a.iv, salt = _a.salt;
                    backup.encrypted = true;
                    backup.iv = iv;
                    backup.salt = salt;
                    data = JSON.stringify(backup, null, 2);
                    data = JSON.stringify({ encrypted: encrypted });
                    _b.label = 5;
                case 5:
                    fs.writeFileSync(filepath, data, 'utf-8');
                    spinner.succeed('Wallets exported successfully');
                    console.log();
                    console.log(chalk_1.default.green('✓'), "Export saved to: ".concat(filepath));
                    console.log("  Size: ".concat((data.length / 1024).toFixed(2), " KB"));
                    if (format === 'json') {
                        console.log();
                        console.log(chalk_1.default.yellow('⚠'), 'This file contains private keys - keep it secure!');
                    }
                    return [3 /*break*/, 7];
                case 6:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Failed to export wallets: ".concat(message));
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    });
}
