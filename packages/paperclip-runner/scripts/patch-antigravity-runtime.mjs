import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const ANTIGRAVITY_PATCH_SCHEMA = "paperclip.antigravity.native_patch.v1";
export const ANTIGRAVITY_PATCH_VERSION = "1.4.3-paperclip.5";
const SERVER_HASH = "1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954";
const HARNESS_HASH = "9e8fdc6e20a3262ca0a771850ca4a8414ca839a642cc964ec5c547cc2c33c200";
const ACP_ROOT = "google3/cloud/developer_experience/antigravity_extensions/acp_server/";
const SDK_ROOT = "google3/third_party/py/google/antigravity/connections/local/";
const SERVER_SOURCE = ACP_ROOT + "server.py";
const SDK_SOURCE = SDK_ROOT + "local_connection.py";
const EVENT_PROCESSOR_SOURCE = SDK_ROOT + "event_processor.py";
const ADMISSION_SOURCE = ACP_ROOT + "paperclip_admission.py";
const REMOVED_BYTECODE = new Set([
  ACP_ROOT + "__pycache__/server.cpython-314.pyc",
  SDK_ROOT + "__pycache__/local_connection.cpython-314.pyc",
  SDK_ROOT + "__pycache__/event_processor.cpython-314.pyc",
]);
const digest = value => createHash("sha256").update(value).digest("hex");
const fail = message => { throw new Error(`Antigravity native patch: ${message}`); };

export function antigravityParSection(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) fail("expected the pinned ARM64 Mach-O executable");
  const commandCount = bytes.readUInt32LE(16);
  let cursor = 32;
  const sections = [];
  for (let index = 0; index < commandCount; index++) {
    if (cursor + 8 > bytes.length) fail("truncated Mach-O command");
    const command = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > bytes.length) fail("invalid Mach-O command bounds");
    if (command === 0x19) {
      if (size < 72) fail("truncated Mach-O segment");
      const count = bytes.readUInt32LE(cursor + 64);
      if (72 + count * 80 > size) fail("invalid Mach-O sections");
      for (let section = 0; section < count; section++) {
        const offset = cursor + 72 + section * 80;
        if (bytes.subarray(offset, offset + 16).toString("utf8").split("\0")[0] !== ".par_data") continue;
        const length = Number(bytes.readBigUInt64LE(offset + 40));
        const start = bytes.readUInt32LE(offset + 48);
        if (!Number.isSafeInteger(length) || length < 22 || start + length > bytes.length) fail("invalid embedded Python archive bounds");
        sections.push({ start, length });
      }
    }
    cursor += size;
  }
  if (sections.length !== 1) fail("expected exactly one embedded Python archive");
  return sections[0];
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

/** Operates only after the complete vendor executable's SHA-256 is verified. */
export function antigravityEmbeddedZip(bytes) {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 20)) fail("unsupported embedded ZIP ending");
  const count = bytes.readUInt16LE(end + 10);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 8) !== count || centralOffset + bytes.readUInt32LE(end + 12) !== end) fail("invalid embedded ZIP index");
  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("invalid embedded ZIP entry");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedLength = bytes.readUInt32LE(cursor + 20);
    const length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & ~0x800) || ![0, 8].includes(method) || local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50) fail("unsupported embedded ZIP entry");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (names.has(name) || !Buffer.from(name).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))) fail("duplicate or invalid embedded ZIP name");
    names.add(name);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (dataStart + compressedLength > centralOffset) fail("invalid embedded ZIP payload bounds");
    entries.push({ name, method, length, checksum: bytes.readUInt32LE(cursor + 16), localHeader: bytes.subarray(local, dataStart), payload: bytes.subarray(dataStart, dataStart + compressedLength), central: bytes.subarray(cursor, next) });
    cursor = next;
  }
  if (cursor !== end) fail("invalid embedded ZIP index length");
  return entries;
}

function content(entry) {
  const value = entry.method === 8 ? inflateRawSync(entry.payload, { maxOutputLength: entry.length }) : entry.payload;
  if (value.length !== entry.length || crc32(value) !== entry.checksum) fail("embedded source integrity mismatch");
  return value;
}

