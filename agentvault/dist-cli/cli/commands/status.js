"use strict";
/**
 * Status command - Display current AgentVault project status
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
exports.getProjectStatus = getProjectStatus;
exports.displayStatus = displayStatus;
exports.statusCommand = statusCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var index_js_1 = require("../../src/index.js");
function getProjectStatus() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            // In a real implementation, this would check for configuration files,
            // deployed canisters, etc.
            return [2 /*return*/, {
                    initialized: false,
                    version: index_js_1.VERSION,
                    agentName: null,
                    canisterDeployed: false,
                }];
        });
    });
}
function displayStatus(status) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            console.log(chalk_1.default.bold('\n📊 AgentVault Project Status\n'));
            console.log(chalk_1.default.cyan('Version:'), status.version);
            console.log();
            if (!status.initialized) {
                console.log(chalk_1.default.yellow('⚠'), 'No AgentVault project found in current directory.');
                console.log();
                console.log('Run', chalk_1.default.bold('agentvault init'), 'to create a new project.');
                return [2 /*return*/];
            }
            console.log(chalk_1.default.green('✓'), 'Project initialized');
            console.log(chalk_1.default.cyan('Agent:'), (_a = status.agentName) !== null && _a !== void 0 ? _a : 'Not configured');
            console.log(chalk_1.default.cyan('Canister:'), status.canisterDeployed ? chalk_1.default.green('Deployed') : chalk_1.default.yellow('Not deployed'));
            return [2 /*return*/];
        });
    });
}
function statusCommand() {
    var _this = this;
    var command = new commander_1.Command('status');
    command
        .description('Display current AgentVault project status')
        .option('-j, --json', 'output status as JSON')
        .action(function (options) { return __awaiter(_this, void 0, void 0, function () {
        var spinner, status;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    spinner = (0, ora_1.default)('Checking project status...').start();
                    return [4 /*yield*/, getProjectStatus()];
                case 1:
                    status = _a.sent();
                    spinner.stop();
                    if (options.json) {
                        console.log(JSON.stringify(status, null, 2));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, displayStatus(status)];
                case 2:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    return command;
}
