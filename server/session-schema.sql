CREATE TABLE IF NOT EXISTS broadcast_sessions (handle TEXT PRIMARY KEY,post_id TEXT NOT NULL,space_id TEXT NOT NULL,started_at INTEGER NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS broadcast_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT,post_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(post_id,id));
CREATE INDEX IF NOT EXISTS broadcast_messages_post_seq ON broadcast_messages(post_id,seq);
CREATE TABLE IF NOT EXISTS visitor_daily(day TEXT NOT NULL,visitor TEXT NOT NULL,country TEXT NOT NULL,referrer TEXT NOT NULL,path TEXT NOT NULL,views INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(day,visitor,country,referrer,path));
CREATE TABLE IF NOT EXISTS collector_errors(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,key TEXT NOT NULL,error TEXT NOT NULL);
