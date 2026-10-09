// Minimal path-style S3 stand-in for tests: GET object + ListObjectsV2 (prefix/delimiter), SigV4 header check.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeS3 {
  url: string;
  objects: Map<string, Buffer>;
  requests: { method: string; path: string; authorized: boolean }[];
  close(): Promise<void>;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeS3(bucket: string): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: FakeS3['requests'] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const u = new URL(req.url ?? '/', 'http://local');
    const auth = String(req.headers.authorization ?? '');
    const authorized = auth.startsWith('AWS4-HMAC-SHA256 Credential=') && !!req.headers['x-amz-date'] && !!req.headers['x-amz-content-sha256'];
    requests.push({ method: req.method ?? '', path: u.pathname + u.search, authorized });
    if (!authorized) {
      res.writeHead(403).end('<Error><Code>AccessDenied</Code></Error>');
      return;
    }
    const prefix = `/${bucket}/`;
    if (!u.pathname.startsWith(prefix) && u.pathname !== `/${bucket}`) {
      res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }
    const key = decodeURIComponent(u.pathname.slice(prefix.length));
    if (key === '' && u.searchParams.get('list-type') === '2') {
      const p = u.searchParams.get('prefix') ?? '';
      const d = u.searchParams.get('delimiter') ?? '';
      const common = new Set<string>();
      for (const k of objects.keys()) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const i = d ? rest.indexOf(d) : -1;
        if (i >= 0) common.add(p + rest.slice(0, i + 1));
      }
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>` +
        [...common].sort().map((c) => `<CommonPrefixes><Prefix>${xmlEscape(c)}</Prefix></CommonPrefixes>`).join('') + '</ListBucketResult>';
      res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
      return;
    }
    const obj = objects.get(key);
    if (!obj) {
      res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    res.writeHead(200, { 'content-length': obj.length }).end(obj);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
