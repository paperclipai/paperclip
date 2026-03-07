"use strict";
/**
 * Config Persistence Module
 *
 * Manages agent configuration storage in ~/.agentvault/agents/<agent-id>/
 * Supports reading, writing, and listing agent configurations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfigPath = getConfigPath;
exports.ensureVaultStructure = ensureVaultStructure;
exports.writeAgentConfig = writeAgentConfig;
exports.readAgentConfig = readAgentConfig;
exports.listAgents = listAgents;
exports.deleteAgentConfig = deleteAgentConfig;
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");
/**
 * Base agent vault directory
 */
var AGENT_VAULT_DIR = path.join(os.homedir(), '.agentvault');
/**
 * Agents directory within agent vault
 */
var AGENTS_DIR = path.join(AGENT_VAULT_DIR, 'agents');
/**
 * Get config file path for an agent
 *
 * @param agentId - Agent identifier
 * @param fileName - Name of the config file (default: 'agent.json')
 */
function getConfigPath(agentId, fileName) {
    if (fileName === void 0) { fileName = 'agent.json'; }
    var agentDir = path.join(AGENTS_DIR, agentId);
    return path.join(agentDir, fileName);
}
/**
 * Ensure agent vault directories exist
 */
function ensureVaultStructure() {
    if (!fs.existsSync(AGENT_VAULT_DIR)) {
        fs.mkdirSync(AGENT_VAULT_DIR, { recursive: true, mode: 448 });
    }
    if (!fs.existsSync(AGENTS_DIR)) {
        fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 448 });
    }
}
/**
 * Write agent configuration to vault
 *
 * @param agentId - Agent identifier
 * @param config - Parsed agent configuration
 * @param fileName - Name of the config file (default: 'agent.json')
 */
function writeAgentConfig(agentId, config, fileName) {
    if (fileName === void 0) { fileName = 'agent.json'; }
    ensureVaultStructure();
    var agentDir = path.join(AGENTS_DIR, agentId);
    if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true, mode: 448 });
    }
    var configPath = path.join(agentDir, fileName);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
/**
 * Read agent configuration from vault
 *
 * @param agentId - Agent identifier
 * @param fileName - Name of the config file (default: 'agent.json')
 */
function readAgentConfig(agentId, fileName) {
    if (fileName === void 0) { fileName = 'agent.json'; }
    ensureVaultStructure();
    var agentDir = path.join(AGENTS_DIR, agentId);
    var configPath = path.join(agentDir, fileName);
    if (!fs.existsSync(configPath)) {
        return null;
    }
    try {
        var content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    }
    catch (_a) {
        return null;
    }
}
/**
 * List all agents in vault
 *
 * @returns Array of agent IDs
 */
function listAgents() {
    ensureVaultStructure();
    if (!fs.existsSync(AGENTS_DIR)) {
        return [];
    }
    var entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    var agentIds = [];
    for (var _i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
        var entry = entries_1[_i];
        var entryPath = path.join(AGENTS_DIR, entry.name);
        var stats = fs.statSync(entryPath);
        if (stats.isDirectory() && fs.existsSync(path.join(entryPath, 'agent.json'))) {
            agentIds.push(entry.name);
        }
    }
    return agentIds;
}
/**
 * Delete an agent's configuration from vault
 *
 * @param agentId - Agent identifier to remove
 */
function deleteAgentConfig(agentId) {
    var agentDir = path.join(AGENTS_DIR, agentId);
    if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, { recursive: true, force: true });
    }
}
