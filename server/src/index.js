import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { db, migrate } from './db.js';
import { registerAuthRoutes, requireAuth, publicUser, sign } from './auth.js';

migrate();
const app = express();
const httpServer = createServer(app);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-session', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, db.prepare('SELECT * FROM users WHERE id=?').get(id)));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/auth/google/callback'
  }, (_, __, profile, done) => {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) return done(new Error('Google account has no email'));
    let user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user) {
      const id = uuid();
      db.prepare('INSERT INTO users (id,name,email,avatar,google_id,role) VALUES (?,?,?,?,?,?)')
        .run(id, profile.displayName, email, profile.photos?.[0]?.value || '', profile.id, 'student');
      user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    }
    done(null, user);
  }));
}

registerAuthRoutes(app);

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: `${CLIENT_URL}/?auth=failed` }), (req,res) => {
  const token = sign(req.user);
  res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`);
});

app.get('/api/courses', (req,res) => {
  const {q='', category='', level=''} = req.query;
  let sql = `SELECT c.*, u.name instructor_name, u.avatar instructor_avatar FROM courses c JOIN users u ON u.id=c.instructor_id WHERE c.published=1`;
  const params = [];
  if (q) { sql += ' AND (c.title LIKE ? OR c.description LIKE ?)'; params.push(`%${q}%`,`%${q}%`); }
  if (category) { sql += ' AND c.category=?'; params.push(category); }
  if (level) { sql += ' AND c.level=?'; params.push(level); }
  sql += ' ORDER BY c.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/courses/:id', (req,res) => {
  const course = db.prepare(`SELECT c.*, u.name instructor_name, u.avatar instructor_avatar FROM courses c JOIN users u ON u.id=c.instructor_id WHERE c.id=?`).get(req.params.id);
  if (!course) return res.status(404).json({error:'Course not found'});
  const lessons = db.prepare('SELECT * FROM lessons WHERE course_id=? ORDER BY position').all(req.params.id);
  res.json({...course, lessons});
});

app.post('/api/courses', requireAuth, (req,res) => {
  const {title,category,level,price,image,description,video_url,lessons=[]} = req.body;
  if (!title || !category || !level || !description) return res.status(400).json({error:'Missing fields'});
  const id = uuid();
  db.prepare('INSERT INTO courses (id,instructor_id,title,category,level,price,image,description,video_url) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, req.user.id, title, category, level, Number(price || 0), image || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?q=80&w=1400&auto=format&fit=crop', description, video_url || '');
  lessons.forEach((l, i) => db.prepare('INSERT INTO lessons (id,course_id,title,video_url,content,position) VALUES (?,?,?,?,?,?)')
    .run(uuid(), id, l.title || `Lesson ${i+1}`, l.video_url || '', l.content || '', i+1));
  res.json({id});
});

app.post('/api/courses/:id/buy', requireAuth, (req,res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({error:'Course not found'});
  db.prepare('INSERT OR IGNORE INTO purchases (id,user_id,course_id,amount) VALUES (?,?,?,?)').run(uuid(), req.user.id, course.id, course.price);
  res.json({ok:true, message:'Demo purchase completed. Replace this with Stripe/PayPal in production.'});
});

app.get('/api/my/courses', requireAuth, (req,res) => {
  const enrolled = db.prepare(`SELECT c.* FROM purchases p JOIN courses c ON c.id=p.course_id WHERE p.user_id=? ORDER BY p.created_at DESC`).all(req.user.id);
  const teaching = db.prepare('SELECT * FROM courses WHERE instructor_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({enrolled, teaching});
});

app.get('/api/users', requireAuth, (req,res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT id,name,email,avatar,role,headline FROM users WHERE name LIKE ? OR email LIKE ? LIMIT 25').all(q,q));
});

app.get('/api/rooms', requireAuth, (req,res) => {
  res.json(db.prepare(`SELECT r.*, u.name owner_name FROM rooms r JOIN room_members m ON m.room_id=r.id JOIN users u ON u.id=r.owner_id WHERE m.user_id=? ORDER BY r.created_at DESC`).all(req.user.id));
});

app.post('/api/rooms', requireAuth, (req,res) => {
  const {title, memberIds=[], course_id=null} = req.body;
  const id = uuid();
  db.prepare('INSERT INTO rooms (id,owner_id,title,course_id) VALUES (?,?,?,?)').run(id, req.user.id, title || 'New classroom', course_id);
  const add = db.prepare('INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)');
  add.run(id, req.user.id);
  memberIds.forEach(mid => add.run(id, mid));
  res.json({id});
});

app.post('/api/rooms/:id/members', requireAuth, (req,res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!room) return res.status(404).json({error:'Room not found'});
  if (room.owner_id !== req.user.id) return res.status(403).json({error:'Only owner can add members'});
  for (const id of req.body.memberIds || []) db.prepare('INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)').run(room.id, id);
  res.json({ok:true});
});

app.get('/api/rooms/:id/messages', requireAuth, (req,res) => {
  const isMember = db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!isMember) return res.status(403).json({error:'Not a member'});
  res.json(db.prepare(`SELECT m.*, u.name, u.avatar FROM messages m JOIN users u ON u.id=m.user_id WHERE room_id=? ORDER BY m.created_at ASC LIMIT 200`).all(req.params.id));
});

const io = new Server(httpServer, { cors: { origin: CLIENT_URL, credentials: true } });
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(payload.id);
    if (!user) throw new Error('bad user');
    socket.user = publicUser(user);
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', socket => {
  socket.on('room:join', ({roomId}) => {
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(roomId, socket.user.id);
    if (!member) return;
    socket.join(roomId);
    socket.to(roomId).emit('presence:join', socket.user);
    socket.emit('presence:self', socket.user);
  });

  socket.on('message:send', ({roomId, body}) => {
    if (!body?.trim()) return;
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(roomId, socket.user.id);
    if (!member) return;
    const message = { id: uuid(), room_id: roomId, user_id: socket.user.id, body: body.trim(), created_at: new Date().toISOString(), name: socket.user.name, avatar: socket.user.avatar };
    db.prepare('INSERT INTO messages (id,room_id,user_id,body,created_at) VALUES (?,?,?,?,?)').run(message.id, roomId, socket.user.id, message.body, message.created_at);
    io.to(roomId).emit('message:new', message);
  });

  socket.on('call:join', ({roomId}) => {
    socket.join(`call:${roomId}`);
    socket.to(`call:${roomId}`).emit('call:user-joined', { socketId: socket.id, user: socket.user });
  });
  socket.on('call:signal', ({roomId, to, data}) => io.to(to).emit('call:signal', { from: socket.id, data, user: socket.user }));
  socket.on('call:leave', ({roomId}) => socket.leave(`call:${roomId}`));
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`CourseVerse API running on http://localhost:${PORT}`));
