import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** Adapted from the real-SDK loopback fixture in managed-cloud-prerequisites.test.ts.
 * Small owned objects only; no provider credentials/IAM/durability qualification. */
export function createMaintenanceS3Boundary() {
  const objects = new Map<string, { bytes: Buffer; etag: string; contentType: string }>();
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const errors: string[] = [];
  const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid');
    const operation = { method: req.method!, path: url.pathname + url.search, status: 0 }; requests.push(operation);
    const reply = (status: number, body?: string | Buffer) => { operation.status = status; res.statusCode = status; res.end(body); };
    try {
      if (!url.pathname.startsWith('/maintenance-test/') && url.pathname !== '/maintenance-test') throw new Error('Unknown S3 fixture bucket');
      const key = decodeURIComponent(url.pathname.slice('/maintenance-test/'.length));
      if (req.method === 'GET' && ['/maintenance-test', '/maintenance-test/'].includes(url.pathname) && url.searchParams.get('list-type') === '2'
        && [...url.searchParams.keys()].every(key => ['list-type', 'prefix', 'max-keys', 'x-id'].includes(key))) {
        const keys = [...objects.keys()].filter(key => key.startsWith(url.searchParams.get('prefix') ?? '')).sort();
        if (keys.length > Math.min(1000, Number(url.searchParams.get('max-keys') ?? 1000))) throw new Error('Listing exceeds bounded single-page fixture');
        res.setHeader('content-type', 'application/xml');
        reply(200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${keys.map(key => `<Contents><Key>${xml(key)}</Key><Size>${objects.get(key)!.bytes.length}</Size></Contents>`).join('')}</ListBucketResult>`); return;
      }
      if (!key || [...url.searchParams.keys()].some(key => key !== 'x-id')) throw new Error('Unknown S3 fixture operation/query');
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 17 * 1024 * 1024) throw new Error('S3 fixture object too large'); chunks.push(Buffer.from(chunk)); }
        let bytes = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'aws-chunked') bytes = decodeMaintenanceAwsChunks(bytes);
        else if (req.headers['content-encoding']) throw new Error('Unknown S3 fixture content framing');
        const decodedLength = req.headers['x-amz-decoded-content-length'];
        if (decodedLength !== undefined && Number(decodedLength) !== bytes.length) throw new Error('S3 decoded length mismatch');
        const previous = objects.get(key);
        if ((req.headers['if-none-match'] !== undefined && req.headers['if-none-match'] !== '*')
          || (req.headers['if-match'] !== undefined && typeof req.headers['if-match'] !== 'string')) throw new Error('Unknown conditional S3 request');
        if ((req.headers['if-none-match'] === '*' && previous) || (req.headers['if-match'] && previous?.etag !== req.headers['if-match'])) {
          res.setHeader('content-type', 'application/xml'); reply(412, '<Error><Code>PreconditionFailed</Code></Error>'); return;
        }
        const total = [...objects.values()].reduce((sum, object) => sum + object.bytes.length, 0) - (previous?.bytes.length ?? 0) + bytes.length;
        if (bytes.length > 16 * 1024 * 1024 || total > 256 * 1024 * 1024 || objects.size >= 2048) throw new Error('S3 fixture storage bound exceeded');
        const object = { bytes, etag: `"${createHash('md5').update(bytes).digest('hex')}"`, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') };
        objects.set(key, object); res.setHeader('ETag', object.etag); reply(200); return;
      }
      if (req.method === 'DELETE') { objects.delete(key); reply(204); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Error('Unknown S3 fixture method');
      const object = objects.get(key);
      if (!object) { res.setHeader('content-type', 'application/xml'); reply(404, req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : undefined); return; }
      if (req.headers.range) throw new Error('Range is outside this small-object fixture contract');
      res.setHeader('ETag', object.etag); res.setHeader('content-type', object.contentType); res.setHeader('content-length', object.bytes.length);
      reply(200, req.method === 'GET' ? object.bytes : undefined);
    } catch (error) {
      errors.push(`${req.method} ${url.pathname + url.search}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) { res.setHeader('content-type', 'application/xml'); reply(501, '<Error><Code>NotImplemented</Code></Error>'); } else res.destroy();
    }
  });
  return { server, snapshot: () => ({ boundary: 'Actual AWS SDK HTTP; bounded in-memory S3 protocol fixture, no IAM/SigV4/provider durability proof', requests: requests.map(request => ({ ...request })), errors: [...errors],
    objects: [...objects].map(([key, object]) => ({ key, bytes: object.bytes.length, sha256: createHash('sha256').update(object.bytes).digest('hex') })) }) };
}

/** Decode SDK checksum framing without pretending to validate provider signatures. */
export function decodeMaintenanceAwsChunks(wire: Buffer) {
  const chunks: Buffer[] = []; let offset = 0;
  while (offset < wire.length) {
    const end = wire.indexOf('\r\n', offset); if (end < 0) throw new Error('Malformed AWS chunk header');
    const header = wire.subarray(offset, end).toString('ascii');
    if (!/^[0-9a-f]+$/i.test(header)) throw new Error('Unknown AWS chunk extension');
    const length = Number.parseInt(header, 16); offset = end + 2;
    if (!Number.isSafeInteger(length) || length < 0 || offset + length + 2 > wire.length) throw new Error('Truncated AWS chunk');
    if (length === 0) {
      const trailers = wire.subarray(offset).toString('ascii');
      if (!/^(?:x-amz-checksum-[a-z0-9]+:[A-Za-z0-9+/=]+\r\n)*\r\n$/.test(trailers)) throw new Error('Unknown AWS checksum trailer');
      return Buffer.concat(chunks);
    }
    chunks.push(wire.subarray(offset, offset + length)); offset += length;
    if (wire.subarray(offset, offset + 2).toString('ascii') !== '\r\n') throw new Error('Malformed AWS chunk terminator'); offset += 2;
  }
  throw new Error('Missing AWS final chunk');
}