function storedEntry(name, value) {
  const filename = Buffer.from(name);
  const checksum = crc32(value);
  const localHeader = Buffer.alloc(30 + filename.length);
  localHeader.writeUInt32LE(0x04034b50);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(33, 12); // 1980-01-01, stable ZIP date.
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(value.length, 18);
  localHeader.writeUInt32LE(value.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  filename.copy(localHeader, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(value.length, 20);
  central.writeUInt32LE(value.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  filename.copy(central, 46);
  return { name, method: 0, length: value.length, checksum, localHeader, payload: value, central };
}

export function replaceAntigravitySource(source, needle, replacement) {
  if (source.split(needle).length !== 2) fail("pinned native source anchor changed");
  return source.replace(needle, replacement);
}

export function antigravityPatchedSources(server, sdk, eventProcessor) {
  replaceAntigravitySource(server, "class AgyAdapter(Agent):", "class AgyAdapter(Agent):");
  server = replaceAntigravitySource(server,
`    # Immediately flush open tool calls on error step (validation/execution
    # failure).
    if step.status == sdk_types_module.StepStatus.ERROR:
      if open_tool_calls:
        logging.warning(
            "Step error encountered; flushing open tool calls: %s. Error: %s",
            open_tool_calls,
            step.error,
        )
        for tc_id in list(open_tool_calls):
          open_tool_calls.pop(tc_id, None)
          await self._client.session_update(
              session_id=session_id,
              update=schema.ToolCallProgress(
                  session_update="tool_call_update",
                  tool_call_id=tc_id,
                  raw_output=step.error or "Tool execution failed",
                  status="failed",
              ),
          )

`,
`    # A step error belongs only to that step's tool calls. The terminal block
    # below resolves their execution/permission identities. Unattributed errors
    # remain diagnostics; turn cleanup still settles unfinished work.
    if step.status == sdk_types_module.StepStatus.ERROR:
      logging.warning(
          "Step error encountered for %s. Error: %s", step.id, step.error
      )

`,
  );
  server += "\n\n# Paperclip's owned admission patch, applied to this pinned release only.\nfrom google3.cloud.developer_experience.antigravity_extensions.acp_server import paperclip_admission\npaperclip_admission.install(AgyAdapter)\n";
  sdk = replaceAntigravitySource(sdk,
    "    harness_config = self._build_harness_config()\n    process, ws, ws_url = await self._spawn_harness_and_connect_ws()",
    "    harness_config = self._build_harness_config()\n    from google3.cloud.developer_experience.antigravity_extensions.acp_server import paperclip_admission\n    paperclip_prepared = paperclip_admission.prepare_native_config(harness_config, self)\n    process, ws, ws_url = await self._spawn_harness_and_connect_ws()",
  );
  sdk = replaceAntigravitySource(sdk,
    "        init_resp = init_resp_event.initialize_conversation_response\n        parsed = event_processor.parse_initialize_response(init_resp)",
    "        self._paperclip_native_admission = paperclip_admission.acknowledge_native_config(paperclip_prepared, init_resp_event, harness_config)\n        init_resp = init_resp_event.initialize_conversation_response\n        parsed = event_processor.parse_initialize_response(init_resp)",
  );
  eventProcessor = replaceAntigravitySource(eventProcessor,
`      result = await self._execute_client_tool(tc)
      if result is not None:
        await self._send_tool_results([result])
`,
`      result = await self._execute_client_tool(tc)
      if result is not None:
        # Native StepUpdate events suppress local custom-tool identities. Close
        # ACP file callbacks from their actual result, preserving the same id.
        client_file_result = tc.name in {
            "client_view_file", "client_create_file", "client_edit_file"
        }
        if client_file_result and (
            result.id != tc.id or result.step_id != tc.step_id
        ):
          raise ValueError("Client file result identity differs from its call")
        await self._send_tool_results([result])
        if client_file_result:
          await self.step_queue.put(tool_call_step.model_copy(update={
              "status": types.StepStatus.ERROR
              if result.error is not None else types.StepStatus.DONE,
              "content": result.result if isinstance(result.result, str) else "",
              "error": result.error or "",
              "tool_calls": [tc],
          }))
`,
  );
  return { server, sdk, eventProcessor };
}

function rebuildZip(entries, length) {
  const paddingName = "paperclip_native_patch_padding";
  const used = entries.reduce((total, entry) => total + entry.localHeader.length + entry.payload.length + entry.central.length, 0);
  const paddingLength = length - used - 22 - 30 - 46 - Buffer.byteLength(paddingName) * 2;
  if (paddingLength < 0 || entries.length + 1 > 0xffff) fail("patched source exceeds the pinned native section");
  entries = [...entries, storedEntry(paddingName, Buffer.alloc(paddingLength))];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const central = Buffer.from(entry.central);
    central.writeUInt32LE(offset, 42);
    locals.push(entry.localHeader, entry.payload);
    centrals.push(central);
    offset += entry.localHeader.length + entry.payload.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...locals, central, end]);
  if (result.length !== length) fail("patched section size changed");
  return result;
}

export function patchAntigravityServerBytes(server, admissionSource) {
  if (digest(server) !== SERVER_HASH) fail("official server SHA-256 mismatch");
  const section = antigravityParSection(server);
  const entries = antigravityEmbeddedZip(server.subarray(section.start, section.start + section.length));
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  if (!byName.has(SERVER_SOURCE) || !byName.has(SDK_SOURCE) || !byName.has(EVENT_PROCESSOR_SOURCE) || byName.has(ADMISSION_SOURCE) || [...REMOVED_BYTECODE].some(name => !byName.has(name))) fail("pinned Python runtime layout changed");
  const patched = antigravityPatchedSources(content(byName.get(SERVER_SOURCE)).toString("utf8"), content(byName.get(SDK_SOURCE)).toString("utf8"), content(byName.get(EVENT_PROCESSOR_SOURCE)).toString("utf8"));
  const replacements = new Map([[SERVER_SOURCE, Buffer.from(patched.server)], [SDK_SOURCE, Buffer.from(patched.sdk)], [EVENT_PROCESSOR_SOURCE, Buffer.from(patched.eventProcessor)]]);
  const updated = entries.filter(entry => !REMOVED_BYTECODE.has(entry.name)).map(entry => replacements.has(entry.name) ? storedEntry(entry.name, replacements.get(entry.name)) : entry);
  updated.push(storedEntry(ADMISSION_SOURCE, admissionSource));
  const archive = rebuildZip(updated, section.length);
  const result = Buffer.from(server);
  archive.copy(result, section.start);
  return result;
}

/** Explicit install step; uses Node built-ins and the macOS signing tool only. */
export async function patchAntigravityRuntime({ source, destination } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") fail("only native macOS ARM64 is supported by this patch");
  if (!source || !destination) fail("explicit source and destination directories are required");
  const original = resolve(source);
  const target = resolve(destination);
  const serverPath = join(original, "agy_acp_server.par");
  const harnessPath = join(original, "localharness_external");
  for (const file of [serverPath, harnessPath]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("vendor closure contains links or special files");
  }
  const [server, harness, admission] = await Promise.all([readFile(serverPath), readFile(harnessPath), readFile(new URL("./patch-antigravity-runtime.admission.py", import.meta.url))]);
  if (digest(harness) !== HARNESS_HASH) fail("official helper SHA-256 mismatch");
  const patched = patchAntigravityServerBytes(server, admission);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try { await lstat(target); fail("destination exists; refusing to replace a runtime"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(join(dirname(target), ".antigravity-native-patch-"));
  try {
    const executable = join(temporary, "agy_acp_server.par");
    await writeFile(executable, patched, { mode: 0o700 });
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", executable], { stdio: "pipe", timeout: 30_000 });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", executable], { stdio: "pipe", timeout: 30_000 });
    await writeFile(join(temporary, "localharness_external"), harness, { mode: 0o555 });
    await chmod(executable, 0o555);
    await chmod(join(temporary, "localharness_external"), 0o555);
    const signed = await readFile(executable);
    const result = { schema: ANTIGRAVITY_PATCH_SCHEMA, version: ANTIGRAVITY_PATCH_VERSION, sourceServerSha256: SERVER_HASH, sourceHarnessSha256: HARNESS_HASH, admissionSourceSha256: digest(admission), unsignedServerSha256: digest(patched), serverSha256: digest(signed), harnessSha256: HARNESS_HASH };
    await rename(temporary, target);
    return result;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
