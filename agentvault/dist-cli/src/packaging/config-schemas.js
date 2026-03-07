"use strict";
/**
 * Agent Configuration Schemas
 *
 * Defines types and schemas for different agent configurations.
 * Supports Clawdbot, Goose, Cline, and Generic agents.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CLINE_CONFIG = exports.DEFAULT_GOOSE_CONFIG = exports.DEFAULT_CLAWDBOT_SETTINGS = void 0;
/**
 * Default values for Clawdbot settings
 */
exports.DEFAULT_CLAWDBOT_SETTINGS = {
    model: 'claude-3-5-sonnet-20240229',
    temperature: 0.7,
    maxTokens: 4096,
    systemPrompt: '',
    tools: [],
};
/**
 * Default values for Goose configuration
 */
exports.DEFAULT_GOOSE_CONFIG = {
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 2048,
    systemPrompt: '',
    tools: [],
    workingDirectory: '.',
    name: 'Agent',
    version: '1.0.0',
    description: '',
};
/**
 * Default values for Cline configuration
 */
exports.DEFAULT_CLINE_CONFIG = {
    mode: 'auto',
    autoConfirm: false,
    useReadline: true,
    workingDirectory: '.',
    name: 'Agent',
    version: '1.0.0',
    description: '',
};
