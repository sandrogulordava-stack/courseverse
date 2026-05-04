import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuid } from 'uuid';
import { db, migrate, readData, saveData, publicUserFromData } from './db.js';
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


function now() { return new Date().toISOString(); }
function isFriend(a, b) {
  const data = readData();
  return data.friends.some(f => (f.user1_id === a && f.user2_id === b) || (f.user1_id === b && f.user2_id === a));
}
function notifyUser(user_id, type, title, body, payload = {}) {
  const data = readData();
  const n = { id: uuid(), user_id, type, title, body, payload, read: false, created_at: now() };
  data.notifications.unshift(n);
  saveData();
  io.to(`user:${user_id}`).emit('notification:new', n);
  return n;
}
function roomWithOwner(room) {
  const data = readData();
  const owner = data.users.find(u => u.id === room.owner_id);
  const members = data.room_members.filter(m => m.room_id === room.id).map(m => publicUserFromData(data.users.find(u => u.id === m.user_id))).filter(Boolean);
  return { ...room, owner_name: owner?.name || 'Unknown', members_count: members.length, members };
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
  const q = String(req.query.q || '').toLowerCase();
  const data = readData();
  const users = data.users
    .filter(u => u.id !== req.user.id)
    .filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .slice(0, 50)
    .map(u => {
      const pendingOut = data.friend_requests.some(r => r.from_user_id === req.user.id && r.to_user_id === u.id && r.status === 'pending');
      const pendingIn = data.friend_requests.some(r => r.from_user_id === u.id && r.to_user_id === req.user.id && r.status === 'pending');
      return { ...publicUserFromData(u), is_friend: isFriend(req.user.id, u.id), pending_out: pendingOut, pending_in: pendingIn };
    });
  res.json(users);
});

app.get('/api/friends', requireAuth, (req,res) => {
  const data = readData();
  const friends = data.friends
    .filter(f => f.user1_id === req.user.id || f.user2_id === req.user.id)
    .map(f => publicUserFromData(data.users.find(u => u.id === (f.user1_id === req.user.id ? f.user2_id : f.user1_id))))
    .filter(Boolean);
  res.json(friends);
});

app.get('/api/friend-requests', requireAuth, (req,res) => {
  const data = readData();
  const incoming = data.friend_requests
    .filter(r => r.to_user_id === req.user.id && r.status === 'pending')
    .map(r => ({ ...r, from_user: publicUserFromData(data.users.find(u => u.id === r.from_user_id)) }));
  const outgoing = data.friend_requests
    .filter(r => r.from_user_id === req.user.id && r.status === 'pending')
    .map(r => ({ ...r, to_user: publicUserFromData(data.users.find(u => u.id === r.to_user_id)) }));
  res.json({ incoming, outgoing });
});

app.post('/api/friend-requests', requireAuth, (req,res) => {
  const { userId } = req.body;
  const data = readData();
  const target = data.users.find(u => u.id === userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
  if (isFriend(req.user.id, target.id)) return res.status(400).json({ error: 'Already friends' });
  const existing = data.friend_requests.find(r => r.status === 'pending' && ((r.from_user_id === req.user.id && r.to_user_id === target.id) || (r.from_user_id === target.id && r.to_user_id === req.user.id)));
  if (existing) return res.json({ ok:true, message:'Request already pending' });
  const request = { id: uuid(), from_user_id: req.user.id, to_user_id: target.id, status: 'pending', created_at: now() };
  data.friend_requests.push(request);
  saveData();
  notifyUser(target.id, 'friend_request', 'New friend request', `${req.user.name} wants to add you as a friend.`, { requestId: request.id, fromUserId: req.user.id });
  res.json({ ok:true, request });
});

app.post('/api/friend-requests/:id/respond', requireAuth, (req,res) => {
  const { accept } = req.body;
  const data = readData();
  const request = data.friend_requests.find(r => r.id === req.params.id && r.to_user_id === req.user.id && r.status === 'pending');
  if (!request) return res.status(404).json({ error: 'Request not found' });
  request.status = accept ? 'accepted' : 'rejected';
  request.responded_at = now();
  if (accept && !isFriend(request.from_user_id, request.to_user_id)) {
    data.friends.push({ id: uuid(), user1_id: request.from_user_id, user2_id: request.to_user_id, created_at: now() });
  }
  saveData();
  notifyUser(request.from_user_id, accept ? 'friend_accept' : 'friend_reject', accept ? 'Friend request accepted' : 'Friend request rejected', `${req.user.name} ${accept ? 'accepted' : 'rejected'} your friend request.`, { userId: req.user.id });
  res.json({ ok:true });
});

app.get('/api/notifications', requireAuth, (req,res) => {
  const data = readData();
  res.json(data.notifications.filter(n => n.user_id === req.user.id).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0,100));
});

app.post('/api/notifications/:id/read', requireAuth, (req,res) => {
  const data = readData();
  const n = data.notifications.find(n => n.id === req.params.id && n.user_id === req.user.id);
  if (!n) return res.status(404).json({ error:'Notification not found' });
  n.read = true;
  saveData();
  res.json({ ok:true });
});



app.get('/api/rooms', requireAuth, (req,res) => {
  const data = readData();
  const mine = data.rooms
    .filter(r => data.room_members.some(m => m.room_id === r.id && m.user_id === req.user.id))
    .map(roomWithOwner)
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json(mine);
});

app.get('/api/rooms/public', requireAuth, (req,res) => {
  const q = String(req.query.q || '').toLowerCase();
  const data = readData();
  const rooms = data.rooms
    .filter(r => r.is_public !== 0)
    .filter(r => !q || r.title.toLowerCase().includes(q) || String(r.description || '').toLowerCase().includes(q))
    .map(r => ({ ...roomWithOwner(r), joined: data.room_members.some(m => m.room_id === r.id && m.user_id === req.user.id) }))
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0,50);
  res.json(rooms);
});

