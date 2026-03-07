"use strict";
/**
 * Wallet Command
 *
 * Main wallet management command for AgentVault.
 * Provides CLI interface for wallet operations.
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
exports.walletCommand = walletCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var inquirer_1 = require("inquirer");
var ora_1 = require("ora");
var index_js_1 = require("../../src/wallet/index.js");
var cketh_provider_js_1 = require("../../src/wallet/providers/cketh-provider.js");
/**
 * Create wallet command
 */
function walletCommand() {
    var _this = this;
    var command = new commander_1.Command('wallet');
    command
        .description('Manage agent wallets (ckETH, Polkadot, Solana)')
        .argument('<subcommand>', 'wallet subcommand to execute')
        .option('-a, --agent-id <id>', 'agent ID (required)')
        .option('-f, --file <path>', 'file path (for import)')
        .action(function (subcommand, options) { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, executeWalletCommand(subcommand, options)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    return command;
}
/**
 * Execute wallet subcommand
 */
function executeWalletCommand(subcommand, options) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!options.agentId) {
                        console.error(chalk_1.default.red('Error: --agent-id is required'));
                        process.exit(1);
                    }
                    _a = subcommand;
                    switch (_a) {
                        case 'connect': return [3 /*break*/, 1];
                        case 'disconnect': return [3 /*break*/, 3];
                        case 'balance': return [3 /*break*/, 5];
                        case 'send': return [3 /*break*/, 7];
                        case 'list': return [3 /*break*/, 9];
                        case 'sign': return [3 /*break*/, 11];
                        case 'history': return [3 /*break*/, 13];
                        case 'export': return [3 /*break*/, 15];
                        case 'import': return [3 /*break*/, 17];
                    }
                    return [3 /*break*/, 19];
                case 1: return [4 /*yield*/, handleConnect(options.agentId)];
                case 2:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 3: return [4 /*yield*/, handleDisconnect(options.agentId)];
                case 4:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 5: return [4 /*yield*/, handleBalance(options.agentId)];
                case 6:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 7: return [4 /*yield*/, handleSend(options.agentId)];
                case 8:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 9: return [4 /*yield*/, handleList(options.agentId)];
                case 10:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 11: return [4 /*yield*/, handleSign(options.agentId)];
                case 12:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 13: return [4 /*yield*/, handleHistory(options.agentId)];
                case 14:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 15: return [4 /*yield*/, handleExport(options.agentId)];
                case 16:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 17: return [4 /*yield*/, handleImport(options.agentId, options.file)];
                case 18:
                    _b.sent();
                    return [3 /*break*/, 20];
                case 19:
                    console.error(chalk_1.default.red("Unknown subcommand: ".concat(subcommand)));
                    console.log();
                    console.log(chalk_1.default.cyan('Available subcommands:'));
                    console.log('  connect    - Connect or create a wallet');
                    console.log('  disconnect - Disconnect wallet');
                    console.log('  balance   - Check wallet balance');
                    console.log('  send      - Send transaction');
                    console.log('  list      - List all wallets');
                    console.log('  sign      - Sign transaction');
                    console.log('  history   - Get transaction history');
                    console.log('  export    - Export wallets to backup file');
                    console.log('  import    - Import wallets from backup file');
                    process.exit(1);
                    _b.label = 20;
                case 20: return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet connect/create
 */
function handleConnect(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var method, chain, wallet, _a, seedPhrase, derivationPath, privateKey, spinner, provider, balance, error_1, message;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n🔑 Wallet Connect\n'));
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'method',
                                message: 'How would you like to create the wallet?',
                                choices: [
                                    { name: 'generate', value: 'Generate new wallet (recommended)' },
                                    { name: 'seed', value: 'Import from seed phrase' },
                                    { name: 'private-key', value: 'Import from private key' },
                                ],
                            },
                        ])];
                case 1:
                    method = (_b.sent()).method;
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'chain',
                                message: 'Which blockchain?',
                                choices: [
                                    { name: 'cketh', value: 'ckETH (Ethereum on ICP)' },
                                    { name: 'polkadot', value: 'Polkadot' },
                                    { name: 'solana', value: 'Solana' },
                                ],
                            },
                        ])];
                case 2:
                    chain = (_b.sent()).chain;
                    if (!(method === 'generate')) return [3 /*break*/, 3];
                    wallet = (0, index_js_1.generateWallet)(agentId, chain);
                    console.log(chalk_1.default.green('✓'), 'New wallet generated');
                    return [3 /*break*/, 7];
                case 3:
                    if (!(method === 'seed')) return [3 /*break*/, 5];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'password',
                                name: 'seedPhrase',
                                message: 'Enter seed phrase (BIP39):',
                                validate: function (input) { return input.split(' ').length >= 12; },
                            },
                            {
                                type: 'input',
                                name: 'derivationPath',
                                message: 'Derivation path (optional):',
                                default: '',
                            },
                        ])];
                case 4:
                    _a = _b.sent(), seedPhrase = _a.seedPhrase, derivationPath = _a.derivationPath;
                    wallet = (0, index_js_1.importWalletFromSeed)(agentId, chain, seedPhrase, derivationPath || undefined);
                    console.log(chalk_1.default.green('✓'), 'Wallet imported from seed phrase');
                    return [3 /*break*/, 7];
                case 5:
                    if (!(method === 'private-key')) return [3 /*break*/, 7];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'password',
                                name: 'privateKey',
                                message: 'Enter private key (hex):',
                                validate: function (input) { return /^0x[0-9a-fA-F]{64}$/.test(input); },
                            },
                        ])];
                case 6:
                    privateKey = (_b.sent()).privateKey;
                    wallet = (0, index_js_1.importWalletFromPrivateKey)(agentId, chain, privateKey);
                    console.log(chalk_1.default.green('✓'), 'Wallet imported from private key');
                    _b.label = 7;
                case 7:
                    // Display wallet info
                    console.log();
                    console.log(chalk_1.default.cyan('Wallet Info:'));
                    console.log("  ID:       ".concat(wallet.id));
                    console.log("  Chain:    ".concat(wallet.chain));
                    console.log("  Address:  ".concat(wallet.address));
                    console.log("  Created:  ".concat(new Date(wallet.createdAt).toISOString()));
                    spinner = (0, ora_1.default)('Testing provider connection...').start();
                    _b.label = 8;
                case 8:
                    _b.trys.push([8, 11, , 12]);
                    provider = new cketh_provider_js_1.CkEthProvider({
                        chain: chain,
                        rpcUrl: cketh_provider_js_1.CkEthProvider.getDefaultRpcUrl(),
                        isTestnet: false,
                    });
                    return [4 /*yield*/, provider.connect()];
                case 9:
                    _b.sent();
                    return [4 /*yield*/, provider.getBalance(wallet.address)];
                case 10:
                    balance = _b.sent();
                    spinner.succeed('Provider connected');
                    console.log();
                    console.log(chalk_1.default.cyan('Balance:'));
                    console.log("  ".concat(balance.amount, " ").concat(balance.denomination));
                    return [3 /*break*/, 12];
                case 11:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Provider connection failed: ".concat(message));
                    return [3 /*break*/, 12];
                case 12: return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet disconnect
 */
