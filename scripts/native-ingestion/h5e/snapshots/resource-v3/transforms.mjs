import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const pinsFile = process.env.PAPERCLIP_RESOURCE_PINS_FILE ?? new URL('./pins.json', import.meta.url);
const pinsBytes = readFileSync(pinsFile);
if (process.env.PAPERCLIP_RESOURCE_PINS_FILE)
  assert.equal(createHash('sha256').update(pinsBytes).digest('hex'), process.env.PAPERCLIP_RESOURCE_PINS_SHA256, 'Unqualified counter pins');
export const pins = JSON.parse(pinsBytes.toString('utf8'));
assert.equal(pins.schema, 'native-ingestion-resource-pins/h5e-v1');
export const symbolName = 'paperclip.native-ingestion.resource-counter';
const call = `globalThis[Symbol.for('${symbolName}')]`;
export const hash = source => createHash('sha256').update(source).digest('hex');
export function replaceExactly(source, anchor, replacement) {
  assert.equal(source.split(anchor).length - 1, 1, `Expected one counter anchor: ${anchor}`);
  return source.replace(anchor, replacement);
}

export function transform(type, original, variant) {
  assert.ok(pins.variants[variant], 'Unknown current build variant');
  const expected = type === 'postgresIndex' ? pins.postgres.files['src/index.js']
    : type === 'postgresConnection' ? pins.postgres.files['src/connection.js']
    : pins.variants[variant].modules[type]?.sha256;
  assert.ok(expected, `Unknown counter module ${type}`);
  assert.equal(hash(original), expected, `Unqualified ${variant} ${type} bytes`);
  let source = original;
  if (type === 'queue') {
    source = replaceExactly(source, 'class AsyncQueue {', `class AsyncQueue {\nconstructor() { ${call}.registerQueue(this); }\n__resourceCounterDepth() { return this.#values.length; }`);
    source = replaceExactly(source, 'const waiter = this.#waiters.shift();', `${call}.normalized();\nconst waiter = this.#waiters.shift();`);
    source = replaceExactly(source, 'this.#values.push(value);', `{ this.#values.push(value); ${call}.observeQueue(); }`);
  } else if (type === 'port') {
    source = replaceExactly(source, 'await this.#onEventPersistence?.(', `${call}.postCommit(event, persisted.disposition);\nawait this.#onEventPersistence?.(`);
    source += `\n// DIAGNOSTIC ONLY: public call elapsed includes awaited callbacks and can overlap.
for (const method of ['appendEvent', 'appendEvents']) {
  const original = PaperclipControlPlanePort.prototype[method];
  if (typeof original !== 'function') continue;
  Object.defineProperty(PaperclipControlPlanePort.prototype, method, {
    configurable: true, writable: true, value: function(...args) {
      const size = method === 'appendEvents' ? (Array.isArray(args[0]) ? args[0].length : 0) : 1;
      return ${call}.portAppend(method, size, () => Reflect.apply(original, this, args));
    }
  });
}\n`;
  } else if (type === 'runlog') {
    source = replaceExactly(source, 'fs.appendFile(absPath, persisted, "utf8")', `${call}.localAppend(() => fs.appendFile(absPath, persisted, "utf8"), Buffer.byteLength(persisted, 'utf8'))`);
  } else if (type === 'postgresConnection') {
    source = replaceExactly(source, "typeof options.debug === 'function' && options.debug(id, string, parameters, types)", `${call}.queryBuild(string)\n    typeof options.debug === 'function' && options.debug(id, string, parameters, types)`);
  } else if (type === 'postgresIndex') {
    source = replaceExactly(source, "    !fn && (fn = options, options = '')", `    !fn && (fn = options, options = '')\n    const __counterBegin = ${call}.beginStarted()`);
    source = replaceExactly(source, "      await sql.unsafe('begin ' + options.replace(/[^a-z ]/ig, ''), [], { onexecute }).execute()", "      await sql.unsafe('begin ' + options.replace(/[^a-z ]/ig, ''), [], { onexecute }).execute()" + `\n      ${call}.beginAck(__counterBegin)`);
    source = replaceExactly(source, '      return await Promise.race([\n        scope(connection, fn),', '      const __counterResult = await Promise.race([\n        scope(connection, fn),');
    source = replaceExactly(source, '      ])\n    } catch (error) {\n      throw error\n    }\n\n    async function scope', `      ])\n      ${call}.beginResolved(__counterBegin)\n      return __counterResult\n    } catch (error) {\n      ${call}.beginRejected(__counterBegin)\n      throw error\n    }\n\n    async function scope`);
    source = replaceExactly(source, '      } catch (e) {\n        await (name\n          ? sql`rollback to ${ sql(name) }`\n          : sql`rollback`\n        )\n        throw e instanceof PostgresError && e.code === \'25P02\' && uncaughtError || e\n      }', `      } catch (e) {
        ${call}.workRejected(__counterScope)
        try {
          await (name ? sql\`rollback to \${ sql(name) }\` : sql\`rollback\`)
          ${call}.rollbackAck(__counterScope)
        } catch (__counterRollbackError) {
          ${call}.rollbackFailed(__counterScope)
          throw __counterRollbackError
        }
        throw e instanceof PostgresError && e.code === '25P02' && uncaughtError || e
      }`);
    source = replaceExactly(source, "      if (!name) {\n        prepare\n          ? await sql`prepare transaction '${ sql.unsafe(prepare) }'`\n          : await sql`commit`\n      }", `      if (!name) {
        ${call}.completionRequested(__counterScope, Boolean(prepare))
        try {
          prepare
            ? await sql\`prepare transaction '\${ sql.unsafe(prepare) }'\`
            : await sql\`commit\`
        } catch (__counterCompletionError) {
          ${call}.completionFailed(__counterScope)
          throw __counterCompletionError
        }
        ${call}.completionAck(__counterScope)
      } else {
        ${call}.nestedSucceeded(__counterScope)
      }`);
    const start = '      name && await sql`savepoint ${ sql(name) }`\n', end = '\n      function savepoint(name, fn) {';
    assert.equal(source.split(start).length - 1, 1); assert.equal(source.split(end).length - 1, 1);
    const from = source.indexOf(start), to = source.indexOf(end, from);
    // Keep uncaughtError/result in the original function scope: handler() below
    // closes over uncaughtError. Only the await/work/completion body is wrapped.
    const body = source.slice(from, to);
    source = source.slice(0, from) + `      const __counterScope = ${call}.scopeStarted(__counterBegin, Boolean(name))\n      try {\n` + body + `\n      } finally { ${call}.scopeFinished(__counterScope) }\n` + source.slice(to);
  } else assert.equal(type, 'resolver'); // Hash-qualified original resolver bytes; never a replacement.
  return source;
}
