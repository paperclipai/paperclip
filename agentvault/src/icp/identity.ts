/**
 * Identity Management
 *
 * Provides identity management via icp-cli.
 * List identities, create new identities,
 * import/export identities and manage default identity.
 */

import {
  identityList,
  identityNew,
  identityExport,
  identityPrincipal,
  identityImport,
  identityDefault,
} from './icpcli.js';

/**
 * List all available identities.
 *
 * @returns Command result with identity list
 */
export async function listIdentities(): Promise<any> {
  return identityList({});
}

/**
 * Create a new identity.
 *
 * @param name - Identity name
 * @returns Command result
 */
export async function createIdentity(name: string): Promise<any> {
  return identityNew({ name });
}

/**
 * Export an identity to PEM file.
 *
 * @param name - Identity name
 * @returns Command result with PEM content
 */
export async function exportIdentity(name: string): Promise<any> {
  return identityExport({ name });
}

/**
 * Get the principal of a default or named identity.
 *
 * @param name - Identity name (if null, use default)
 * @returns Command result with principal
 */
export async function getIdentityPrincipal(name?: string): Promise<string> {
  const result = await identityPrincipal({ name });
  return result.stdout || '';
}

/**
 * Import an identity from a PEM file.
 *
 * @param name - Identity name to import
 * @param pemFile - Path to PEM file
 * @returns Command result
 */
export async function importIdentity(name: string, pemFile: string): Promise<any> {
  return identityImport({ name, pemFile });
}

/**
 * Set a default identity.
 *
 * @param name - Identity name to set as default
 * @returns Command result
 */
export async function setDefaultIdentity(name: string): Promise<any> {
  return identityDefault({ name });
}
