"use strict";
/**
 * Agent Parser Registry
 *
 * Central exports for all agent configuration parsers.
 * Provides convenient imports for Clawdbot, Goose, Cline, and Generic agents.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findGenericConfigs = exports.parseGenericConfig = exports.findClineConfigs = exports.parseClineConfig = exports.findGooseConfigs = exports.parseGooseConfig = exports.findClawdbotConfigs = exports.parseClawdbotConfig = void 0;
var clawdbot_js_1 = require("./clawdbot.js");
Object.defineProperty(exports, "parseClawdbotConfig", { enumerable: true, get: function () { return clawdbot_js_1.parseClawdbotConfig; } });
Object.defineProperty(exports, "findClawdbotConfigs", { enumerable: true, get: function () { return clawdbot_js_1.findClawdbotConfigs; } });
var goose_js_1 = require("./goose.js");
Object.defineProperty(exports, "parseGooseConfig", { enumerable: true, get: function () { return goose_js_1.parseGooseConfig; } });
Object.defineProperty(exports, "findGooseConfigs", { enumerable: true, get: function () { return goose_js_1.findGooseConfigs; } });
var cline_js_1 = require("./cline.js");
Object.defineProperty(exports, "parseClineConfig", { enumerable: true, get: function () { return cline_js_1.parseClineConfig; } });
Object.defineProperty(exports, "findClineConfigs", { enumerable: true, get: function () { return cline_js_1.findClineConfigs; } });
var generic_js_1 = require("./generic.js");
Object.defineProperty(exports, "parseGenericConfig", { enumerable: true, get: function () { return generic_js_1.parseGenericConfig; } });
Object.defineProperty(exports, "findGenericConfigs", { enumerable: true, get: function () { return generic_js_1.findGenericConfigs; } });