function handleDisconnect(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var wallets, walletId;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    wallets = (0, index_js_1.listAgentWallets)(agentId);
                    if (wallets.length === 0) {
                        console.log(chalk_1.default.yellow('No wallets found for this agent'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'walletId',
                                message: 'Select wallet to disconnect:',
                                choices: wallets,
                            },
                        ])];
                case 1:
                    walletId = (_a.sent()).walletId;
                    (0, index_js_1.removeWallet)(agentId, walletId);
                    console.log(chalk_1.default.green('✓'), 'Wallet disconnected');
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet balance query
 */
function handleBalance(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var wallets, walletId, wallet, spinner, provider, balance, error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    wallets = (0, index_js_1.listAgentWallets)(agentId);
                    if (wallets.length === 0) {
                        console.log(chalk_1.default.yellow('No wallets found for this agent'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'walletId',
                                message: 'Select wallet:',
                                choices: wallets,
                            },
                        ])];
                case 1:
                    walletId = (_a.sent()).walletId;
                    wallet = (0, index_js_1.getWallet)(agentId, walletId);
                    if (!wallet) {
                        console.log(chalk_1.default.red('Wallet not found'));
                        return [2 /*return*/];
                    }
                    spinner = (0, ora_1.default)('Fetching balance...').start();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 5, , 6]);
                    provider = new cketh_provider_js_1.CkEthProvider({
                        chain: wallet.chain,
                        rpcUrl: cketh_provider_js_1.CkEthProvider.getDefaultRpcUrl(),
                        isTestnet: false,
                    });
                    return [4 /*yield*/, provider.connect()];
                case 3:
                    _a.sent();
                    return [4 /*yield*/, provider.getBalance(wallet.address)];
                case 4:
                    balance = _a.sent();
                    spinner.succeed('Balance fetched');
                    console.log();
                    console.log(chalk_1.default.cyan('Balance:'));
                    console.log("  Address:  ".concat(wallet.address));
                    console.log("  Amount:  ".concat(balance.amount, " ").concat(balance.denomination));
                    console.log("  Block:   ".concat(balance.blockNumber));
                    return [3 /*break*/, 6];
                case 5:
                    error_2 = _a.sent();
                    message = error_2 instanceof Error ? error_2.message : 'Unknown error';
                    spinner.fail("Failed to fetch balance: ".concat(message));
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet send transaction
 */
