"use strict";
/**
 * AgentVault - Persistent On-Chain AI Agent Platform
 *
 * Sovereign, Reconstructible, Autonomous
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = void 0;
exports.createConfig = createConfig;
exports.VERSION = '1.0.0';
function createConfig(name) {
    return {
        name: name,
        version: exports.VERSION,
    };
}
// CLI entry point
if (import.meta.url === "file://".concat(process.argv[1])) {
    console.log("AgentVault v".concat(exports.VERSION));
    console.log('Persistent On-Chain AI Agent Platform');
}
