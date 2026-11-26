import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createLocalHost } from '../server/local-host.mjs';
import { createAccounts } from '../server/local-accounts.mjs';
import { createTenants } from '../server/local-tenants.mjs';
import { initialState } from '../server/engine.mjs';
import { defaults } from '../server/paper-model.mjs';
import '../scripts/build.mjs';
const { default: app } = await import('../dist/server/index.js');
const password = 'test-owner-password', salt = 'test-salt';
const ownerCredentials = { username: 'marketlab', salt, passwordHash: scryptSync(password, salt, 32).toString('hex') };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'marketlab-accounts-'));
  const masterKey = 'ab'.repeat(32);
  const host = createLocalHost({ root, masterKey, baseEnv: { MARKETLAB_BATCH: true }, app, ownerCredentials });
  t.after(() => { host.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\marketlab-accounts-') || resolve(root).startsWith(resolve(tmpdir()) + '/marketlab-accounts-')); rmSync(root, { recursive: true }); });
  const call = (path, body, cookie = '', extra = {}) => host.fetch(new Request('http://127.0.0.1:8765' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: 'http://127.0.0.1:8765', 'content-type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const login = async (username = 'marketlab', pass = password) => { const r = await call('/api/auth/login', { username, password: pass }); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; };
  const register = async (owner, username = 'member1') => { const invitation = await (await call('/api/auth/invites', {}, owner)).json(); const r = await call('/api/auth/register', { username, password: 'member-password-123', invite: invitation.invite }); assert.equal(r.status, 201); return { cookie: r.headers.get('set-cookie').split(';')[0], invite: invitation.invite }; };
  return { root, masterKey, host, call, login, register };
}
test('sessions gate every account route, forged identities and cross-origin login cannot bypass authentication', async t => {
  const { call } = fixture(t);
  for (const path of ['/api/state','/api/us/state','/api/quotes','/api/us/quotes','/api/health','/api/reviews','/api/us/reviews','/api/patterns','/api/us/patterns','/api/trade-chart?id=1','/api/us/trade-chart?id=1']) assert.equal((await call(path, undefined, '', { 'oai-authenticated-user-id': 'owner' })).status, 401);
  assert.equal((await call('/')).status, 303);
  assert.equal((await call('/login')).status, 200);
  assert.equal((await call('/api/auth/login', { username: 'marketlab', password }, '', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/auth/login', { username: 'marketlab', password: 'incorrect' })).status, 401);
  assert.equal((await call('/api/auth/register', { username: 'rogue', password: 'some-long-password', invite: '00'.repeat(32) })).status, 400);
});
test('owner data survives migration; invited users have separate KR/US balances, settings, credentials, locks and key material', async t => {
  const { call, login, register, root, masterKey, host } = fixture(t);
  const db = new DatabaseSync(join(root,'campaign.sqlite'));
  const state = initialState(); state.reviews = { "2026-11-25": { date: "2026-11-25", summary: { equityPnl: 100, realized: 50 }, adaptive: { changed: false }, overview: "owner-private-review" } }; state.cash = 7654321; state.trades.push({ id: 'historic-owner', side: 'BUY', amount: 12345, symbol:'005930', name:'Owner private trade', time:Date.parse('2026-11-25T10:00:00+09:00'), quantity:1, price:12345 });
  db.prepare('INSERT INTO campaign(id,state) VALUES(1,?)').run(JSON.stringify(state)); db.close();
  const owner = await login(), member = await register(owner);
  assert.match(owner, /marketlab_session=/);
  const ownerState = await (await call('/api/state', undefined, owner)).json();
  assert.equal((await (await call('/api/reviews?date=2026-11-25', undefined, owner)).json()).report.overview, 'owner-private-review');
  assert.equal((await (await call('/api/reviews?date=2026-11-25', undefined, member.cookie, { 'oai-authenticated-user-id': 'owner' })).json()).report, null);
  assert.equal((await call('/api/reviews?date=invalid', undefined, owner)).status, 400);
  assert.equal((await call('/api/trade-chart?id=historic-owner',undefined,owner)).status,200);
  assert.equal((await call('/api/trade-chart?id=historic-owner&user=owner',undefined,member.cookie,{'oai-authenticated-user-id':'owner'})).status,404);
  assert.equal((await call('/api/us/trade-chart?id=historic-owner',undefined,owner)).status,404);
  for (const path of ['/api/trade-chart','/api/us/trade-chart']) {
    assert.equal((await call(path,undefined,owner)).status,400);
    assert.equal((await call(path+'?id=private-trade',undefined,member.cookie,{'oai-authenticated-user-id':'owner'})).status,404);
  }
  for (const path of ['/api/patterns','/api/us/patterns']) {
    const before = await (await call(path.includes('/us/')?'/api/us/state':'/api/state', undefined, owner)).json();
    const report = await (await call(path, undefined, member.cookie, { 'oai-authenticated-user-id': 'owner' })).json();
    assert.equal(report.summary.completed,0); assert.equal(report.summary.simulated,null);
    assert.equal((await call(path+'?mode=execute', undefined, owner)).status,400);
    const after = await (await call(path.includes('/us/')?'/api/us/state':'/api/state', undefined, owner)).json();
    assert.deepEqual(after.trades,before.trades); assert.deepEqual(after.totals,before.totals);
  }
  assert.equal(ownerState.totals.cash, 7654321); assert.equal(ownerState.trades[0].id, 'historic-owner');
  for(const path of ['/api/state','/api/us/state']) { const s = await (await call(path, undefined, member.cookie, { 'oai-authenticated-user-id': 'owner' })).json(); assert.equal(s.totals.cash, 10000000); assert.equal(s.trades.length,0); assert.equal(s.connected,false); }
  assert.equal((await call('/api/auth/invites', {}, member.cookie)).status,403);
  assert.equal((await call('/api/auth/register', { username: 'second', password: 'long-password-123', invite: member.invite })).status,400);
  assert.equal((await call('/api/model', { ...defaults('KR'), commissionBps: 5 }, member.cookie)).status,200);
  assert.equal((await (await call('/api/state',undefined,member.cookie)).json()).analytics.model.config.commissionBps,5);
  assert.notEqual((await (await call('/api/state',undefined,owner)).json()).analytics.model?.config?.commissionBps,5);
  const accounts = createAccounts(root), users = accounts.users(), tenants = createTenants(root,masterKey);
  const user = users.find(u=>u.username==='member1');
  assert.notEqual(tenants.get(user.id).MARKETLAB_KEY,tenants.get('owner').MARKETLAB_KEY);
  assert.throws(()=>tenants.get('../owner'));
  accounts.reserveClient('owner','owner-client');
  assert.equal((await call('/api/connect',{id:'owner-client',secret:'not-a-real-secret'},member.cookie)).status,409);
  const record = await tenants.get(user.id).DB.prepare('SELECT * FROM campaign WHERE id=1').first();
  assert.equal(record.secrets,null); assert.equal(record.lock_owner,null);
  const visited=[]; await host.runAll(async env => { visited.push(await env.DB.prepare("SELECT state FROM campaign WHERE id=1").first()); }, Date.now());
  assert.equal(visited.length,2);
  assert.equal(JSON.parse(visited[0].state).cash,7654321);
  assert.equal(JSON.parse(visited[1].state).cash,10000000);
  tenants.close(); accounts.close();
});
test('logout revokes server sessions; password changes revoke other devices and cookies are secure on HTTPS', async t => {
  const { call, login } = fixture(t);
  const first=await login(), second=await login();
  const response=await call('/api/auth/password',{currentPassword:password,password:'new-owner-password-123'},first,{'x-forwarded-proto':'https'});
  assert.equal(response.status,200); const cookie=response.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/); assert.match(cookie,/Secure/);
  assert.equal((await call('/api/auth/me',undefined,second)).status,401);
  const fresh=cookie.split(';')[0]; assert.equal((await call('/api/auth/me',undefined,fresh)).status,200);
  assert.equal((await call('/api/auth/logout',{},fresh)).status,200);
  assert.equal((await call('/api/auth/me',undefined,fresh)).status,401);
});
test('repeated failed logins are throttled without storing plaintext passwords', async t => {
  const { call, root } = fixture(t);
  for(let i=0;i<8;i++) assert.equal((await call('/api/auth/login',{username:'marketlab',password:'wrong'})).status,401);
  assert.equal((await call('/api/auth/login',{username:'marketlab',password})).status,429);
  const db=new DatabaseSync(join(root,'accounts.sqlite'),{readOnly:true});
  assert.notEqual(db.prepare('SELECT password_hash FROM users').get().password_hash,password); db.close();
});
