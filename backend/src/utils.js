import jwt from 'jsonwebtoken';
import { all, one, run } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
export const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

export function publicUser(user) {
  if (!user) return null;
  const { password_hash, google_id, pending_avatar, ...safe } = user;
  return safe;
}

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = one('SELECT * FROM users WHERE id=?', [payload.id]);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account unavailable' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

export function instructorRequired(req, res, next) {
  if (!['admin', 'instructor'].includes(req.user?.role)) return res.status(403).json({ error: 'Instructor approval required' });
  next();
}

export function notify(io, userId, type, title, body, link = '') {
  const info = run('INSERT INTO notifications (user_id,type,title,body,link) VALUES (?,?,?,?,?)', [userId, type, title, body, link]);
  const n = one('SELECT * FROM notifications WHERE id=?', [info.lastInsertRowid]);
  io?.to(`user:${userId}`).emit('notification:new', n);
  return n;
}

export function admins() {
  return all("SELECT id FROM users WHERE role='admin' AND status='active'");
}

export function censor(text = '') {
  const words = all('SELECT word FROM banned_words').map(w => w.word).filter(Boolean);
  let result = text;
  for (const w of words) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(re, '*'.repeat(Math.max(3, w.length)));
  }
  return result;
}

export function containsBanned(text = '') {
  const lower = text.toLowerCase();
  return all('SELECT word FROM banned_words').some(w => lower.includes(w.word.toLowerCase()));
}
