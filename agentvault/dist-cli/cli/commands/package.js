"use strict";
/**
 * Package command - Compile agent to WASM for deployment
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
exports.displayPreview = displayPreview;
exports.displayResult = displayResult;
exports.executePackage = executePackage;
exports.packageCommand = packageCommand;
var commander_1 = require("commander");
var chalk_1 = require("chalk");
var ora_1 = require("ora");
var path = require("node:path");
var index_js_1 = require("../../src/packaging/index.js");
/**
 * Format file size for display
 */
function formatSize(bytes) {
    if (bytes < 1024) {
        return "".concat(bytes, " B");
    }
    if (bytes < 1024 * 1024) {
        return "".concat((bytes / 1024).toFixed(1), " KB");
    }
    return "".concat((bytes / (1024 * 1024)).toFixed(2), " MB");
}
/**
 * Display package preview (dry-run)
 */
function displayPreview(sourcePath) {
    var _a, _b;
    var _c = (0, index_js_1.getPackageSummary)(sourcePath), config = _c.config, validation = _c.validation;
    console.log(chalk_1.default.bold('\nPackage Preview\n'));
    console.log(chalk_1.default.cyan('Agent Configuration:'));
    console.log("  Name:        ".concat(chalk_1.default.bold(config.name)));
    console.log("  Type:        ".concat(chalk_1.default.bold(config.type)));
    console.log("  Source:      ".concat(config.sourcePath));
    console.log("  Entry Point: ".concat((_a = config.entryPoint) !== null && _a !== void 0 ? _a : chalk_1.default.yellow('not detected')));
    console.log("  Version:     ".concat((_b = config.version) !== null && _b !== void 0 ? _b : chalk_1.default.yellow('not specified')));
    // Display agent settings for Clawdbot agents if available
    if (config.type === 'clawdbot' && 'settings' in config) {
        var settings = config.settings;
        console.log();
        console.log(chalk_1.default.cyan('Agent Settings:'));
        if (settings.model) {
            console.log("  Model: ".concat(chalk_1.default.bold(settings.model)));
        }
        if (settings.temperature !== undefined) {
            console.log("  Temperature: ".concat(chalk_1.default.bold(String(settings.temperature))));
        }
        if (settings.maxTokens !== undefined) {
            console.log("  Max Tokens: ".concat(chalk_1.default.bold(String(settings.maxTokens))));
        }
    }
    console.log();
    if (validation.warnings.length > 0) {
        console.log(chalk_1.default.yellow('Warnings:'));
        for (var _i = 0, _d = validation.warnings; _i < _d.length; _i++) {
            var warning = _d[_i];
            console.log(chalk_1.default.yellow("  \u26A0 ".concat(warning)));
        }
        console.log();
    }
    if (validation.errors.length > 0) {
        console.log(chalk_1.default.red('Errors:'));
        for (var _e = 0, _f = validation.errors; _e < _f.length; _e++) {
            var error = _f[_e];
            console.log(chalk_1.default.red("  \u2716 ".concat(error.message)));
        }
        console.log();
    }
    console.log(chalk_1.default.cyan('Output Files:'));
    console.log("  ".concat(config.name, ".wasm      - Compiled WebAssembly module"));
    console.log("  ".concat(config.name, ".wat       - WebAssembly text format"));
    console.log("  ".concat(config.name, ".state.json - Initial agent state"));
}
/**
 * Display package result
 */
function displayResult(result) {
    console.log();
    console.log(chalk_1.default.green('✓'), 'Agent packaged successfully!');
    console.log();
    console.log(chalk_1.default.cyan('Compilation:'));
    console.log("  Target:    ".concat(chalk_1.default.bold(result.target.toUpperCase())));
    console.log("  Duration:  ".concat(result.duration ? "".concat(result.duration, "ms") : 'N/A'));
    console.log();
    console.log(chalk_1.default.cyan('Output Files:'));
    console.log("  WASM:     ".concat(result.wasmPath, " (").concat(formatSize(result.wasmSize), ")"));
    console.log("  WAT:      ".concat(result.watPath));
    console.log("  State:    ".concat(result.statePath));
    if (result.jsBundlePath) {
        console.log("  JS Bundle: ".concat(result.jsBundlePath));
    }
    if (result.sourceMapPath) {
        console.log("  Source Map: ".concat(result.sourceMapPath));
    }
    if (result.manifestPath) {
        console.log("  Manifest:  ".concat(result.manifestPath));
    }
    console.log();
    console.log(chalk_1.default.cyan('Next steps:'));
    console.log('  1. Review the generated files');
    console.log('  2. Run', chalk_1.default.bold('agentvault deploy'), 'to upload to ICP');
}
/**
 * Execute the package command
 */
function executePackage(sourcePath, options) {
    return __awaiter(this, void 0, void 0, function () {
        var spinner, packageOptions, result, error_1, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    // Handle dry-run mode
                    if (options.dryRun) {
                        displayPreview(sourcePath);
                        return [2 /*return*/, null];
                    }
                    spinner = (0, ora_1.default)('Packaging agent...').start();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    packageOptions = {
                        sourcePath: sourcePath,
                        outputPath: options.output ? path.resolve(options.output) : undefined,
                        force: options.force,
                        skipValidation: options.skipValidation,
                        target: options.target,
                        debug: options.debug,
                        optimize: options.optimize,
                    };
                    return [4 /*yield*/, (0, index_js_1.packageAgent)(packageOptions)];
                case 2:
                    result = _a.sent();
                    spinner.succeed("Agent '".concat(result.config.name, "' packaged successfully!"));
                    displayResult(result);
                    return [2 /*return*/, result];
                case 3:
                    error_1 = _a.sent();
                    message = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    spinner.fail("Packaging failed: ".concat(message));
                    throw error_1;
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Create the package command
 */
function packageCommand() {
    var _this = this;
    var command = new commander_1.Command('package');
    command
        .description('Compile agent to WASM for deployment to ICP')
        .argument('[source]', 'path to agent source directory', '.')
        .option('-o, --output <path>', 'output directory for compiled files')
        .option('-f, --force', 'overwrite existing output files')
        .option('--skip-validation', 'skip validation checks')
        .option('--dry-run', 'show what would be packaged without executing')
        .option('-t, --target <target>', 'compilation target (wasmedge|motoko|pure-wasm)', 'wasmedge')
        .option('--debug', 'enable debugging features (source maps, verbose output)')
        .option('--optimize <level>', 'optimization level (0-3)', '2')
        .action(function (source, options) { return __awaiter(_this, void 0, void 0, function () {
        var error_2, message;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log(chalk_1.default.bold('\n📦 AgentVault Package\n'));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, executePackage(source, options)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    error_2 = _a.sent();
                    message = error_2 instanceof Error ? error_2.message : 'Unknown error';
                    console.error(chalk_1.default.red("\nError: ".concat(message)));
                    process.exit(1);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); });
    return command;
}
