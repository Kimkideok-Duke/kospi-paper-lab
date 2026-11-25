import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest('hex');
const cookieName = 'marketlab_session';
const day = 86400000;
export function createAccounts(root, ownerCredentials) {
  const db = new DatabaseSync(join(root, 'accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS api_bindings(client_hash TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id));`);
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    if (!ownerCredentials?.username || !/^[a-f0-9]{64}$/i.test(ownerCredentials.passwordHash ?? '')) throw Error('Owner bootstrap credentials required');
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('owner', ownerCredentials.username, ownerCredentials.salt, ownerCredentials.passwordHash, 'owner', Date.now());
  }
  const attempts = new Map();
  let hashing = 0;
  async function passwordHash(password, salt) {
    if (hashing >= 8) throw Object.assign(Error('잠시 후 다시 시도해 주세요.'), { status: 429 });
    hashing++;
    try { return Buffer.from(await scrypt(password, salt, 32)); } finally { hashing--; }
  }
  function user(request) {
    const token = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare('SELECT u.id,u.username,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token), Date.now()) ?? null;
  }
  function cookie(request, token, maxAge = 7 * 86400) {
    return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` + (request.headers.get('x-forwarded-proto') === 'https' ? '; Secure' : '');
  }
  function session(request, id) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), id, Date.now() + 7 * day);
    return cookie(request, token);
  }
  const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
  const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'cache-control': 'no-store', ...headers } });
  function throttle(request, username) {
    const address = request.headers.get('x-real-ip') ?? 'local';
    const ipKey = 'ip:' + digest(address), ipAttempt = attempts.get(ipKey), timestamp = Date.now();
    if (ipAttempt?.until > timestamp && ipAttempt.count >= 64) fail('요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429);
    attempts.set(ipKey, { count: ipAttempt?.until > timestamp ? ipAttempt.count + 1 : 1, until: ipAttempt?.until > timestamp ? ipAttempt.until : timestamp + 15 * 60000 });
    const key = digest(address + ':' + username);
    const old = attempts.get(key), now = Date.now();
    if (old?.until > now && old.count >= 8) fail('로그인 시도가 많습니다. 15분 뒤 다시 시도해 주세요.', 429);
    if (attempts.size > 1000) for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
    attempts.set(key, { count: old?.until > now ? old.count + 1 : 1, until: old?.until > now ? old.until : now + 15 * 60000 });
    return key;
  }
  async function handle(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/auth/')) return null;
    try {
      const current = user(request);
      if (path === '/api/auth/me' && request.method === 'GET') return current ? json(current) : json({ error: '로그인이 필요합니다.' }, 401);
      if (request.method !== 'POST') return json({ error: '페이지를 찾을 수 없습니다.' }, 404);
      if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') fail('이 사이트에서 요청해 주세요.', 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) fail('요청 형식을 확인해 주세요.');
      const text = await request.text(); if (text.length > 10000) fail('요청이 너무 깁니다.');
      let body; try { body = JSON.parse(text); } catch { fail('요청 형식을 확인해 주세요.'); }
      if (!body || typeof body !== 'object') fail('요청 형식을 확인해 주세요.');
      if (path === '/api/auth/logout') {
        const token = (request.headers.get('cookie') ?? '').match(/(?:^|;\s*)marketlab_session=([a-f0-9]{64})(?:;|$)/)?.[1];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
        return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0) });
      }
      if (path === '/api/auth/login' || path === '/api/auth/register') {
        const { username, password } = body;
        if (typeof username !== 'string' || !/^[a-z0-9_-]{3,40}$/.test(username) || typeof password !== 'string' || password.length > 128) fail('아이디와 비밀번호를 확인해 주세요.');
        const key = throttle(request, username);
        if (path.endsWith('/login')) {
          const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
          const hash = await passwordHash(password, row?.salt ?? 'marketlab-unknown-user');
          if (!row || !timingSafeEqual(hash, Buffer.from(row.password_hash, 'hex'))) fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
          attempts.delete(key);
          return json({ ok: true }, 200, { 'set-cookie': session(request, row.id) });
        }
        if (password.length < 12) fail('비밀번호는 12자 이상 입력해 주세요.');
        if (typeof body.invite !== 'string' || !/^[a-f0-9]{64}$/.test(body.invite)) fail('유효한 초대 링크가 필요합니다.');
        const invitation = db.prepare('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(digest(body.invite), Date.now());
        if (!invitation) fail('초대 링크가 만료되었거나 이미 사용됐습니다.');
        const salt = randomBytes(24).toString('hex'), hash = await passwordHash(password, salt), id = randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          const used = db.prepare('UPDATE invites SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(Date.now(), digest(body.invite), Date.now());
          if (!used.changes) fail('초대 링크를 다시 확인해 주세요.');
          if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail('사용할 수 없는 아이디입니다.');
          db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, username, salt, hash.toString('hex'), 'member', Date.now());
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        attempts.delete(key);
        return json({ ok: true }, 201, { 'set-cookie': session(request, id) });
      }
      if (!current) fail('로그인이 필요합니다.', 401);
      if (path === '/api/auth/invites') {
        if (current.role !== 'owner') fail('소유자만 사용자를 초대할 수 있습니다.', 403);
        const invite = randomBytes(32).toString('hex'), expiresAt = Date.now() + day;
        db.prepare('INSERT INTO invites VALUES(?,?,NULL)').run(digest(invite), expiresAt);
        return json({ invite, expiresAt });
      }
      if (path === '/api/auth/password') {
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128 || typeof body.currentPassword !== 'string' || body.currentPassword.length > 128) fail('새 비밀번호는 12~128자로 입력해 주세요.');
        const key = throttle(request, current.username), row = db.prepare('SELECT * FROM users WHERE id=?').get(current.id);
        if (!timingSafeEqual(await passwordHash(body.currentPassword, row.salt), Buffer.from(row.password_hash, 'hex'))) fail('현재 비밀번호가 올바르지 않습니다.', 401);
        const salt = randomBytes(24).toString('hex'), hash = await passwordHash(body.password, salt);
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('UPDATE users SET salt=?,password_hash=? WHERE id=?').run(salt, hash.toString('hex'), current.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
        attempts.delete(key);
        return json({ ok: true }, 200, { 'set-cookie': session(request, current.id) });
      }
      return json({ error: '페이지를 찾을 수 없습니다.' }, 404);
    } catch (e) { return json({ error: e.status ? e.message : '요청을 처리하지 못했습니다.' }, e.status ?? 500); }
  }
  return { handle, user, users: () => db.prepare('SELECT id,username,role FROM users ORDER BY created_at').all(),
    reserveClient(id, clientId) {
      const hash = digest(clientId), row = db.prepare('SELECT user_id FROM api_bindings WHERE client_hash=?').get(hash);
      if (row && row.user_id !== id) throw Object.assign(Error('이미 다른 사용자에게 연결된 API입니다. 본인의 API를 사용해 주세요.'), { status: 409 });
      const previous = db.prepare('SELECT client_hash FROM api_bindings WHERE user_id=?').get(id)?.client_hash;
      db.prepare('INSERT INTO api_bindings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET client_hash=excluded.client_hash').run(hash, id);
      return () => { db.prepare('DELETE FROM api_bindings WHERE user_id=?').run(id); if (previous) db.prepare('INSERT INTO api_bindings VALUES(?,?)').run(previous, id); };
    }, close: () => db.close() };
}