function handleSend(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var wallets, walletId, wallet, _a, toAddress, amount, confirm, spinner, provider, tx, error_3, message;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    wallets = (0, index_js_1.listAgentWallets)(agentId);
                    if (wallets.length === 0) {
                        console.log(chalk_1.default.yellow('No wallets found for this agent'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'walletId',
                                message: 'Select wallet:',
                                choices: wallets,
                            },
                        ])];
                case 1:
                    walletId = (_b.sent()).walletId;
                    wallet = (0, index_js_1.getWallet)(agentId, walletId);
                    if (!wallet) {
                        console.log(chalk_1.default.red('Wallet not found'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'toAddress',
                                message: 'Recipient address:',
                                validate: function (input) { return input.length > 0; },
                            },
                            {
                                type: 'input',
                                name: 'amount',
                                message: 'Amount to send:',
                                validate: function (input) { return parseFloat(input) > 0; },
                            },
                        ])];
                case 2:
                    _a = _b.sent(), toAddress = _a.toAddress, amount = _a.amount;
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'confirm',
                                name: 'confirm',
                                message: "Send ".concat(amount, " to ").concat(toAddress, "?"),
                                default: false,
                            },
                        ])];
                case 3:
                    confirm = (_b.sent()).confirm;
                    if (!confirm) {
                        console.log(chalk_1.default.yellow('\nTransaction cancelled'));
                        return [2 /*return*/];
                    }
                    spinner = (0, ora_1.default)('Sending transaction...').start();
                    _b.label = 4;
                case 4:
                    _b.trys.push([4, 7, , 8]);
                    provider = new cketh_provider_js_1.CkEthProvider({
                        chain: wallet.chain,
                        rpcUrl: cketh_provider_js_1.CkEthProvider.getDefaultRpcUrl(),
                        isTestnet: false,
                    });
                    return [4 /*yield*/, provider.connect()];
                case 5:
                    _b.sent();
                    return [4 /*yield*/, provider.sendTransaction(wallet.address, {
                            to: toAddress,
                            amount: amount,
                            chain: wallet.chain,
                        })];
                case 6:
                    tx = _b.sent();
                    spinner.succeed('Transaction sent');
                    console.log();
                    console.log(chalk_1.default.cyan('Transaction:'));
                    console.log("  Hash:     ".concat(tx.hash));
                    console.log("  From:     ".concat(tx.from));
                    console.log("  To:       ".concat(tx.to));
                    console.log("  Amount:   ".concat(tx.amount));
                    console.log("  Status:   ".concat(tx.status));
                    return [3 /*break*/, 8];
                case 7:
                    error_3 = _b.sent();
                    message = error_3 instanceof Error ? error_3.message : 'Unknown error';
                    spinner.fail("Failed to send transaction: ".concat(message));
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet list
 */
function handleList(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var wallets, _i, wallets_1, walletId, wallet;
        return __generator(this, function (_a) {
            wallets = (0, index_js_1.listAgentWallets)(agentId);
            if (wallets.length === 0) {
                console.log(chalk_1.default.yellow('No wallets found for this agent'));
                return [2 /*return*/];
            }
            console.log();
            console.log(chalk_1.default.cyan("Wallets for agent: ".concat(agentId)));
            console.log();
            for (_i = 0, wallets_1 = wallets; _i < wallets_1.length; _i++) {
                walletId = wallets_1[_i];
                wallet = (0, index_js_1.getWallet)(agentId, walletId);
                if (wallet) {
                    console.log(chalk_1.default.white(walletId));
                    console.log("  Chain:    ".concat(wallet.chain));
                    console.log("  Address:  ".concat(wallet.address));
                    console.log("  Created:  ".concat(new Date(wallet.createdAt).toISOString()));
                    console.log();
                }
            }
            return [2 /*return*/];
        });
    });
}
/**
 * Handle wallet sign
 */
function handleSign(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var signHandler;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('./wallet-sign.js'); })];
                case 1:
                    signHandler = (_a.sent()).handleSign;
                    return [4 /*yield*/, signHandler(agentId)];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet history
 */
function handleHistory(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var historyHandler;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('./wallet-history.js'); })];
                case 1:
                    historyHandler = (_a.sent()).handleHistory;
                    return [4 /*yield*/, historyHandler(agentId)];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet export
 */
function handleExport(agentId) {
    return __awaiter(this, void 0, void 0, function () {
        var exportHandler;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('./wallet-export.js'); })];
                case 1:
                    exportHandler = (_a.sent()).handleExport;
                    return [4 /*yield*/, exportHandler(agentId)];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Handle wallet import
 */
function handleImport(agentId, filePath) {
    return __awaiter(this, void 0, void 0, function () {
        var importHandler;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('./wallet-import.js'); })];
                case 1:
                    importHandler = (_a.sent()).handleImport;
                    return [4 /*yield*/, importHandler(agentId, filePath || '')];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
