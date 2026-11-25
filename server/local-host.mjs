import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { createAccounts } from './local-accounts.mjs';
import { createTenants } from './local-tenants.mjs';
const publicAssets = { '/login': ['login.html', 'text/html'], '/auth.js': ['auth.js', 'text/javascript'], '/auth.css': ['auth.css', 'text/css'] };
export function createLocalHost({ root, masterKey, baseEnv, app, ownerCredentials }) {
  if (!ownerCredentials) {
    const configPath = process.env.MARKETLAB_OWNER_CONFIG ?? join(process.env.LOCALAPPDATA ?? root, 'MarketLabHost', 'config.json');
    if (existsSync(configPath)) ownerCredentials = JSON.parse(readFileSync(configPath, 'utf8'));
    else if (!existsSync(join(root, 'accounts.sqlite'))) {
      const password = randomBytes(18).toString('base64url'), salt = randomBytes(24).toString('hex');
      ownerCredentials = { username: 'owner', salt, passwordHash: scryptSync(password, salt, 32).toString('hex') };
      writeFileSync(join(root, 'owner-login.txt'), `Username: owner\nPassword: ${password}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  const accounts = createAccounts(root, ownerCredentials), tenants = createTenants(root, masterKey);
  const userEnv = id => ({ ...baseEnv, ...tenants.get(id) });
  const ownerDb = tenants.get('owner');
  // Reserve the migrated owner's existing key without sending it to the client or issuing a new token.
  const saved = ownerDb.DB.prepare('SELECT secrets FROM campaign WHERE id=1');
  const initialize = async () => {
    const row = await saved.first();
    if (row?.secrets) {
      const [iv, ciphertext] = row.secrets.split('.').map(v => Buffer.from(v, 'base64'));
      const key = await crypto.subtle.importKey('raw', Buffer.from(masterKey, 'hex'), 'AES-GCM', false, ['decrypt']);
      const credentials = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('toss:keys') }, key, ciphertext)));
      accounts.reserveClient('owner', credentials.id);
    }
  };
  const headers = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  const file = (name, type) => new Response(readFileSync(new URL('../web/' + name, import.meta.url)), { headers: { ...headers, 'content-type': type + '; charset=utf-8' } });
  const connecting = new Set();
  async function fetch(request) {
    const path = new URL(request.url).pathname;
    if (Object.hasOwn(publicAssets, path) && request.method === 'GET') return file(...publicAssets[path]);
    if (['/app.css', '/mark.svg'].includes(path) && request.method === 'GET') return app.fetch(request, baseEnv);
    const auth = await accounts.handle(request); if (auth) return auth;
    const user = accounts.user(request);
    if (!user) return path.startsWith('/api/') ? Response.json({ error: '로그인이 필요합니다.' }, { status: 401, headers }) : new Response(null, { status: 303, headers: { ...headers, location: '/login' } });
    if (path === '/account' && request.method === 'GET') return file('account.html', 'text/html');
    const scoped = new Headers(request.headers);
    scoped.set('oai-authenticated-user-id', user.id);
    const authenticated = new Request(request.clone(), { headers: scoped });
    let rollback;
    if (path === '/api/connect' && request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: '이 사이트에서 요청해 주세요.' }, { status: 403, headers });
      if (connecting.has(user.id)) return Response.json({ error: 'API 연결을 처리 중입니다.' }, { status: 409, headers });
      connecting.add(user.id);
      try {
        const body = await request.clone().json();
        if (typeof body.id === 'string' && body.id.trim() && body.id.length <= 512) rollback = accounts.reserveClient(user.id, body.id.trim());
      } catch (e) { if (e.status) { connecting.delete(user.id); return Response.json({ error: e.message }, { status: e.status, headers }); } }
    }
    try {
      const response = await app.fetch(authenticated, userEnv(user.id));
      if (rollback && !response.ok) rollback();
      return response;
    } catch (e) { if (rollback) rollback(); throw e; }
    finally { if (path === '/api/connect') connecting.delete(user.id); }
  }
  async function runAll(run, time) {
    // Environments are selected on the server, never from a caller-supplied user ID.
    const results = [];
    for (const user of accounts.users()) {
      try { results.push(await run(userEnv(user.id), time)); } catch (e) { results.push({ status: 'error' }); console.error('사용자별 자동 분석 실패:', e.status ?? 'internal'); }
    }
    const status = results.some(r => r?.status === 'error') ? 'error' : results.some(r => r?.status === 'ok') ? 'ok'
      : results.some(r => r?.status === 'duplicate') ? 'duplicate' : results.every(r => r?.status === 'waiting') ? 'waiting' : 'outside';
    return { status, message: status === 'error' ? '일부 사용자의 자동 분석을 완료하지 못했습니다.' : '사용자별 모의 분석을 처리했습니다.', trades: [] };
  }
  return { fetch, initialize, runAll, close() { accounts.close(); tenants.close(); } };
}
