"use strict";
/**
 * Wallet History Command
 *
 * Display transaction history for a wallet.
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
exports.handleHistory = handleHistory;
var cketh_provider_js_1 = require("../../src/wallet/providers/cketh-provider.js");
var polkadot_provider_js_1 = require("../../src/wallet/providers/polkadot-provider.js");
var solana_provider_js_1 = require("../../src/wallet/providers/solana-provider.js");
var index_js_1 = require("../../src/wallet/index.js");
var inquirer_1 = require("inquirer");
var ora_1 = require("ora");
var chalk_1 = require("chalk");
/**
 * Format address for display
 */
function formatAddress(address, length) {
    if (length === void 0) { length = 8; }
    if (address.length <= length * 2)
        return address;
    return "".concat(address.slice(0, length), "...").concat(address.slice(-length));
}
/**
 * Get status color
 */
function getStatusColor(status) {
    switch (status) {
        case 'confirmed':
            return chalk_1.default.green(status);
        case 'pending':
            return chalk_1.default.yellow(status);
        case 'failed':
            return chalk_1.default.red(status);
        default:
            return chalk_1.default.white(status);
    }
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
 * Display transaction history
 */
function displayTransactions(transactions) {
    if (transactions.length === 0) {
        console.log(chalk_1.default.yellow('No transactions found'));
        return;
    }
    console.log();
    console.log(chalk_1.default.cyan("Transaction History (".concat(transactions.length, " transactions):\n")));
    var table = [];
    for (var _i = 0, transactions_1 = transactions; _i < transactions_1.length; _i++) {
        var tx = transactions_1[_i];
        table.push({
            Hash: formatAddress(tx.hash),
            From: formatAddress(tx.from),
            To: formatAddress(tx.to),
            Amount: "".concat(tx.amount),
            Status: getStatusColor(tx.status),
            Fee: tx.fee || 'N/A',
        });
    }
    console.table(table);
}
/**
 * Handle wallet history command
 */
function handleHistory(agentId_1) {
    return __awaiter(this, arguments, void 0, function (agentId, json) {
        var wallets, walletId, wallet, spinner, provider, transactions, error_1, message;
        if (json === void 0) { json = false; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📜 Wallet History\n'));
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
                    spinner = (0, ora_1.default)('Fetching transaction history...').start();
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 5, , 6]);
                    provider = createProvider(wallet.chain);
                    return [4 /*yield*/, provider.connect()];
                case 3:
                    _a.sent();
                    return [4 /*yield*/, provider.getTransactionHistory(wallet.address)];
                case 4:
                    transactions = _a.sent();
                    spinner.succeed('Transaction history fetched');
                    if (json) {
                        console.log(JSON.stringify(transactions, null, 2));
                    }
                    else {
                        displayTransactions(transactions);
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _a.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Failed to fetch history: ".concat(message));
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
}
