"use strict";
/**
 * ckETH Wallet Provider
 *
 * Provider for Ethereum-compatible wallets on ICP ckETH.
 * Supports balance queries, transactions, and signing.
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
exports.CkEthProvider = void 0;
var ethers_1 = require("ethers");
var base_provider_js_1 = require("./base-provider.js");
/**
 * ckETH wallet provider
 */
var CkEthProvider = /** @class */ (function (_super) {
    __extends(CkEthProvider, _super);
    function CkEthProvider(config) {
        var _a;
        var _this = _super.call(this, config) || this;
        _this.provider = null;
        _this.chainId = (_a = config.chainId) !== null && _a !== void 0 ? _a : 1; // Default to mainnet
        return _this;
    }
    /**
     * Connect to Ethereum network via RPC
     */
    CkEthProvider.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var network, error_1, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        // Create provider
                        this.provider = new ethers_1.ethers.JsonRpcProvider(this.getRpcUrl());
                        return [4 /*yield*/, this.provider.getNetwork()];
                    case 1:
                        network = _a.sent();
                        this.chainId = Number(network.chainId);
                        this.connected = true;
                        return [3 /*break*/, 3];
                    case 2:
                        error_1 = _a.sent();
                        message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                        throw new Error("Failed to connect to ckETH network: ".concat(message));
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Disconnect from network
     */
    CkEthProvider.prototype.disconnect = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                this.provider = null;
                this.connected = false;
                return [2 /*return*/];
            });
        });
    };
    /**
     * Get wallet balance
     */
    CkEthProvider.prototype.getBalance = function (address) {
        return __awaiter(this, void 0, void 0, function () {
            var balance, etherBalance, error_2, message;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!this.provider || !this.connected) {
                            throw new Error('Provider not connected');
                        }
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.provider.getBalance(address)];
                    case 2:
                        balance = _b.sent();
                        etherBalance = ethers_1.ethers.formatEther(balance);
                        _a = {
                            amount: etherBalance,
                            denomination: 'ETH',
                            chain: this.getChain(),
                            address: address
                        };
                        return [4 /*yield*/, this.provider.getBlockNumber()];
                    case 3: return [2 /*return*/, (_a.blockNumber = _b.sent(),
                            _a)];
                    case 4:
                        error_2 = _b.sent();
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
    CkEthProvider.prototype.sendTransaction = function (from, request) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, signedTx, txResponse, error_3, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.provider || !this.connected) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 5, , 6]);
                        return [4 /*yield*/, this.populateTransaction(from, request)];
                    case 2:
                        tx = _a.sent();
                        return [4 /*yield*/, this.signTransaction(tx, from)];
                    case 3:
                        signedTx = _a.sent();
                        return [4 /*yield*/, this.provider.broadcastTransaction(signedTx.signedTx)];
                    case 4:
                        txResponse = _a.sent();
                        return [2 /*return*/, {
                                hash: txResponse.hash,
                                from: from,
                                to: request.to,
                                amount: request.amount,
                                chain: this.getChain(),
                                timestamp: Date.now(),
                                status: 'pending',
                                fee: tx.gasPrice ? ethers_1.ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
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
    CkEthProvider.prototype.signTransaction = function (tx, privateKey) {
        return __awaiter(this, void 0, void 0, function () {
            var wallet, signedTxSerialized, error_4, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        wallet = new ethers_1.ethers.Wallet(privateKey);
                        return [4 /*yield*/, wallet.signTransaction(tx)];
                    case 1:
                        signedTxSerialized = _a.sent();
                        return [2 /*return*/, {
                                txHash: tx.hash || '0x0',
                                signedTx: signedTxSerialized,
                                signature: '0x',
                                request: tx,
                            }];
                    case 2:
                        error_4 = _a.sent();
                        message = error_4 instanceof Error ? error_4.message : 'Unknown error';
                        throw new Error("Failed to sign transaction: ".concat(message));
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get transaction history
     */
    CkEthProvider.prototype.getTransactionHistory = function (_address) {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                // For MVP, return empty array
                // In production, query blockchain or use Etherscan API
                return [2 /*return*/, []];
            });
        });
    };
    /**
     * Validate Ethereum address
     */
    CkEthProvider.prototype.validateAddress = function (address) {
        try {
            return ethers_1.ethers.isAddress(address);
        }
        catch (_a) {
            return false;
        }
    };
    /**
     * Estimate transaction fee
     */
    CkEthProvider.prototype.estimateFee = function (request) {
        return __awaiter(this, void 0, void 0, function () {
            var feeData, gasLimit, gasPrice, fee, error_5, message;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.provider || !this.connected) {
                            throw new Error('Provider not connected');
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 4, , 5]);
                        return [4 /*yield*/, this.provider.getFeeData()];
                    case 2:
                        feeData = _a.sent();
                        return [4 /*yield*/, this.provider.estimateGas({
                                to: request.to,
                                value: ethers_1.ethers.parseEther(request.amount),
                            })];
                    case 3:
                        gasLimit = _a.sent();
                        gasPrice = feeData.gasPrice || feeData.maxFeePerGas || BigInt(0);
                        fee = gasPrice * gasLimit;
                        return [2 /*return*/, ethers_1.ethers.formatEther(fee)];
                    case 4:
                        error_5 = _a.sent();
                        message = error_5 instanceof Error ? error_5.message : 'Unknown error';
                        throw new Error("Failed to estimate fee: ".concat(message));
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Get current block number
     */
    CkEthProvider.prototype.getBlockNumber = function () {
        return __awaiter(this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.provider || !this.connected) {
                            throw new Error('Provider not connected');
                        }
                        return [4 /*yield*/, this.provider.getBlockNumber()];
                    case 1: return [2 /*return*/, _a.sent()];
                }
            });
        });
    };
    /**
     * Get transaction by hash
     */
    CkEthProvider.prototype.getTransaction = function (txHash) {
        return __awaiter(this, void 0, void 0, function () {
            var tx, receipt, error_6, message;
            var _a;
            var _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!this.provider || !this.connected) {
                            throw new Error('Provider not connected');
                        }
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 5, , 6]);
                        return [4 /*yield*/, this.provider.getTransaction(txHash)];
                    case 2:
                        tx = _c.sent();
                        if (!tx) {
                            return [2 /*return*/, null];
                        }
                        return [4 /*yield*/, this.provider.getTransactionReceipt(txHash)];
                    case 3:
                        receipt = _c.sent();
                        _a = {
                            hash: tx.hash,
                            from: tx.from,
                            to: tx.to || '',
                            amount: ethers_1.ethers.formatEther(tx.value),
                            chain: this.getChain()
                        };
                        return [4 /*yield*/, this.provider.getBlock(tx.blockNumber || 0)];
                    case 4: return [2 /*return*/, (_a.timestamp = ((_b = (_c.sent())) === null || _b === void 0 ? void 0 : _b.timestamp) || 0,
                            _a.status = receipt ? (receipt.status ? 'confirmed' : 'failed') : 'pending',
                            _a.fee = tx.gasPrice ? ethers_1.ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
                            _a)];
                    case 5:
                        error_6 = _c.sent();
                        message = error_6 instanceof Error ? error_6.message : 'Unknown error';
                        throw new Error("Failed to get transaction: ".concat(message));
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Create transaction from request
     */
    CkEthProvider.prototype.populateTransaction = function (from, request) {
        return __awaiter(this, void 0, void 0, function () {
            var tx;
            return __generator(this, function (_a) {
                tx = {
                    to: request.to,
                    value: ethers_1.ethers.parseEther(request.amount),
                    from: from,
                    gasLimit: request.gasLimit ? BigInt(parseInt(request.gasLimit)) : undefined,
                    gasPrice: request.gasPrice ? BigInt(parseInt(request.gasPrice)) : undefined,
                };
                return [2 /*return*/, tx];
            });
        });
    };
    /**
     * Get default RPC URL for chain
     */
    CkEthProvider.getDefaultRpcUrl = function (isTestnet) {
        if (isTestnet === void 0) { isTestnet = false; }
        if (isTestnet) {
            return 'https://sepolia.infura.io/v3/YOUR-API-KEY'; // Sepolia testnet
        }
        return 'https://mainnet.infura.io/v3/YOUR-API-KEY'; // Ethereum mainnet
    };
    /**
     * Get chain ID
     */
    CkEthProvider.prototype.getChainId = function () {
        return this.chainId;
    };
    return CkEthProvider;
}(base_provider_js_1.BaseWalletProvider));
exports.CkEthProvider = CkEthProvider;
