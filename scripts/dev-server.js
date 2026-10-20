// Local development server: serves the static frontend and the API from one port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const { handle, encodeBody, contentTypeFor } = await import('../src/lib/app.js');

const PORT = Number(process.env.PORT || 8787);
// The static site lives in the sibling PARTWAYS-PORTAL folder.
const STATIC = path.resolve(process.env.PORTAL_DIR || path.join(root, '..', 'PARTWAYS-PORTAL'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { raw, body };
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(STATIC, p));
  if (!file.startsWith(STATIC)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const dirIndex = path.join(file, 'index.html');
      if (!err && st.isDirectory() && fs.existsSync(dirIndex)) { res.writeHead(302, { location: `${urlPath}/` }).end(); return; }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

// Changes whenever a frontend file changes, so open pages offer a reload.
function frontendVersion() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { const st = fs.statSync(p); h.update(`${p}:${st.size}:${st.mtimeMs}`); }
    }
  };
  walk(STATIC);
  return h.digest('hex').slice(0, 12);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/version.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ version: frontendVersion() }));
    return;
  }
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const { raw, body } = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : { raw: '', body: null };
    const out = await handle({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
      body, rawBody: raw,
    });
    if (out.stream) {
      res.writeHead(200, { 'content-type': out.contentType || 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      await out.stream((chunk) => res.write(Buffer.isBuffer(chunk) ? chunk : `${JSON.stringify(chunk)}\n`));
      res.end();
      return;
    }
    res.writeHead(out.status, { 'content-type': contentTypeFor(out), 'cache-control': 'no-store', ...out.headers });
    res.end(encodeBody(out.body));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server error' }));
  }
}).listen(PORT, () => console.log(`PartWays running at http://localhost:${PORT}  (HR workspace: /hr/  ·  employee interview: /interview/)`));
