import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from './db.js';

export function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '7d' });
}

export function isAdminUser(user) {
  if (!user) return false;
  const adminEmails = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return user.role === 'admin' || adminEmails.includes(String(user.email || '').toLowerCase());
}

export function publicUser(user) {
  if (!user) return null;
  return { id:user.id, name:user.name, email:user.email, avatar:user.avatar, role:user.role, headline:user.headline, bio:user.bio, is_admin:isAdminUser(user) };
}

export function requireAuth(req,res,next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
    if (!user) return res.status(401).json({error:'Unauthorized'});
    req.user = user;
    next();
  } catch {
    res.status(401).json({error:'Unauthorized'});
  }
}

export function registerAuthRoutes(app) {
  app.post('/api/auth/register', (req,res) => {
    const {name,email,password,role='student'} = req.body;
    const safeRole = role === 'instructor' ? 'instructor' : 'student';
    if (!name || !email || !password) return res.status(400).json({error:'Name, email and password are required.'});
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
    if (exists) return res.status(409).json({error:'Email already registered.'});
    const user = { id:uuid(), name, email:email.toLowerCase(), password_hash:bcrypt.hashSync(password,10), role:safeRole, avatar:`https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(name)}` };
    db.prepare('INSERT INTO users (id,name,email,password_hash,role,avatar) VALUES (?,?,?,?,?,?)').run(user.id,user.name,user.email,user.password_hash,user.role,user.avatar);
    res.json({token:sign(user), user:publicUser(user)});
  });

  app.post('/api/auth/login', (req,res) => {
    const {email,password} = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
    if (!user || !user.password_hash || !bcrypt.compareSync(password || '', user.password_hash)) return res.status(401).json({error:'Invalid email or password.'});
    res.json({token:sign(user), user:publicUser(user)});
  });

  app.get('/api/me', requireAuth, (req,res) => res.json(publicUser(req.user)));

  app.put('/api/me', requireAuth, (req,res) => {
    const {name,headline,bio,avatar,role} = req.body;
    db.prepare('UPDATE users SET name=?, headline=?, bio=?, avatar=?, role=? WHERE id=?')
      .run(name || req.user.name, headline || '', bio || '', avatar || req.user.avatar, role || req.user.role, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)));
  });
}
