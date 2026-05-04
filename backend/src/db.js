import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.DATABASE_URL || path.join(__dirname, '..', 'courseverse.sqlite');
export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT,
    role TEXT DEFAULT 'student' CHECK(role IN ('student','instructor','admin')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','blocked','deleted')),
    avatar TEXT,
    pending_avatar TEXT,
    bio TEXT DEFAULT '',
    headline TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    level TEXT DEFAULT 'Beginner',
    price REAL DEFAULT 0,
    thumbnail TEXT,
    preview_video TEXT,
    lessons TEXT DEFAULT '[]',
    instructor_id INTEGER NOT NULL,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected','hidden','deleted')),
    rejection_reason TEXT,
    rating REAL DEFAULT 4.8,
    students_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(instructor_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS enrollments (user_id INTEGER, course_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,course_id));
  CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, course_id INTEGER, rating INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS instructor_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, status TEXT DEFAULT 'pending', note TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER, receiver_id INTEGER, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(requester_id, receiver_id));
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER, body TEXT, image_url TEXT, sticker TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, seen_at TEXT);
  CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT, visibility TEXT DEFAULT 'public', max_participants INTEGER DEFAULT 20, allow_invite_link INTEGER DEFAULT 1, waiting_room INTEGER DEFAULT 0, friends_only INTEGER DEFAULT 0, host_controls INTEGER DEFAULT 1, locked INTEGER DEFAULT 0, host_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS room_members (room_id INTEGER, user_id INTEGER, role TEXT DEFAULT 'participant', status TEXT DEFAULT 'joined', created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(room_id,user_id));
  CREATE TABLE IF NOT EXISTS room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER, user_id INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS room_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER, sender_id INTEGER, receiver_id INTEGER, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, title TEXT, body TEXT, link TEXT, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS banned_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER, target_type TEXT, target_id INTEGER, reason TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS moderation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER, action TEXT, target_type TEXT, target_id INTEGER, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
}

export const one = (sql, params = []) => db.prepare(sql).get(params);
export const all = (sql, params = []) => db.prepare(sql).all(params);
export const run = (sql, params = []) => db.prepare(sql).run(params);
