#!/usr/bin/env node
"use strict";
/**
 * AgentVault CLI
 *
 * Command-line interface for the AgentVault platform.
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
exports.createProgram = createProgram;
exports.run = run;
var commander_1 = require("commander");
var index_js_1 = require("../src/index.js");
var init_js_1 = require("./commands/init.js");
var status_js_1 = require("./commands/status.js");
var package_js_1 = require("./commands/package.js");
var deploy_js_1 = require("./commands/deploy.js");
var fetch_js_1 = require("./commands/fetch.js");
var decrypt_js_1 = require("./commands/decrypt.js");
var rebuild_js_1 = require("./commands/rebuild.js");
var exec_js_1 = require("./commands/exec.js");
var list_js_1 = require("./commands/list.js");
var show_js_1 = require("./commands/show.js");
var wallet_js_1 = require("./commands/wallet.js");
function createProgram() {
    var program = new commander_1.Command();
    program
        .name('agentvault')
        .description('Persistent On-Chain AI Agent Platform - Sovereign, Reconstructible, Autonomous')
        .version(index_js_1.VERSION, '-v, --version', 'output the current version');
    // Register commands
    program.addCommand((0, init_js_1.initCommand)());
    program.addCommand((0, status_js_1.statusCommand)());
    program.addCommand((0, package_js_1.packageCommand)());
    program.addCommand((0, deploy_js_1.deployCommand)());
    program.addCommand((0, fetch_js_1.fetchCommand)());
    program.addCommand((0, decrypt_js_1.decryptCommand)());
    program.addCommand((0, rebuild_js_1.rebuildCommand)());
    program.addCommand((0, exec_js_1.execCommand)());
    program.addCommand((0, list_js_1.listCommand)());
    program.addCommand((0, show_js_1.showCommand)());
    program.addCommand((0, wallet_js_1.walletCommand)());
    return program;
}
function run() {
    return __awaiter(this, arguments, void 0, function (args) {
        var program;
        if (args === void 0) { args = process.argv; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    program = createProgram();
                    return [4 /*yield*/, program.parseAsync(args)];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// CLI entry point
if (import.meta.url === "file://".concat(process.argv[1])) {
    run().catch(function (error) {
        console.error('Error:', error.message);
        process.exit(1);
    });
}
