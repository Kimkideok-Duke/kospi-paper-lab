CREATE TABLE campaign (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  secrets TEXT,
  access_token TEXT,
  lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
