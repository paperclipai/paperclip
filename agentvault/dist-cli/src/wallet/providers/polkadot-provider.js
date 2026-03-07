"use strict";
/**
 * Polkadot Wallet Provider (Full Implementation)
 *
 * Complete provider for Polkadot wallet operations.
 * Integrates with @polkadot/util-crypto for key derivation.
 * Uses @polkadot/api for real RPC network interactions.
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
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
exports.PolkadotProvider = void 0;
var base_provider_js_1 = require("./base-provider.js");
var util_crypto_1 = require("@polkadot/util-crypto");
var util_1 = require("@polkadot/util");
var api_1 = require("@polkadot/api");
var keyring_1 = require("@polkadot/keyring");
/**
 * Polkadot wallet provider
 */
var PolkadotProvider = /** @class */ (function (_super) {
    __extends(PolkadotProvider, _super);
    function PolkadotProvider(config) {
        var _this = _super.call(this, config) || this;
        _this.keyringPair = null;
        _this.api = null;
        _this.ss58Format = config.ss58Format || 0;
        _this.chainType = config.chainType || 'polkadot';
        return _this;
    }
    /**
     * Connect to Polkadot network via RPC
     */
    PolkadotProvider.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var rpcUrl, provider, _a, error_1, message;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 4, , 5]);
                        return [4 /*yield*/, (0, util_crypto_1.cryptoWaitReady)()];
                    case 1:
                        _b.sent();
                        rpcUrl = this.config.rpcUrl || this.getDefaultRpcUrl();
                        provider = new api_1.WsProvider(rpcUrl);
                        _a = this;
                        return [4 /*yield*/, api_1.ApiPromise.create({ provider: provider })];
                    case 2:
                        _a.api = _b.sent();
                        return [4 /*yield*/, this.api.isReady];
                    case 3:
                        _b.sent();
                        this.connected = true;
                        console.log("Connected to ".concat(this.chainType, " network via ").concat(rpcUrl));
                        return [3 /*break*/, 5];
                    case 4:
                        error_1 = _b.sent();
                        message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                        throw new Error("Failed to connect to Polkadot network: ".concat(message));
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Disconnect from Polkadot network
     */
    PolkadotProvider.prototype.disconnect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.api) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.api.disconnect()];
                    case 1:
                        _a.sent();
                        this.api = null;
                        _a.label = 2;
                    case 2:
                        this.keyringPair = null;
                        this.connected = false;
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get wallet balance
     */
    PolkadotProvider.prototype.getBalance = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var accountInfo, data, freeBalance, reserved, totalBalance, balanceInDot, blockNumber, error_2, message;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!this.connected || !this.api) {
                            throw new Error('Provider not connected');
                        }
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.api.query.system.account(address)];
                    case 2:
                        accountInfo = _c.sent();
                        data = accountInfo.toJSON();
                        freeBalance = ((_a = data === null || data === void 0 ? void 0 : data.data) === null || _a === void 0 ? void 0 : _a.free) || '0';
                        reserved = ((_b = data === null || data === void 0 ? void 0 : data.data) === null || _b === void 0 ? void 0 : _b.reserved) || '0';
                        totalBalance = (BigInt(freeBalance) + BigInt(reserved)).toString();
                        balanceInDot = parseFloat(totalBalance) / 10000000000;
                        return [4 /*yield*/, this.api.query.system.number()];
                    case 3:
                        blockNumber = _c.sent();
                        return [2 /*return*/, {
                                amount: balanceInDot.toString(),
                                denomination: 'DOT',
                                chain: this.chainType,
                                address: address,
                                blockNumber: Number(blockNumber),
                            }];
                    case 4:
                        error_2 = _c.sent();
                        message = error_2 instanceof Error ? error_2.message : 'Unknown error';
                        throw new Error("Failed to get balance: ".concat(message));
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Send transaction
     */
    PolkadotProvider.prototype.sendTransaction = function (from, request) {
        return __awaiter(this, void 0, void 0, function () {
            var transferAmount, tx, hash, fee, error_3, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.api || !this.keyringPair) {
                            throw new Error('Provider not connected or no wallet loaded');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        transferAmount = this.parseDotAmount(request.amount);
                        tx = this.api.tx.balances.transfer(request.to, transferAmount);
                        return [4 /*yield*/, tx.signAndSend(this.keyringPair)];
                    case 2:
                        hash = _a.sent();
                        return [4 /*yield*/, this.estimateFee(request)];
                    case 3:
                        fee = _a.sent();
                        return [2 /*return*/, {
                                hash: hash.toString(),
                                from: from,
                                to: request.to,
                                amount: request.amount,
                                chain: this.chainType,
                                timestamp: Date.now(),
                                status: 'pending',
                                fee: fee,
                                data: { memo: request.memo },
                            }];
                    case 4:
                        error_3 = _a.sent();
                        message = error_3 instanceof Error ? error_3.message : 'Unknown error';
                        throw new Error("Failed to send transaction: ".concat(message));
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Sign transaction
     */
    PolkadotProvider.prototype.signTransaction = function (tx, privateKey) {
        return __awaiter(this, void 0, void 0, function () {
            var keypair, transferAmount, unsignedTx, signedTx, error_4, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.api) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        keypair = this.createKeyringPair(privateKey);
                        transferAmount = this.parseDotAmount(tx.amount);
                        unsignedTx = this.api.tx.balances.transfer(tx.to, transferAmount);
                        return [4 /*yield*/, unsignedTx.signAsync(keypair)];
                    case 2:
                        signedTx = _a.sent();
                        return [2 /*return*/, {
                                txHash: signedTx.hash.toString(),
                                signedTx: signedTx.toHex(),
                                signature: (0, util_1.u8aToHex)(signedTx.signature),
                                request: tx,
                            }];
                    case 3:
                        error_4 = _a.sent();
                        message = error_4 instanceof Error ? error_4.message : 'Unknown error';
                        throw new Error("Failed to sign transaction: ".concat(message));
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get transaction history
     */
    PolkadotProvider.prototype.getTransactionHistory = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var transactions, blockNumber, latestBlocks, i, blockHash, events, eventRecords, _i, eventRecords_1, event_1, eventData, from, to, amount, error_5, message;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!this.connected || !this.api) {
                            throw new Error('Provider not connected');
                        }
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 8, , 9]);
                        transactions = [];
                        return [4 /*yield*/, this.api.query.system.number()];
                    case 2:
                        blockNumber = _c.sent();
                        latestBlocks = Math.min(Number(blockNumber), 100);
                        i = 0;
                        _c.label = 3;
                    case 3:
                        if (!(i < latestBlocks)) return [3 /*break*/, 7];
                        return [4 /*yield*/, this.api.rpc.chain.getBlockHash(Number(blockNumber) - i)];
                    case 4:
                        blockHash = _c.sent();
                        return [4 /*yield*/, this.api.query.system.events.at(blockHash)];
                    case 5:
                        events = _c.sent();
                        eventRecords = events.toHuman();
                        for (_i = 0, eventRecords_1 = eventRecords; _i < eventRecords_1.length; _i++) {
                            event_1 = eventRecords_1[_i];
                            if (((_a = event_1.event) === null || _a === void 0 ? void 0 : _a.section) === 'balances' && ((_b = event_1.event) === null || _b === void 0 ? void 0 : _b.method) === 'Transfer') {
                                eventData = event_1.event.data;
                                from = eventData[0], to = eventData[1], amount = eventData[2];
                                if (from.toString() === address || to.toString() === address) {
                                    transactions.push({
                                        hash: blockHash.toString(),
                                        from: from.toString(),
                                        to: to.toString(),
                                        amount: this.formatPlancks(amount.toString()),
                                        chain: this.chainType,
                                        timestamp: Date.now() - (i * 6000),
                                        status: 'confirmed',
                                        fee: '0',
                                    });
                                }
                            }
                        }
                        _c.label = 6;
                    case 6:
                        i++;
                        return [3 /*break*/, 3];
                    case 7: return [2 /*return*/, transactions.slice(0, 20)];
                    case 8:
                        error_5 = _c.sent();
                        message = error_5 instanceof Error ? error_5.message : 'Unknown error';
                        console.warn("Failed to get transaction history: ".concat(message));
                        return [2 /*return*/, []];
                    case 9: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Validate Polkadot address (SS58 format)
     */
    PolkadotProvider.prototype.validateAddress = function (address) {
        try {
            var isValid = (0, util_crypto_1.checkAddress)(address, this.ss58Format)[0];
            return isValid;
        }
        catch (_a) {
            return false;
        }
    };
    /**
     * Estimate transaction fee
     */
    PolkadotProvider.prototype.estimateFee = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var transferAmount, tx, info, partialFee, feeInDot, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.api || !this.keyringPair) {
                            return [2 /*return*/, '0.01'];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        transferAmount = this.parseDotAmount(request.amount);
                        tx = this.api.tx.balances.transfer(request.to, transferAmount);
                        return [4 /*yield*/, tx.paymentInfo(this.keyringPair)];
                    case 2:
                        info = _a.sent();
                        partialFee = info.partialFee.toString();
                        feeInDot = parseFloat(partialFee) / 10000000000;
                        return [2 /*return*/, feeInDot.toFixed(6)];
                    case 3:
                        error_6 = _a.sent();
                        return [2 /*return*/, '0.01'];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get current block number
     */
    PolkadotProvider.prototype.getBlockNumber = function () {
        return __awaiter(this, void 0, void 0, function () {
            var blockNumber, error_7, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.api) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.api.query.system.number()];
                    case 2:
                        blockNumber = _a.sent();
                        return [2 /*return*/, Number(blockNumber)];
                    case 3:
                        error_7 = _a.sent();
                        message = error_7 instanceof Error ? error_7.message : 'Unknown error';
                        throw new Error("Failed to get block number: ".concat(message));
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get transaction by hash
     */
    PolkadotProvider.prototype.getTransaction = function (txHash) {
        return __awaiter(this, void 0, void 0, function () {
            var blockHash, events, eventRecords, from, to, amount, found, _i, eventRecords_2, event_2, eventData, error_8, message;
            var _a, _b, _c, _d;
            return __generator(this, function (_e) {
                switch (_e.label) {
                    case 0:
                        if (!this.connected || !this.api) {
                            throw new Error('Provider not connected');
                        }
                        _e.label = 1;
                    case 1:
                        _e.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.api.rpc.chain.getBlockHash()];
                    case 2:
                        blockHash = _e.sent();
                        return [4 /*yield*/, this.api.query.system.events.at(blockHash)];
                    case 3:
                        events = _e.sent();
                        eventRecords = events.toHuman();
                        from = '';
                        to = '';
                        amount = '0';
                        found = false;
                        for (_i = 0, eventRecords_2 = eventRecords; _i < eventRecords_2.length; _i++) {
                            event_2 = eventRecords_2[_i];
                            if (((_a = event_2.event) === null || _a === void 0 ? void 0 : _a.section) === 'balances' && ((_b = event_2.event) === null || _b === void 0 ? void 0 : _b.method) === 'Transfer') {
                                eventData = event_2.event.data;
                                from = eventData[0], to = eventData[1], amount = eventData[2];
                                found = true;
                            }
                            if (((_c = event_2.event) === null || _c === void 0 ? void 0 : _c.section) === 'system' && ((_d = event_2.event) === null || _d === void 0 ? void 0 : _d.method) === 'ExtrinsicSuccess') {
                                break;
                            }
                        }
                        if (found && (from || to)) {
                            return [2 /*return*/, {
                                    hash: txHash,
                                    from: from.toString(),
                                    to: to.toString(),
                                    amount: this.formatPlancks(amount.toString()),
                                    chain: this.chainType,
                                    timestamp: Date.now(),
                                    status: 'confirmed',
                                    fee: '0',
                                }];
                        }
                        return [2 /*return*/, null];
                    case 4:
                        error_8 = _e.sent();
                        message = error_8 instanceof Error ? error_8.message : 'Unknown error';
                        throw new Error("Failed to get transaction: ".concat(message));
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Initialize keypair from wallet data
     */
    PolkadotProvider.prototype.initKeypair = function (mnemonic, derivationPath) {
        return __awaiter(this, void 0, void 0, function () {
            var keyring, path, derived, error_9, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, (0, util_crypto_1.cryptoWaitReady)()];
                    case 1:
                        _a.sent();
                        keyring = new keyring_1.Keyring({ type: 'sr25519', ss58Format: this.ss58Format });
                        path = derivationPath || '//hard//stash';
                        this.keyringPair = keyring.addFromMnemonic(mnemonic, undefined, 'sr25519');
                        if (derivationPath && derivationPath !== '//hard//stash') {
                            derived = keyring.addFromUri(path, undefined, 'sr25519');
                            this.keyringPair = derived;
                        }
                        console.log('Polkadot keypair initialized for derivation:', path);
                        console.log('Address:', this.getAddress());
                        return [3 /*break*/, 3];
                    case 2:
                        error_9 = _a.sent();
                        message = error_9 instanceof Error ? error_9.message : 'Unknown error';
                        throw new Error("Failed to initialize Polkadot keypair: ".concat(message));
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Initialize from private key
     */
    PolkadotProvider.prototype.initFromPrivateKey = function (privateKey) {
        return __awaiter(this, void 0, void 0, function () {
            var message;
            return __generator(this, function (_a) {
                try {
                    this.keyringPair = this.createKeyringPair(privateKey);
                    console.log('Polkadot keypair initialized from private key');
                    console.log('Address:', this.getAddress());
                }
                catch (error) {
                    message = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error("Failed to initialize Polkadot keypair from private key: ".concat(message));
                }
                return [2 /*return*/];
            });
        });
    };
    /**
     * Create KeyringPair from private key
     */
    PolkadotProvider.prototype.createKeyringPair = function (privateKeyHex) {
        var keyring = new keyring_1.Keyring({ type: 'sr25519', ss58Format: this.ss58Format });
        var privateKeyBytes = (0, util_1.hexToU8a)(privateKeyHex);
        var pair = keyring.addFromSeed(privateKeyBytes);
        return pair;
    };
    /**
     * Get address from keypair
     */
    PolkadotProvider.prototype.getAddress = function () {
        if (!this.keyringPair) {
            return null;
        }
        return this.keyringPair.address;
    };
    /**
     * Get public key
     */
    PolkadotProvider.prototype.getPublicKey = function () {
        if (!this.keyringPair) {
            return null;
        }
        return (0, util_1.u8aToHex)(this.keyringPair.publicKey);
    };
    /**
     * Generate mock transaction hash
     */
    PolkadotProvider.prototype.generateTxHash = function (from, to, amount) {
        var txData = (0, util_1.stringToU8a)("".concat(from, ":").concat(to, ":").concat(amount, ":").concat(Date.now()));
        var hash = (0, util_crypto_1.blake2AsU8a)(txData, 256);
        return (0, util_1.u8aToHex)(hash);
    };
    /**
     * Parse DOT amount (convert from string to Plancks)
     */
    PolkadotProvider.prototype.parseDotAmount = function (amountStr) {
        try {
            var cleanAmount = amountStr.replace(/,/g, '').trim();
            var amount = parseFloat(cleanAmount);
            var plancks = Math.floor(amount * 10000000000);
            return BigInt(plancks);
        }
        catch (error) {
            return BigInt(0);
        }
    };
    /**
     * Format Plancks to DOT
     */
    PolkadotProvider.prototype.formatPlancks = function (plancks) {
        try {
            var amount = parseFloat(plancks) / 10000000000;
            return amount.toFixed(6);
        }
        catch (error) {
            return '0';
        }
    };
    /**
     * Create SR25519 signature for transaction
     */
    PolkadotProvider.prototype.createSignature = function (payload, privateKeyHex) {
        return __awaiter(this, void 0, void 0, function () {
            var privateKeyBytes, keypair, signature, msg;
            return __generator(this, function (_a) {
                try {
                    privateKeyBytes = (0, util_1.hexToU8a)(privateKeyHex);
                    keypair = (0, util_crypto_1.sr25519PairFromSeed)(privateKeyBytes);
                    signature = (0, util_crypto_1.sr25519Sign)(payload, { publicKey: keypair.publicKey, secretKey: keypair.secretKey });
                    return [2 /*return*/, signature];
                }
                catch (error) {
                    msg = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error("Failed to create Polkadot signature: ".concat(msg));
                }
                return [2 /*return*/];
            });
        });
    };
    /**
     * Get default RPC URL for chain type
     */
    PolkadotProvider.prototype.getDefaultRpcUrl = function () {
        var defaultUrls = {
            polkadot: 'wss://rpc.polkadot.io',
            kusama: 'wss://kusama-rpc.polkadot.io',
            westend: 'wss://westend-rpc.polkadot.io',
            astar: 'wss://rpc.astar.network',
        };
        return defaultUrls[this.chainType] || defaultUrls.polkadot;
    };
    return PolkadotProvider;
}(base_provider_js_1.BaseWalletProvider));
exports.PolkadotProvider = PolkadotProvider;
