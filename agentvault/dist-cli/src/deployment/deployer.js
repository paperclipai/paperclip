"use strict";
/**
 * Agent Deployer
 *
 * Main orchestrator for the ICP canister deployment pipeline.
 * Coordinates validation, client setup, and deployment operations.
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
exports.validateDeployOptions = validateDeployOptions;
exports.getDeploySummary = getDeploySummary;
exports.deployAgent = deployAgent;
exports.getCanisterStatus = getCanisterStatus;
var fs = require("node:fs");
var path = require("node:path");
var icpClient_js_1 = require("./icpClient.js");
/**
 * Extract agent name from WASM file path
 */
function extractAgentName(wasmPath) {
    var basename = path.basename(wasmPath);
    // Remove .wasm extension
    return basename.replace(/\.wasm$/, '');
}
/**
 * Validate deployment options
 */
function validateDeployOptions(options) {
    var errors = [];
    var warnings = [];
    // Validate WASM path using client
    var client = (0, icpClient_js_1.createICPClient)({ network: options.network });
    var wasmValidation = client.validateWasmPath(options.wasmPath);
    if (!wasmValidation.valid) {
        errors.push({
            code: 'INVALID_WASM',
            message: wasmValidation.error,
        });
    }
    // Validate network
    if (options.network !== 'local' && options.network !== 'ic') {
        errors.push({
            code: 'INVALID_NETWORK',
            message: "Invalid network: ".concat(options.network, ". Must be 'local' or 'ic'."),
            network: options.network,
        });
    }
    // Warn about mainnet deployment
    if (options.network === 'ic' && !options.skipConfirmation) {
        warnings.push('Deploying to IC mainnet will consume cycles. Ensure you have sufficient balance.');
    }
    // Warn about upgrade without canister ID check
    if (options.canisterId) {
        warnings.push("Upgrading existing canister: ".concat(options.canisterId));
    }
    return {
        valid: errors.length === 0,
        errors: errors,
        warnings: warnings,
    };
}
/**
 * Get deployment preview/summary
 *
 * Useful for dry-run functionality
 */
function getDeploySummary(options) {
    var validation = validateDeployOptions(options);
    // Calculate WASM hash if file exists
    var wasmHash = '';
    var wasmSize = 0;
    if (validation.valid) {
        try {
            var client = (0, icpClient_js_1.createICPClient)({ network: options.network });
            wasmHash = client.calculateWasmHash(options.wasmPath);
            wasmSize = fs.statSync(options.wasmPath).size;
        }
        catch (_a) {
            // File doesn't exist or can't be read
        }
    }
    return {
        agentName: extractAgentName(options.wasmPath),
        wasmPath: options.wasmPath,
        wasmHash: wasmHash,
        wasmSize: wasmSize,
        network: options.network,
        isUpgrade: !!options.canisterId,
        canisterId: options.canisterId,
        validation: validation,
    };
}
/**
 * Deploy an agent to ICP
 *
 * This is the main entry point for the deployment pipeline.
 *
 * @param options - Deployment options
 * @returns Deployment result with canister info
 */
function deployAgent(options) {
    return __awaiter(this, void 0, void 0, function () {
        var validation, errorMessages, client, connectionCheck, deployResult, canisterInfo;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    validation = validateDeployOptions(options);
                    if (!validation.valid) {
                        errorMessages = validation.errors.map(function (e) { return e.message; }).join('; ');
                        throw new Error("Deployment validation failed: ".concat(errorMessages));
                    }
                    client = (0, icpClient_js_1.createICPClient)({
                        network: options.network,
                        identity: options.identityPath,
                    });
                    return [4 /*yield*/, client.checkConnection()];
                case 1:
                    connectionCheck = _b.sent();
                    if (!connectionCheck.connected) {
                        throw new Error("Failed to connect to ".concat(options.network, " network: ").concat((_a = connectionCheck.error) !== null && _a !== void 0 ? _a : 'Unknown error'));
                    }
                    return [4 /*yield*/, client.deploy(options.wasmPath, options.canisterId)];
                case 2:
                    deployResult = _b.sent();
                    canisterInfo = {
                        canisterId: deployResult.canisterId,
                        network: options.network,
                        agentName: extractAgentName(options.wasmPath),
                        deployedAt: new Date(),
                        wasmHash: deployResult.wasmHash,
                    };
                    return [2 /*return*/, {
                            canister: canisterInfo,
                            isUpgrade: deployResult.isUpgrade,
                            cyclesUsed: deployResult.cyclesUsed,
                            warnings: validation.warnings,
                        }];
            }
        });
    });
}
/**
 * Check if a canister exists and get its status
 */
function getCanisterStatus(canisterId, network) {
    return __awaiter(this, void 0, void 0, function () {
        var client, status_1, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    client = (0, icpClient_js_1.createICPClient)({ network: network });
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, client.getCanisterStatus(canisterId)];
                case 2:
                    status_1 = _b.sent();
                    return [2 /*return*/, {
                            exists: true,
                            status: status_1.status,
                            memorySize: status_1.memorySize,
                            cycles: status_1.cycles,
                        }];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, { exists: false }];
                case 4: return [2 /*return*/];
            }
        });
    });
}