app.post('/api/rooms/join', requireAuth, (req,res) => {
  const { inviteCode } = req.body;
  const data = readData();
  const room = data.rooms.find(r => String(r.invite_code).toLowerCase() === String(inviteCode || '').toLowerCase());
  if (!room) return res.status(404).json({ error:'Room not found' });
  if (!data.room_members.some(m => m.room_id === room.id && m.user_id === req.user.id)) data.room_members.push({ room_id: room.id, user_id: req.user.id });
  saveData();
  notifyUser(room.owner_id, 'room_join', 'New room member', `${req.user.name} joined ${room.title}.`, { roomId: room.id });
  res.json({ ok:true, room: roomWithOwner(room) });
});



app.post('/api/rooms', requireAuth, (req,res) => {
  const {title, description='', memberIds=[], course_id=null, is_public=1} = req.body;
  const id = uuid();
  const data = readData();
  const room = { id, owner_id: req.user.id, title: title || 'New classroom', description, course_id, is_public: is_public ? 1 : 0, invite_code: String(id).slice(0,8).toUpperCase(), created_at: now() };
  data.rooms.push(room);
  data.room_members.push({ room_id: id, user_id: req.user.id });
  for (const mid of memberIds) {
    if (!data.room_members.some(m => m.room_id === id && m.user_id === mid)) data.room_members.push({ room_id: id, user_id: mid });
    notifyUser(mid, 'room_invite', 'Room invitation', `${req.user.name} invited you to ${room.title}.`, { roomId: id, roomTitle: room.title });
  }
  saveData();
  res.json({id, room});
});


app.post('/api/rooms/:id/members', requireAuth, (req,res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!room) return res.status(404).json({error:'Room not found'});
  if (room.owner_id !== req.user.id) return res.status(403).json({error:'Only owner can add members'});
  for (const id of req.body.memberIds || []) db.prepare('INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)').run(room.id, id);
  res.json({ok:true});
});


app.post('/api/rooms/:id/invite', requireAuth, (req,res) => {
  const { userId } = req.body;
  const data = readData();
  const room = data.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error:'Room not found' });
  const inviterIsMember = data.room_members.some(m => m.room_id === room.id && m.user_id === req.user.id);
  if (!inviterIsMember) return res.status(403).json({ error:'You are not a room member' });
  if (!isFriend(req.user.id, userId)) return res.status(403).json({ error:'You can invite only friends' });
  if (data.room_members.some(m => m.room_id === room.id && m.user_id === userId)) return res.status(400).json({ error:'User is already in room' });
  const existing = data.room_invites.find(i => i.room_id === room.id && i.to_user_id === userId && i.status === 'pending');
  if (existing) return res.json({ ok:true, message:'Invite already sent' });
  const invite = { id: uuid(), room_id: room.id, from_user_id: req.user.id, to_user_id: userId, status:'pending', created_at: now() };
  data.room_invites.push(invite);
  saveData();
  notifyUser(userId, 'room_invite', 'Room invitation', `${req.user.name} invited you to ${room.title}.`, { inviteId: invite.id, roomId: room.id, roomTitle: room.title });
  res.json({ ok:true, invite });
});

app.post('/api/room-invites/:id/respond', requireAuth, (req,res) => {
  const { accept } = req.body;
  const data = readData();
  const invite = data.room_invites.find(i => i.id === req.params.id && i.to_user_id === req.user.id && i.status === 'pending');
  if (!invite) return res.status(404).json({ error:'Invite not found' });
  invite.status = accept ? 'accepted' : 'rejected';
  invite.responded_at = now();
  if (accept && !data.room_members.some(m => m.room_id === invite.room_id && m.user_id === req.user.id)) data.room_members.push({ room_id: invite.room_id, user_id: req.user.id });
  saveData();
  const room = data.rooms.find(r => r.id === invite.room_id);
  notifyUser(invite.from_user_id, accept ? 'room_invite_accept' : 'room_invite_reject', accept ? 'Room invite accepted' : 'Room invite rejected', `${req.user.name} ${accept ? 'joined' : 'declined'} ${room?.title || 'your room'}.`, { roomId: invite.room_id });
  res.json({ ok:true });
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
  socket.join(`user:${socket.user.id}`);
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

  socket.on('message:typing', ({roomId}) => {
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(roomId, socket.user.id);
    if (!member) return;
    socket.to(roomId).emit('message:typing', { user: socket.user });
  });

  socket.on('call:join', ({roomId}) => {
    const member = db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?').get(roomId, socket.user.id);
    if (!member) return;
    socket.currentCallRoom = roomId;
    socket.join(`call:${roomId}`);
    socket.to(`call:${roomId}`).emit('call:user-joined', { socketId: socket.id, user: socket.user });
  });
  socket.on('call:signal', ({roomId, to, data}) => io.to(to).emit('call:signal', { from: socket.id, data, user: socket.user }));
  socket.on('call:leave', ({roomId}) => {
    socket.leave(`call:${roomId}`);
    socket.to(`call:${roomId}`).emit('call:user-left', { socketId: socket.id, user: socket.user });
    if (socket.currentCallRoom === roomId) socket.currentCallRoom = null;
  });
  socket.on('disconnect', () => {
    if (socket.currentCallRoom) socket.to(`call:${socket.currentCallRoom}`).emit('call:user-left', { socketId: socket.id, user: socket.user });
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`CourseVerse API running on http://localhost:${PORT}`));
