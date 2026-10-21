// Lambda entry point for an API behind CloudFront: a Function URL with response
// streaming. Shared by the website API and the BMS API.
import { encodeBody, contentTypeFor } from './http.js';
import { loadSecrets } from './secrets.js';

function toRequest(event) {
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : '';
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: event.requestContext?.http?.method || 'GET',
    path: event.rawPath || '/',
    query: event.queryStringParameters || {},
    headers, body, rawBody: raw,
  };
}

/* global awslambda */
export const lambdaHandler = (handle) => awslambda.streamifyResponse(async (event, responseStream) => {
  await loadSecrets();
  const req = toRequest(event);
  // Only CloudFront knows the origin header, so the function URL cannot be called directly.
  const res = process.env.ORIGIN_VERIFY && req.headers['x-origin-verify'] !== process.env.ORIGIN_VERIFY
    ? { status: 403, body: { error: 'Forbidden' }, headers: {} }
    : await handle(req);
  if (res.stream) {
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'content-type': res.contentType || 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    });
    await res.stream((chunk) => out.write(Buffer.isBuffer(chunk) ? chunk : `${JSON.stringify(chunk)}\n`));
    out.end();
    return;
  }
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: res.status,
    headers: { 'content-type': contentTypeFor(res), 'cache-control': 'no-store', ...res.headers },
  });
  out.write(encodeBody(res.body));
  out.end();
});
