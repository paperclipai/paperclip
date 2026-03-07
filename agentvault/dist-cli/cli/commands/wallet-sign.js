"use strict";
/**
 * Wallet Sign Command
 *
 * Sign transactions with wallet's private key.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.handleSign = handleSign;
var cketh_provider_js_1 = require("../../src/wallet/providers/cketh-provider.js");
var polkadot_provider_js_1 = require("../../src/wallet/providers/polkadot-provider.js");
var solana_provider_js_1 = require("../../src/wallet/providers/solana-provider.js");
var index_js_1 = require("../../src/wallet/index.js");
var inquirer_1 = require("inquirer");
var ora_1 = require("ora");
var chalk_1 = require("chalk");
var fs = require("node:fs");
var path = require("node:path");
/**
 * Format address for display
 */
function formatAddress(address, length) {
    if (length === void 0) { length = 10; }
    if (address.length <= length * 2)
        return address;
    return "".concat(address.slice(0, length), "...").concat(address.slice(-length));
}
/**
 * Create provider for chain
 */
function createProvider(chain) {
    switch (chain) {
        case 'cketh':
            return new cketh_provider_js_1.CkEthProvider({
                chain: 'cketh',
                rpcUrl: cketh_provider_js_1.CkEthProvider.getDefaultRpcUrl(),
                isTestnet: false,
            });
        case 'polkadot':
            return new polkadot_provider_js_1.PolkadotProvider({
                chain: 'polkadot',
                rpcUrl: 'wss://rpc.polkadot.io',
                isTestnet: false,
            });
        case 'solana':
            return new solana_provider_js_1.SolanaProvider({
                chain: 'solana',
                rpcUrl: 'https://api.mainnet-beta.solana.com',
                isTestnet: false,
            });
        default:
            throw new Error("Unsupported chain: ".concat(chain));
    }
}
/**
 * Display signed transaction
 */
function displaySignedTransaction(signedTx, chain) {
    console.log();
    console.log(chalk_1.default.cyan('Signed Transaction:'));
    console.log("  Chain:       ".concat(chain.toUpperCase()));
    console.log("  Hash:        ".concat(signedTx.txHash));
    console.log("  Signature:   ".concat(signedTx.signature || 'Included in tx'));
    console.log("  Recipient:   ".concat(formatAddress(signedTx.request.to)));
    console.log("  Amount:      ".concat(signedTx.request.amount));
}
/**
 * Save signed transaction to file
 */
function saveSignedTransaction(signedTx, agentId, chain) {
    var outputDir = path.join(process.cwd(), '.agentvault', 'signed-txs');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    var timestamp = Date.now();
    var filename = "signed-tx-".concat(agentId, "-").concat(chain, "-").concat(timestamp, ".json");
    var filepath = path.join(outputDir, filename);
    var data = JSON.stringify(signedTx, null, 2);
    fs.writeFileSync(filepath, data, 'utf-8');
    return filepath;
}
/**
 * Handle wallet sign command
 */
function handleSign(agentId_1) {
    return __awaiter(this, arguments, void 0, function (agentId, options) {
        var wallets, walletId, wallet, chain, txDetails, gasDetails, memo, confirm, spinner, provider, txRequest, signedTx, _a, filepath, error_1, message;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n✍️  Sign Transaction\n'));
                    wallets = (0, index_js_1.listAgentWallets)(agentId);
                    if (wallets.length === 0) {
                        console.log(chalk_1.default.yellow('No wallets found for this agent'));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'list',
                                name: 'walletId',
                                message: 'Select wallet to sign with:',
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
                    chain = wallet.chain;
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'to',
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
                    txDetails = _b.sent();
                    if (!(chain === 'cketh' || chain === 'polkadot')) return [3 /*break*/, 4];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'gasPrice',
                                message: 'Gas price (optional, leave empty for auto):',
                                default: '',
                            },
                            {
                                type: 'input',
                                name: 'gasLimit',
                                message: 'Gas limit (optional, leave empty for auto):',
                                default: '',
                            },
                        ])];
                case 3:
                    gasDetails = _b.sent();
                    if (gasDetails.gasPrice)
                        txDetails.gasPrice = gasDetails.gasPrice;
                    if (gasDetails.gasLimit)
                        txDetails.gasLimit = gasDetails.gasLimit;
                    return [3 /*break*/, 6];
                case 4:
                    if (!(chain === 'solana')) return [3 /*break*/, 6];
                    return [4 /*yield*/, inquirer_1.default.prompt([
                            {
                                type: 'input',
                                name: 'memo',
                                message: 'Memo (optional):',
                                default: '',
                            },
                        ])];
                case 5:
                    memo = (_b.sent()).memo;
                    if (memo)
                        txDetails.memo = memo;
                    _b.label = 6;
                case 6: return [4 /*yield*/, inquirer_1.default.prompt([
                        {
                            type: 'confirm',
                            name: 'confirm',
                            message: "Sign transaction to send ".concat(txDetails.amount, " to ").concat(formatAddress(txDetails.to), "?"),
                            default: false,
                        },
                    ])];
                case 7:
                    confirm = (_b.sent()).confirm;
                    if (!confirm) {
                        console.log(chalk_1.default.yellow('\nTransaction signing cancelled'));
                        return [2 /*return*/];
                    }
                    spinner = (0, ora_1.default)('Signing transaction...').start();
                    _b.label = 8;
                case 8:
                    _b.trys.push([8, 13, , 14]);
                    provider = createProvider(chain);
                    return [4 /*yield*/, provider.connect()];
                case 9:
                    _b.sent();
                    if (!wallet.privateKey) {
                        throw new Error('Wallet has no private key available for signing');
                    }
                    txRequest = __assign(__assign(__assign({ to: txDetails.to, amount: txDetails.amount, chain: chain }, (txDetails.gasPrice && { gasPrice: txDetails.gasPrice })), (txDetails.gasLimit && { gasLimit: txDetails.gasLimit })), (txDetails.memo && { memo: txDetails.memo }));
                    return [4 /*yield*/, provider.signTransaction(txRequest, wallet.privateKey)];
                case 10:
                    signedTx = _b.sent();
                    spinner.succeed('Transaction signed');
                    if (options.json) {
                        console.log(JSON.stringify(signedTx, null, 2));
                    }
                    else {
                        displaySignedTransaction(signedTx, chain);
                    }
                    _a = options.output;
                    if (_a) return [3 /*break*/, 12];
                    return [4 /*yield*/, shouldSaveFile()];
                case 11:
                    _a = (_b.sent());
                    _b.label = 12;
                case 12:
                    if (_a) {
                        filepath = saveSignedTransaction(signedTx, agentId, chain);
                        console.log();
                        console.log(chalk_1.default.green('✓'), "Signed transaction saved to: ".concat(filepath));
                    }
                    return [3 /*break*/, 14];
                case 13:
                    error_1 = _b.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Failed to sign transaction: ".concat(message));
                    return [3 /*break*/, 14];
                case 14: return [2 /*return*/];
            }
        });
    });
}
/**
 * Prompt user to save file
 */
function shouldSaveFile() {
    return __awaiter(this, void 0, void 0, function () {
        var save;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, inquirer_1.default.prompt([
                        {
                            type: 'confirm',
                            name: 'save',
                            message: 'Save signed transaction to file?',
                            default: true,
                        },
                    ])];
                case 1:
                    save = (_a.sent()).save;
                    return [2 /*return*/, save];
            }
        });
    });
}
