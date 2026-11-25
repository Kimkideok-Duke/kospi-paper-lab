import { DatabaseSync } from "node:sqlite";

// Open explicitly with a separate database path when live trading is authorized.
// No database is opened and no migration runs merely by importing this module.
export function openLiveOrderStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS live_orders (
      account TEXT NOT NULL, client_id TEXT NOT NULL, action TEXT NOT NULL,
      fingerprint TEXT NOT NULL, payload TEXT NOT NULL, day TEXT NOT NULL,
      amount INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      state TEXT NOT NULL, result TEXT, error_code TEXT,
      PRIMARY KEY(account, client_id)
    );
    CREATE INDEX IF NOT EXISTS live_orders_day ON live_orders(account, day);
  `);
  const select = db.prepare("SELECT * FROM live_orders WHERE account = ? AND client_id = ?");
  const decode = row => row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : null;
  return {
    get(account, clientId) { return decode(select.get(account, clientId)); },
    reserve({ account, clientId, action, fingerprint, payload, day, amount, now, dailyLimit }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = decode(select.get(account, clientId));
        if (existing) {
          db.exec("COMMIT");
          return { existing };
        }
        // An unresolved submission survives restarts and prevents further buys/sells.
        // Cancelling a known order remains possible while another submission is uncertain.
        if (action === "CREATE" && db.prepare(`SELECT 1 FROM live_orders WHERE account = ?
          AND state IN ('PREPARING', 'SUBMITTING', 'UNKNOWN') LIMIT 1`).get(account)) {
          throw new Error("UNRESOLVED_ORDER");
        }
        if (action === "CANCEL" && db.prepare(`SELECT 1 FROM live_orders WHERE account = ?
          AND action = 'CANCEL' AND json_extract(payload, '$.originalOrderId') = ?
          AND state != 'PRECHECK_FAILED' LIMIT 1`).get(account, payload.originalOrderId)) {
          throw new Error("CANCEL_ALREADY_REQUESTED");
        }
        const spent = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amount FROM live_orders
          WHERE account = ? AND day = ? AND action = 'CREATE' AND state != 'PRECHECK_FAILED'`).get(account, day).amount;
        if (action === "CREATE" && spent + amount > dailyLimit) throw new Error("DAILY_LIMIT");
        db.prepare(`INSERT INTO live_orders
          (account, client_id, action, fingerprint, payload, day, amount, created_at, updated_at, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARING')`)
          .run(account, clientId, action, fingerprint, JSON.stringify(payload), day, amount, now, now);
        db.exec("COMMIT");
        return { existing: null };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    update(account, clientId, { state, result = null, errorCode = null, now }) {
      const changed = db.prepare(`UPDATE live_orders SET state = ?, result = ?, error_code = ?, updated_at = ?
        WHERE account = ? AND client_id = ?`).run(state, result ? JSON.stringify(result) : null, errorCode, now, account, clientId);
      if (changed.changes !== 1) throw new Error("ORDER_RECORD_MISSING");
      return this.get(account, clientId);
    },
    close() { db.close(); },
  };
}
