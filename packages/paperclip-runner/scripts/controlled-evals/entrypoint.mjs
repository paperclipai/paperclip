import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function isEntrypoint(url, argument = process.argv[1]) {
  if (!argument || argument === '-') return false;
  try { return url === pathToFileURL(await realpath(argument)).href; }
  catch { return false; }
}
