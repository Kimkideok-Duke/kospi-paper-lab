import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
export function createTenants(root, masterKey) {
  const opened = new Map();
  function get(id) {
    if (id !== 'owner' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw Error('Invalid tenant');
    if (!opened.has(id)) {
      const directory = id === 'owner' ? root : join(root, 'users', id);
      mkdirSync(directory, { recursive: true });
      const db = new DatabaseSync(join(directory, 'campaign.sqlite'));
      db.exec(readFileSync(new URL('../drizzle/0000_campaign.sql', import.meta.url), 'utf8').replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
      db.exec(readFileSync(new URL('../drizzle/0001_us_campaign.sql', import.meta.url), 'utf8'));
      const DB = { prepare(sql) { const statement = db.prepare(sql); const bind = (...parameters) => ({ first: async () => statement.get(...parameters) ?? null,
        run: async () => ({ meta: { changes: statement.run(...parameters).changes } }) }); return { ...bind(), bind }; } };
      const MARKETLAB_KEY = id === 'owner' ? masterKey : createHmac('sha256', Buffer.from(masterKey, 'hex')).update('tenant:' + id).digest('hex');
      opened.set(id, { DB, MARKETLAB_KEY, db });
    }
    const { DB, MARKETLAB_KEY } = opened.get(id); return { DB, MARKETLAB_KEY };
  }
  return { get, close() { for (const item of opened.values()) item.db.close(); } };
}
