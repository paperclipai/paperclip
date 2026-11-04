import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL("../../..", import.meta.url));
registerHooks({ resolve(specifier, context, next) {
  for (const [name, dir] of [['@paperclipai/db', 'packages/db'], ['@paperclipai/shared', 'packages/shared']]) {
    if (specifier === name || specifier.startsWith(name + '/')) {
      const file = specifier === name ? 'index' : specifier.slice(name.length + 1);
      return next(pathToFileURL(path.join(root, dir, 'dist', `${file}.js`)).href, context);
    }
  }
  return next(specifier, context);
} });
