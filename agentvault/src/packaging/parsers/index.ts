/**
 * Agent Parser Registry
 *
 * Central exports for all agent configuration parsers.
 * Provides convenient imports for Clawdbot, Goose, Cline, and Generic agents.
 */

export { parseClawdbotConfig, findClawdbotConfigs } from './clawdbot.js';
export { parseGooseConfig, findGooseConfigs } from './goose.js';
export { parseClineConfig, findClineConfigs } from './cline.js';
export { parsePolyticianConfig, findPolyticianConfigs } from './polytician.js';
export { parseGenericConfig, findGenericConfigs } from './generic.js';
