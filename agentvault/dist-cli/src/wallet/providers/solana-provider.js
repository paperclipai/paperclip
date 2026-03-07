"use strict";
/**
 * Solana Wallet Provider (Full Implementation)
 *
 * Complete provider for Solana wallet operations.
 * Integrates with @solana/web3.js for key derivation.
 * Uses Connection for real RPC network interactions.
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
exports.SolanaProvider = void 0;
var base_provider_js_1 = require("./base-provider.js");
var web3_js_1 = require("@solana/web3.js");
var buffer_1 = require("buffer");
/**
 * Solana wallet provider
 */
var SolanaProvider = /** @class */ (function (_super) {
    __extends(SolanaProvider, _super);
    function SolanaProvider(config) {
        var _this = _super.call(this, config) || this;
        _this.connection = null;
        _this.keypair = null;
        _this.network = config.network || 'mainnet';
        _this.commitment = config.commitment || 'confirmed';
        return _this;
    }
    /**
     * Connect to Solana network via RPC
     */
    SolanaProvider.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var rpcUrl, slot, error_1, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        rpcUrl = this.config.rpcUrl || this.getDefaultRpcUrl();
                        this.connection = new web3_js_1.Connection(rpcUrl, this.commitment);
                        return [4 /*yield*/, this.connection.getSlot()];
                    case 1:
                        slot = _a.sent();
                        this.connected = true;
                        console.log("Connected to Solana ".concat(this.network, " at slot ").concat(slot));
                        return [3 /*break*/, 3];
                    case 2:
                        error_1 = _a.sent();
                        message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                        throw new Error("Failed to connect to Solana network: ".concat(message));
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Disconnect from Solana network
     */
    SolanaProvider.prototype.disconnect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this.connection = null;
                this.keypair = null;
                this.connected = false;
                return [2 /*return*/];
            });
        });
    };
    /**
     * Get wallet balance
     */
    SolanaProvider.prototype.getBalance = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var publicKey, balanceInLamports, balanceInSol, slot, error_2, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.connection) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        publicKey = new web3_js_1.PublicKey(address);
                        return [4 /*yield*/, this.connection.getBalance(publicKey)];
                    case 2:
                        balanceInLamports = _a.sent();
                        balanceInSol = balanceInLamports / web3_js_1.LAMPORTS_PER_SOL;
                        return [4 /*yield*/, this.connection.getSlot()];
                    case 3:
                        slot = _a.sent();
                        return [2 /*return*/, {
                                amount: balanceInSol.toString(),
                                denomination: 'SOL',
                                chain: 'solana',
                                address: address,
                                blockNumber: slot,
                            }];
                    case 4:
                        error_2 = _a.sent();
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
    SolanaProvider.prototype.sendTransaction = function (from, request) {
        return __awaiter(this, void 0, void 0, function () {
            var toPublicKey, fromPublicKey, amountInLamports, blockhash, instruction, transaction, signature, fee, error_3, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.connection || !this.keypair) {
                            throw new Error('Provider not connected or no wallet loaded');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 5, , 6]);
                        toPublicKey = new web3_js_1.PublicKey(request.to);
                        fromPublicKey = new web3_js_1.PublicKey(from);
                        amountInLamports = this.parseSolAmount(request.amount);
                        return [4 /*yield*/, this.connection.getLatestBlockhash()];
                    case 2:
                        blockhash = (_a.sent()).blockhash;
                        instruction = web3_js_1.SystemProgram.transfer({
                            fromPubkey: fromPublicKey,
                            toPubkey: toPublicKey,
                            lamports: amountInLamports,
                        });
                        transaction = new web3_js_1.Transaction().add(instruction);
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = fromPublicKey;
                        return [4 /*yield*/, this.connection.sendTransaction(transaction, [this.keypair])];
                    case 3:
                        signature = _a.sent();
                        return [4 /*yield*/, this.estimateFee(request)];
                    case 4:
                        fee = _a.sent();
                        return [2 /*return*/, {
                                hash: signature,
                                from: from,
                                to: request.to,
                                amount: request.amount,
                                chain: 'solana',
                                timestamp: Date.now(),
                                status: 'pending',
                                fee: fee,
                                data: { memo: request.memo },
                            }];
                    case 5:
                        error_3 = _a.sent();
                        message = error_3 instanceof Error ? error_3.message : 'Unknown error';
                        throw new Error("Failed to send transaction: ".concat(message));
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Sign transaction
     */
    SolanaProvider.prototype.signTransaction = function (tx, privateKey) {
        return __awaiter(this, void 0, void 0, function () {
            var keypair, toPublicKey, fromPublicKey, amountInLamports, blockhash, instruction, transaction, error_4, message;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.connection) {
                            throw new Error('Provider not connected');
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        keypair = this.createKeypairFromPrivateKey(privateKey);
                        toPublicKey = new web3_js_1.PublicKey(tx.to);
                        fromPublicKey = keypair.publicKey;
                        amountInLamports = this.parseSolAmount(tx.amount);
                        return [4 /*yield*/, this.connection.getLatestBlockhash()];
                    case 2:
                        blockhash = (_b.sent()).blockhash;
                        instruction = web3_js_1.SystemProgram.transfer({
                            fromPubkey: fromPublicKey,
                            toPubkey: toPublicKey,
                            lamports: amountInLamports,
                        });
                        transaction = new web3_js_1.Transaction().add(instruction);
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = fromPublicKey;
                        // Sign transaction
                        transaction.sign(keypair);
                        return [2 /*return*/, {
                                txHash: ((_a = transaction.signature) === null || _a === void 0 ? void 0 : _a.toString()) || '',
                                signedTx: transaction.serialize().toString('base64'),
                                signature: buffer_1.Buffer.from(transaction.signature).toString('hex'),
                                request: tx,
                            }];
                    case 3:
                        error_4 = _b.sent();
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
    SolanaProvider.prototype.getTransactionHistory = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var publicKey, transactions, signatures, _i, signatures_1, sig, tx, transfer, parsedIx, _a, from, to, lamports, error_5, error_6, message;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.connected || !this.connection) {
                            throw new Error('Provider not connected');
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 9, , 10]);
                        publicKey = new web3_js_1.PublicKey(address);
                        transactions = [];
                        return [4 /*yield*/, this.connection.getSignaturesForAddress(publicKey, { limit: 20 })];
                    case 2:
                        signatures = _b.sent();
                        _i = 0, signatures_1 = signatures;
                        _b.label = 3;
                    case 3:
                        if (!(_i < signatures_1.length)) return [3 /*break*/, 8];
                        sig = signatures_1[_i];
                        _b.label = 4;
                    case 4:
                        _b.trys.push([4, 6, , 7]);
                        return [4 /*yield*/, this.connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })];
                    case 5:
                        tx = _b.sent();
                        if (!tx || !tx.meta)
                            return [3 /*break*/, 7];
                        transfer = tx.transaction.message.instructions.find(function (ix) { return ix.programId.toBase58() === web3_js_1.SystemProgram.programId.toBase58(); });
                        if (!transfer)
                            return [3 /*break*/, 7];
                        parsedIx = transfer.parsed;
                        if ((parsedIx === null || parsedIx === void 0 ? void 0 : parsedIx.type) !== 'transfer')
                            return [3 /*break*/, 7];
                        _a = parsedIx.info, from = _a.from, to = _a.to, lamports = _a.lamports;
                        // Only include transactions involving this address
                        if (from !== address && to !== address)
                            return [3 /*break*/, 7];
                        transactions.push({
                            hash: sig.signature,
                            from: from,
                            to: to,
                            amount: (lamports / web3_js_1.LAMPORTS_PER_SOL).toFixed(9),
                            chain: 'solana',
                            timestamp: (sig.blockTime || Date.now() / 1000) * 1000,
                            status: 'confirmed',
                            fee: tx.meta.fee
                                ? (tx.meta.fee / web3_js_1.LAMPORTS_PER_SOL).toFixed(9)
                                : '0',
                        });
                        return [3 /*break*/, 7];
                    case 6:
                        error_5 = _b.sent();
                        console.warn("Failed to fetch transaction ".concat(sig.signature, ":"), error_5);
                        return [3 /*break*/, 7];
                    case 7:
                        _i++;
                        return [3 /*break*/, 3];
                    case 8: return [2 /*return*/, transactions];
                    case 9:
                        error_6 = _b.sent();
                        message = error_6 instanceof Error ? error_6.message : 'Unknown error';
                        console.warn("Failed to get transaction history: ".concat(message));
                        return [2 /*return*/, []];
                    case 10: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Validate Solana address (Base58 format)
     */
    SolanaProvider.prototype.validateAddress = function (address) {
        try {
            new web3_js_1.PublicKey(address);
            return true;
        }
        catch (_a) {
            return false;
        }
    };
    /**
     * Estimate transaction fee
     */
    SolanaProvider.prototype.estimateFee = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var toPublicKey, fromPublicKey, amountInLamports, blockhash, instruction, transaction, fee, feeInSol, error_7;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.connection || !this.keypair) {
                            return [2 /*return*/, '0.000005']; // Default minimum
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        toPublicKey = new web3_js_1.PublicKey(request.to);
                        fromPublicKey = this.keypair.publicKey;
                        amountInLamports = this.parseSolAmount(request.amount);
                        return [4 /*yield*/, this.connection.getLatestBlockhash()];
                    case 2:
                        blockhash = (_a.sent()).blockhash;
                        instruction = web3_js_1.SystemProgram.transfer({
                            fromPubkey: fromPublicKey,
                            toPubkey: toPublicKey,
                            lamports: amountInLamports,
                        });
                        transaction = new web3_js_1.Transaction().add(instruction);
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = fromPublicKey;
                        return [4 /*yield*/, transaction.getEstimatedFee(this.connection)];
                    case 3:
                        fee = _a.sent();
                        if (!fee)
                            return [2 /*return*/, '0.000005'];
                        feeInSol = fee / web3_js_1.LAMPORTS_PER_SOL;
                        return [2 /*return*/, feeInSol.toFixed(9)];
                    case 4:
                        error_7 = _a.sent();
                        return [2 /*return*/, '0.000005'];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get current block number (slot)
     */
    SolanaProvider.prototype.getBlockNumber = function () {
        return __awaiter(this, void 0, void 0, function () {
            var error_8, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.connected || !this.connection) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.connection.getSlot()];
                    case 2: return [2 /*return*/, _a.sent()];
                    case 3:
                        error_8 = _a.sent();
                        message = error_8 instanceof Error ? error_8.message : 'Unknown error';
                        throw new Error("Failed to get block number: ".concat(message));
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get transaction by hash
     */
    SolanaProvider.prototype.getTransaction = function (txHash) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, transfer, parsedIx, _a, from, to, lamports, error_9, message;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.connected || !this.connection) {
                            throw new Error('Provider not connected');
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, this.connection.getParsedTransaction(txHash, { maxSupportedTransactionVersion: 0 })];
                    case 2:
                        tx = _b.sent();
                        if (!tx || !tx.meta)
                            return [2 /*return*/, null];
                        transfer = tx.transaction.message.instructions.find(function (ix) { return ix.programId.toBase58() === web3_js_1.SystemProgram.programId.toBase58(); });
                        if (!transfer)
                            return [2 /*return*/, null];
                        parsedIx = transfer.parsed;
                        if ((parsedIx === null || parsedIx === void 0 ? void 0 : parsedIx.type) !== 'transfer')
                            return [2 /*return*/, null];
                        _a = parsedIx.info, from = _a.from, to = _a.to, lamports = _a.lamports;
                        return [2 /*return*/, {
                                hash: txHash,
                                from: from,
                                to: to,
                                amount: (lamports / web3_js_1.LAMPORTS_PER_SOL).toFixed(9),
                                chain: 'solana',
                                timestamp: (tx.blockTime || Date.now() / 1000) * 1000,
                                status: 'confirmed',
                                fee: tx.meta.fee
                                    ? (tx.meta.fee / web3_js_1.LAMPORTS_PER_SOL).toFixed(9)
                                    : '0',
                            }];
                    case 3:
                        error_9 = _b.sent();
                        message = error_9 instanceof Error ? error_9.message : 'Unknown error';
                        throw new Error("Failed to get transaction: ".concat(message));
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Initialize keypair from wallet data
     */
    SolanaProvider.prototype.initKeypair = function (mnemonic, derivationPath) {
        return __awaiter(this, void 0, void 0, function () {
            var _a, generateSeedFromMnemonic, deriveSolanaKey, seed, path, derived, privateKeyBytes, error_10, message;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, Promise.resolve().then(function () { return require('../key-derivation.js'); })];
                    case 1:
                        _a = _b.sent(), generateSeedFromMnemonic = _a.generateSeedFromMnemonic, deriveSolanaKey = _a.deriveSolanaKey;
                        seed = generateSeedFromMnemonic(mnemonic);
                        path = derivationPath || "m/44'/501'/0'/0'/0'";
                        derived = deriveSolanaKey(seed, path);
                        privateKeyBytes = Uint8Array.from(buffer_1.Buffer.from(derived.privateKey, 'hex'));
                        this.keypair = web3_js_1.Keypair.fromSecretKey(privateKeyBytes);
                        console.log('Solana keypair initialized for derivation:', path);
                        console.log('Address:', this.getAddress());
                        return [3 /*break*/, 3];
                    case 2:
                        error_10 = _b.sent();
                        message = error_10 instanceof Error ? error_10.message : 'Unknown error';
                        throw new Error("Failed to initialize Solana keypair: ".concat(message));
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Initialize from private key
     */
    SolanaProvider.prototype.initFromPrivateKey = function (privateKey) {
        return __awaiter(this, void 0, void 0, function () {
            var message;
            return __generator(this, function (_a) {
                try {
                    this.keypair = this.createKeypairFromPrivateKey(privateKey);
                    console.log('Solana keypair initialized from private key');
                    console.log('Address:', this.getAddress());
                }
                catch (error) {
                    message = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error("Failed to initialize Solana keypair from private key: ".concat(message));
                }
                return [2 /*return*/];
            });
        });
    };
    /**
     * Create Keypair from private key
     */
    SolanaProvider.prototype.createKeypairFromPrivateKey = function (privateKeyHex) {
        var privateKeyBytes = buffer_1.Buffer.from(privateKeyHex, 'hex');
        return web3_js_1.Keypair.fromSecretKey(privateKeyBytes.subarray(0, 32));
    };
    /**
     * Get address from keypair
     */
    SolanaProvider.prototype.getAddress = function () {
        if (!this.keypair) {
            return null;
        }
        return this.keypair.publicKey.toBase58();
    };
    /**
     * Get public key
     */
    SolanaProvider.prototype.getPublicKey = function () {
        if (!this.keypair) {
            return null;
        }
        return buffer_1.Buffer.from(this.keypair.publicKey.toBytes()).toString('hex');
    };
    /**
     * Parse SOL amount to lamports
     */
    SolanaProvider.prototype.parseSolAmount = function (amountStr) {
        try {
            var cleanAmount = amountStr.replace(/,/g, '').trim();
            var amount = parseFloat(cleanAmount);
            return Math.floor(amount * web3_js_1.LAMPORTS_PER_SOL);
        }
        catch (_a) {
            return 0;
        }
    };
    /**
     * Get default RPC URL for network type
     */
    SolanaProvider.prototype.getDefaultRpcUrl = function () {
        var defaultUrls = {
            mainnet: 'https://api.mainnet-beta.solana.com',
            devnet: 'https://api.devnet.solana.com',
        };
        return defaultUrls[this.network] || defaultUrls.mainnet;
    };
    return SolanaProvider;
}(base_provider_js_1.BaseWalletProvider));
exports.SolanaProvider = SolanaProvider;
