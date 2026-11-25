// The application validates individual sessions. This gateway never assigns an owner identity.
import http from 'node:http';
const backend = 'http://127.0.0.1:8765';
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  const expected = 'https://' + req.headers.host;
  const origin = req.headers.origin;
  if ((origin && origin !== expected && origin !== 'http://127.0.0.1:8766') || (!['GET', 'HEAD'].includes(req.method) && !origin)) {
    res.writeHead(403).end('Same-origin request required.'); return;
  }
  const headers = { ...req.headers, host: '127.0.0.1:8765', 'x-forwarded-proto': 'https', 'x-real-ip': req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress };
  delete headers.authorization; delete headers['oai-authenticated-user-id']; delete headers['x-forwarded-host'];
  if (origin) headers.origin = backend;
  const upstream = http.request(backend + req.url, { method: req.method, headers }, response => {
    const responseHeaders = { ...response.headers, 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
    delete responseHeaders['access-control-allow-origin'];
    res.writeHead(response.statusCode, responseHeaders); response.pipe(res);
  });
  upstream.setTimeout(60000, () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Backend unavailable.'); });
  req.on('aborted', () => upstream.destroy());
  let bytes = 0;
  req.on('data', chunk => { bytes += chunk.length; if (bytes > 10000) { upstream.destroy(); if (!res.headersSent) res.writeHead(413); res.end(); req.destroy(); } });
  req.pipe(upstream);
});
server.listen(8766, '127.0.0.1', () => console.log('Session gateway listening on 127.0.0.1:8766'));
