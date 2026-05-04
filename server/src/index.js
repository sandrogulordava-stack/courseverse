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
import { registerAuthRoutes, requireAuth, publicUser, sign, isAdminUser } from './auth.js';

migrate();
const app = express();
const httpServer = createServer(app);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '12mb' }));
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

function notifyAdmins(type, title, body, payload = {}) {
  const data = readData();
  const admins = data.users.filter(u => isAdminUser(u));
  for (const admin of admins) {
    notifyUser(admin.id, type, title, body, payload);
  }
  return admins.length;
}
function requestUserName(userId) {
  const data = readData();
  return data.users.find(u => u.id === userId)?.name || 'Unknown user';
}
function approvalRequestView(r) {
  const data = readData();
  const requester = data.users.find(u => u.id === r.requester_id);
  let target = null;
  if (r.target_type === 'course') target = data.courses.find(c => c.id === r.target_id);
  if (r.target_type === 'room') target = data.rooms.find(room => room.id === r.target_id);
  if (r.target_type === 'avatar') {
    const u = data.users.find(user => user.id === r.target_id);
    target = { ...(publicUserFromData(u) || {}), requested_avatar: r.payload?.avatar || '' };
  }
  return { ...r, requester: publicUserFromData(requester), target };
}
function createApprovalRequest({ requester_id, target_type, target_id, title, body, payload = {} }) {
  const data = readData();
  const request = { id: uuid(), requester_id, target_type, target_id, title, body, payload, status: 'pending', created_at: now() };
  data.approval_requests.unshift(request);
  saveData();
  notifyAdmins('admin_approval_request', 'New approval request', `${requestUserName(requester_id)} requested approval: ${title}`, { requestId: request.id, targetType: target_type, targetId: target_id });
  return request;
}
function roomWithOwner(room) {
  const data = readData();
  const owner = data.users.find(u => u.id === room.owner_id);
  const members = data.room_members.filter(m => m.room_id === room.id).map(m => publicUserFromData(data.users.find(u => u.id === m.user_id))).filter(Boolean);
  return { ...room, owner_name: owner?.name || 'Unknown', members_count: members.length, members };
}

function requireAdmin(req,res,next) {
  if (!isAdminUser(req.user)) return res.status(403).json({ error: 'Admin only' });
  next();
}
function moderationSettings() {
  const data = readData();
  if (!Array.isArray(data.moderation_settings) || data.moderation_settings.length === 0) {
    data.moderation_settings = [{ banned_words: ['spam','scam'], auto_unpublish: true }];
    saveData();
  }
  const settings = data.moderation_settings[0];
  settings.banned_words = Array.isArray(settings.banned_words) ? settings.banned_words : [];
  settings.auto_unpublish = settings.auto_unpublish !== false;
  return settings;
}
function normalizeWords(words = []) {
  return Array.from(new Set(String(words).split(',').map(w => w.trim().toLowerCase()).filter(Boolean)));
}
function escapeRegExp(value) {
  return String(value).replace(new RegExp('[.*+?^${}()|\[\]\\]', 'g'), '\$&');
}
function findBannedWords(text = '') {
  const lower = String(text || '').toLowerCase();
  return moderationSettings().banned_words.filter(w => w && lower.includes(w.toLowerCase()));
}
function censorText(text = '') {
  let out = String(text || '');
  for (const word of moderationSettings().banned_words) {
    if (!word) continue;
    const mask = word.length <= 2 ? '*'.repeat(word.length) : word[0] + '*'.repeat(Math.max(2, word.length - 2)) + word[word.length - 1];
    out = out.replace(new RegExp(escapeRegExp(word), 'gi'), mask);
  }
  return out;
}
function adminCourseView(course) {
  const data = readData();
  const instructor = data.users.find(u => u.id === course.instructor_id);
  return { ...course, instructor_name: instructor?.name || 'Unknown', instructor_email: instructor?.email || '' };
}

function saveViolation({ user_id, target_type, target_id, text, hits }) {
  if (!hits?.length) return;
  const data = readData();
  data.moderation_violations.unshift({ id: uuid(), user_id, target_type, target_id, text: String(text || '').slice(0, 500), hits, created_at: now() });
  saveData();
}
function dmThreadView(thread, userId) {
  const data = readData();
  const otherId = thread.user1_id === userId ? thread.user2_id : thread.user1_id;
  const other = publicUserFromData(data.users.find(u => u.id === otherId));
  const last = data.direct_messages.filter(m => m.thread_id === thread.id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  return { ...thread, other_user: other, last_message: last };
}
function getOrCreateDmThread(userA, userB) {
  const data = readData();
  let thread = data.direct_threads.find(t => (t.user1_id === userA && t.user2_id === userB) || (t.user1_id === userB && t.user2_id === userA));
  if (!thread) {
    thread = { id: uuid(), user1_id: userA, user2_id: userB, created_at: now(), updated_at: now() };
    data.direct_threads.push(thread);
    saveData();
  }
  return thread;
}
function userInDmThread(thread, userId) {
  return thread && (thread.user1_id === userId || thread.user2_id === userId);
}

registerAuthRoutes(app);

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: `${CLIENT_URL}/?auth=failed` }), (req,res) => {
  if (req.user?.deleted || req.user?.status === 'blocked') {
    return res.redirect(`${CLIENT_URL}/?auth=blocked`);
  }
  const token = sign(req.user);
  res.redirect(`${CLIENT_URL}/auth/callback?token=${token}`);
});

app.get('/api/courses', (req,res) => {
  const { q='', category='', level='', priceMin='', priceMax='', sort='newest' } = req.query;
  const data = readData();
  const text = String(q || '').trim().toLowerCase();
  const min = priceMin !== '' ? Number(priceMin) : null;
  const max = priceMax !== '' ? Number(priceMax) : null;
  let courses = data.courses
    .filter(c => c.published !== 0 && (c.approval_status || 'approved') === 'approved')
    .filter(c => !text || [c.title, c.description, c.category, c.level].join(' ').toLowerCase().includes(text))
    .filter(c => !category || c.category === category)
    .filter(c => !level || c.level === level)
    .filter(c => min === null || Number(c.price || 0) >= min)
    .filter(c => max === null || Number(c.price || 0) <= max)
    .map(c => {
      const instructor = data.users.find(u => u.id === c.instructor_id) || {};
      const purchases = data.purchases.filter(p => p.course_id === c.id).length;
      return { ...c, instructor_name: instructor.name || 'Unknown', instructor_avatar: instructor.avatar || '', students_count: purchases, rating: c.rating || 4.8 };
    });
  if (sort === 'price_low') courses.sort((a,b)=>Number(a.price||0)-Number(b.price||0));
  else if (sort === 'price_high') courses.sort((a,b)=>Number(b.price||0)-Number(a.price||0));
  else if (sort === 'popular') courses.sort((a,b)=>(b.students_count||0)-(a.students_count||0));
  else courses.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  res.json(courses);
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
  const joinedText = [title, category, level, description, ...(Array.isArray(lessons) ? lessons.flatMap(l => [l.title, l.content]) : [])].join(' ');
  const hits = findBannedWords(joinedText);
  if (hits.length) return res.status(400).json({ error: `Course blocked by moderation: ${hits.join(', ')}` });

  const data = readData();
  const id = uuid();
  const approved = isAdminUser(req.user);
  const course = {
    id,
    instructor_id: req.user.id,
    title: censorText(title),
    category,
    level,
    price: Number(price || 0),
    image: image || 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?q=80&w=1400&auto=format&fit=crop',
    description: censorText(description),
    video_url: video_url || '',
    published: approved ? 1 : 0,
    approval_status: approved ? 'approved' : 'pending',
    created_at: now()
  };
  data.courses.push(course);
  (Array.isArray(lessons) ? lessons : []).forEach((l, i) => data.lessons.push({ id: uuid(), course_id: id, title: censorText(l.title || `Lesson ${i+1}`), video_url: l.video_url || '', content: censorText(l.content || ''), position: i+1, created_at: now() }));
  saveData();

  if (!approved) {
    createApprovalRequest({ requester_id: req.user.id, target_type: 'course', target_id: id, title: course.title, body: `Course publish request: ${course.title}`, payload: { category, level, price: course.price } });
    return res.json({ id, pending_approval: true, message: 'Course sent to admin for approval. It will appear on the site after admin approves it.' });
  }

  res.json({id, pending_approval: false});
});

app.post('/api/courses/:id/buy', requireAuth, (req,res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!course) return res.status(404).json({error:'Course not found'});
  db.prepare('INSERT OR IGNORE INTO purchases (id,user_id,course_id,amount) VALUES (?,?,?,?)').run(uuid(), req.user.id, course.id, course.price);
  res.json({ok:true, message:'Enrollment complete. Demo checkout succeeded.', receipt:{ courseId: course.id, amount: course.price, currency:'USD', paid_at: now() }});
});

app.get('/api/my/courses', requireAuth, (req,res) => {
  const enrolled = db.prepare(`SELECT c.* FROM purchases p JOIN courses c ON c.id=p.course_id WHERE p.user_id=? ORDER BY p.created_at DESC`).all(req.user.id);
  const teaching = db.prepare('SELECT * FROM courses WHERE instructor_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({enrolled, teaching});
});



app.get('/api/users/:id/public', requireAuth, (req,res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id && !u.deleted && u.status !== 'blocked');
  if (!user) return res.status(404).json({ error:'Profile not found' });
  const pendingOut = data.friend_requests.find(r => r.from_user_id === req.user.id && r.to_user_id === user.id && r.status === 'pending');
  const pendingIn = data.friend_requests.find(r => r.from_user_id === user.id && r.to_user_id === req.user.id && r.status === 'pending');
  const courses = data.courses
    .filter(c => c.instructor_id === user.id && c.published !== 0 && c.approval_status !== 'pending')
    .map(adminCourseView)
    .map(c => ({...c, lessons: undefined}))
    .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  res.json({
    user: publicUserFromData(user),
    is_self: user.id === req.user.id,
    is_friend: isFriend(req.user.id, user.id),
    pending_out: Boolean(pendingOut),
    pending_in: Boolean(pendingIn),
    friend_request_id: pendingIn?.id || null,
    can_message: isFriend(req.user.id, user.id),
    courses
  });
});

app.delete('/api/friends/:id', requireAuth, (req,res) => {
  const data = readData();
  const before = data.friends.length;
  data.friends = data.friends.filter(f => !((f.user1_id === req.user.id && f.user2_id === req.params.id) || (f.user1_id === req.params.id && f.user2_id === req.user.id)));
  saveData();
  res.json({ ok:true, removed: before - data.friends.length });
});

app.get('/api/users', requireAuth, (req,res) => {
  const q = String(req.query.q || '').toLowerCase();
  const data = readData();
  const users = data.users
    .filter(u => u.id !== req.user.id && !u.deleted && u.status !== 'blocked')
    .filter(u => !q || String(u.name).toLowerCase().includes(q) || String(u.email).toLowerCase().includes(q))
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



app.get('/api/dm/threads', requireAuth, (req,res) => {
  const data = readData();
  const threads = data.direct_threads
    .filter(t => userInDmThread(t, req.user.id))
    .map(t => dmThreadView(t, req.user.id))
    .sort((a,b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
  const friends = data.friends
    .filter(f => f.user1_id === req.user.id || f.user2_id === req.user.id)
    .map(f => publicUserFromData(data.users.find(u => u.id === (f.user1_id === req.user.id ? f.user2_id : f.user1_id))))
    .filter(Boolean);
  res.json({ threads, friends });
});

app.post('/api/dm/threads', requireAuth, (req,res) => {
  const { userId } = req.body;
  const data = readData();
  const target = data.users.find(u => u.id === userId);
  if (!target) return res.status(404).json({ error:'User not found' });
  if (!isFriend(req.user.id, target.id)) return res.status(403).json({ error:'You can message only accepted friends' });
  const thread = getOrCreateDmThread(req.user.id, target.id);
  res.json(dmThreadView(thread, req.user.id));
});

app.get('/api/dm/threads/:id/messages', requireAuth, (req,res) => {
  const data = readData();
  const thread = data.direct_threads.find(t => t.id === req.params.id);
  if (!userInDmThread(thread, req.user.id)) return res.status(403).json({ error:'Not your chat' });
  const messages = data.direct_messages
    .filter(m => m.thread_id === thread.id)
    .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-200)
    .map(m => ({ ...m, user: publicUserFromData(data.users.find(u => u.id === m.user_id)) }));
  res.json(messages);
});

app.post('/api/dm/threads/:id/messages', requireAuth, (req,res) => {
  const data = readData();
  const thread = data.direct_threads.find(t => t.id === req.params.id);
  if (!userInDmThread(thread, req.user.id)) return res.status(403).json({ error:'Not your chat' });
  const body = String(req.body.body || '').trim();
  const type = ['text','image','sticker'].includes(req.body.type) ? req.body.type : 'text';
  const image = String(req.body.image || '');
  const sticker = String(req.body.sticker || '');
  if (type === 'text' && !body) return res.status(400).json({ error:'Message is empty' });
  if (type === 'image' && !image.startsWith('data:image/')) return res.status(400).json({ error:'Upload a valid image' });
  if (type === 'image' && image.length > 7_000_000) return res.status(400).json({ error:'Image is too large' });
  const hits = findBannedWords(body);
  const message = { id: uuid(), thread_id: thread.id, user_id: req.user.id, type, body: censorText(body), image, sticker, created_at: now() };
  data.direct_messages.push(message);
  thread.updated_at = message.created_at;
  saveData();
  saveViolation({ user_id:req.user.id, target_type:'direct_message', target_id:message.id, text:body, hits });
  const otherId = thread.user1_id === req.user.id ? thread.user2_id : thread.user1_id;
  notifyUser(otherId, 'direct_message', 'New message', `${req.user.name}: ${type === 'text' ? message.body.slice(0, 80) : type}`, { threadId: thread.id });
  const full = { ...message, user: publicUser(req.user) };
  io.to(`dm:${thread.id}`).emit('dm:message', full);
  res.json(full);
});

app.post('/api/reports', requireAuth, (req,res) => {
  const { targetType='user', targetId='', reason='bad_content', details='' } = req.body;
  const data = readData();
  const report = { id: uuid(), reporter_id: req.user.id, target_type: targetType, target_id: targetId, reason, details: String(details || '').slice(0, 1000), status:'open', created_at: now() };
  data.reports.unshift(report);
  saveData();
  res.json({ ok:true, report });
});

app.get('/api/admin/stats', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  res.json({
    users: data.users.length,
    courses: data.courses.length,
    published_courses: data.courses.filter(c => c.published !== 0).length,
    rooms: data.rooms.length,
    messages: data.messages.length,
    pending_friend_requests: data.friend_requests.filter(r => r.status === 'pending').length,
    pending_approvals: data.approval_requests.filter(r => r.status === 'pending').length,
    moderation: moderationSettings()
  });
});

app.get('/api/admin/courses', requireAuth, requireAdmin, (req,res) => {
  const q = String(req.query.q || '').toLowerCase();
  const data = readData();
  const courses = data.courses
    .filter(c => !q || String(c.title).toLowerCase().includes(q) || String(c.description).toLowerCase().includes(q))
    .map(adminCourseView)
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json(courses);
});

app.delete('/api/admin/courses/:id', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const before = data.courses.length;
  data.courses = data.courses.filter(c => c.id !== req.params.id);
  data.lessons = data.lessons.filter(l => l.course_id !== req.params.id);
  data.purchases = data.purchases.filter(p => p.course_id !== req.params.id);
  saveData();
  res.json({ ok:true, deleted: before - data.courses.length });
});

app.patch('/api/admin/courses/:id', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const course = data.courses.find(c => c.id === req.params.id);
  if (!course) return res.status(404).json({ error:'Course not found' });
  if (typeof req.body.published !== 'undefined') course.published = req.body.published ? 1 : 0;
  if (typeof req.body.title === 'string') course.title = censorText(req.body.title);
  if (typeof req.body.description === 'string') course.description = censorText(req.body.description);
  saveData();
  res.json(adminCourseView(course));
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req,res) => {
  const q = String(req.query.q || '').toLowerCase();
  const data = readData();
  res.json(data.users
    .filter(u => !q || String(u.name).toLowerCase().includes(q) || String(u.email).toLowerCase().includes(q))
    .map(u => ({
      ...publicUserFromData(u),
      raw_email: u.email,
      is_admin:isAdminUser(u),
      created_at:u.created_at,
      status:u.status || 'active',
      blocked_reason:u.blocked_reason || '',
      deleted: Number(u.deleted || 0)
    }))
    .sort((a,b) => String(a.name).localeCompare(String(b.name))));
});

app.patch('/api/admin/users/:id/remove-avatar', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.avatar = `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user.name || 'User')}`;
  user.avatar_approval_status = 'removed_by_admin';
  saveData();
  notifyUser(user.id, 'admin_action', 'Profile photo removed', 'Your profile photo was removed by admin.', {});
  res.json({ ok:true, user: publicUserFromData(user) });
});

app.patch('/api/admin/users/:id/block', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  if (isAdminUser(user) && user.id !== req.user.id) return res.status(403).json({ error:'You cannot block another admin' });
  user.status = 'blocked';
  user.blocked_reason = String(req.body.reason || 'Blocked by admin').slice(0, 300);
  saveData();
  notifyUser(user.id, 'admin_action', 'Account blocked', user.blocked_reason, {});
  res.json({ ok:true, user: publicUserFromData(user) });
});

app.patch('/api/admin/users/:id/unblock', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.status = 'active';
  user.blocked_reason = '';
  saveData();
  notifyUser(user.id, 'admin_action', 'Account unblocked', 'Your account was unblocked by admin.', {});
  res.json({ ok:true, user: publicUserFromData(user) });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error:'You cannot delete your own admin account' });
  if (isAdminUser(user)) return res.status(403).json({ error:'You cannot delete an admin account' });
  user.deleted = 1;
  user.status = 'deleted';
  user.deleted_at = now();
  user.email = `${user.email}_deleted_${user.id}`;
  for (const c of data.courses.filter(c => c.instructor_id === user.id)) {
    c.published = 0;
    c.approval_status = 'hidden';
    c.hidden = 1;
  }
  saveData();
  res.json({ ok:true, message:'User soft-deleted and their courses hidden' });
});

app.patch('/api/admin/users/:id/role', requireAuth, requireAdmin, (req,res) => {
  const role = ['student','instructor','admin'].includes(req.body.role) ? req.body.role : 'student';
  const data = readData();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error:'User not found' });
  user.role = role;
  saveData();
  res.json(publicUser(user));
});

app.get('/api/admin/moderation', requireAuth, requireAdmin, (req,res) => {
  res.json(moderationSettings());
});

app.put('/api/admin/moderation', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  if (!Array.isArray(data.moderation_settings) || data.moderation_settings.length === 0) data.moderation_settings = [{}];
  data.moderation_settings[0] = {
    banned_words: Array.isArray(req.body.banned_words) ? normalizeWords(req.body.banned_words.join(',')) : normalizeWords(req.body.banned_words || ''),
    auto_unpublish: req.body.auto_unpublish !== false
  };
  saveData();
  res.json(data.moderation_settings[0]);
});

app.post('/api/admin/moderation/test', requireAuth, requireAdmin, (req,res) => {
  const text = String(req.body.text || '');
  res.json({ original:text, censored:censorText(text), hits:findBannedWords(text) });
});





app.get('/api/admin/approval-requests', requireAuth, requireAdmin, (req,res) => {
  const status = String(req.query.status || 'pending');
  const data = readData();
  const list = data.approval_requests
    .filter(r => status === 'all' || r.status === status)
    .map(approvalRequestView)
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json(list);
});

app.post('/api/admin/approval-requests/:id/respond', requireAuth, requireAdmin, (req,res) => {
  const approve = req.body.approve === true;
  const note = String(req.body.note || '').slice(0, 500);
  const data = readData();
  const request = data.approval_requests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error:'Approval request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error:'Request already handled' });

  request.status = approve ? 'approved' : 'rejected';
  request.reviewed_by = req.user.id;
  request.reviewed_at = now();
  request.note = note;

  if (request.target_type === 'course') {
    const course = data.courses.find(c => c.id === request.target_id);
    if (course) {
      course.approval_status = approve ? 'approved' : 'rejected';
      course.published = approve ? 1 : 0;
      course.hidden = approve ? 0 : 1;
      course.review_note = note;
      course.approved_at = approve ? now() : course.approved_at;
      course.approved_by = approve ? req.user.id : course.approved_by;
    }
  }

  if (request.target_type === 'room') {
    const room = data.rooms.find(r => r.id === request.target_id);
    if (room) {
      room.approval_status = request.status;
      room.is_public = approve && room.requested_public ? 1 : 0;
      room.review_note = note;
    }
  }

  if (request.target_type === 'avatar') {
    const targetUser = data.users.find(u => u.id === request.target_id);
    if (targetUser && approve && request.payload?.avatar) targetUser.avatar = request.payload.avatar;
    if (targetUser) targetUser.avatar_approval_status = request.status;
  }

  saveData();
  notifyUser(request.requester_id, approve ? 'approval_approved' : 'approval_rejected', approve ? 'Your request was approved' : 'Your request was rejected', `${request.title} was ${approve ? 'approved and published' : 'rejected'} by admin.${note ? ' Note: ' + note : ''}`, { requestId: request.id, targetType: request.target_type, targetId: request.target_id });
  res.json({ ok:true, request: approvalRequestView(request) });
});

app.get('/api/admin/reports', requireAuth, requireAdmin, (req,res) => {
  const data = readData();
  const reports = [...data.reports].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,100);
  const violations = [...data.moderation_violations].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,100);
  res.json({ reports, violations });
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
    .filter(r => r.is_public !== 0 && (r.approval_status || 'approved') === 'approved')
    .filter(r => !q || r.title.toLowerCase().includes(q) || String(r.description || '').toLowerCase().includes(q))
    .map(r => ({ ...roomWithOwner(r), joined: data.room_members.some(m => m.room_id === r.id && m.user_id === req.user.id) }))
    .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0,50);
  res.json(rooms);
});

app.get('/api/rooms/invite/:code', requireAuth, (req,res) => {
  const code = String(req.params.code || '').toLowerCase();
  const data = readData();
  const room = data.rooms.find(r => String(r.invite_code || '').toLowerCase() === code || String(r.id).toLowerCase() === code);
  if (!room) return res.status(404).json({ error:'Room not found' });
  const isMember = data.room_members.some(m => m.room_id === room.id && m.user_id === req.user.id);
  res.json({ room: roomWithOwner(room), isMember, canJoin: true });
});

app.post('/api/rooms/join', requireAuth, (req,res) => {
  const { inviteCode, code, roomId } = req.body;
  const lookup = String(inviteCode || code || roomId || '').toLowerCase();
  const data = readData();
  const room = data.rooms.find(r => String(r.invite_code || '').toLowerCase() === lookup || String(r.id).toLowerCase() === lookup);
  if (!room) return res.status(404).json({ error:'Room not found' });
  if ((room.approval_status || 'approved') === 'rejected') return res.status(403).json({ error:'This room was rejected by moderation' });
  if (room.allow_link_join === 0 && !data.room_members.some(m => m.room_id === room.id && m.user_id === req.user.id)) return res.status(403).json({ error:'This room does not allow link joining' });
  if (!data.room_members.some(m => m.room_id === room.id && m.user_id === req.user.id)) data.room_members.push({ room_id: room.id, user_id: req.user.id });
  saveData();
  notifyUser(room.owner_id, 'room_join', 'New room member', `${req.user.name} joined ${room.title}.`, { roomId: room.id });
  res.json({ ok:true, room: roomWithOwner(room) });
});



app.post('/api/rooms', requireAuth, (req,res) => {
  const {title, description='', memberIds=[], course_id=null, is_public=1, privacy='public', allow_link_join=true, waiting_room=false, max_members=40} = req.body;
  const id = uuid();
  const data = readData();
  const wantsPublic = privacy === 'public' || is_public === 1 || is_public === true;
  const approved = isAdminUser(req.user) || !wantsPublic;
  const room = {
    id,
    owner_id: req.user.id,
    title: title || 'New classroom',
    description,
    course_id,
    privacy,
    allow_link_join: allow_link_join ? 1 : 0,
    waiting_room: waiting_room ? 1 : 0,
    max_members: Number(max_members || 40),
    requested_public: wantsPublic ? 1 : 0,
    is_public: approved && wantsPublic ? 1 : 0,
    approval_status: approved ? 'approved' : 'pending',
    invite_code: String(id).slice(0,8).toUpperCase(),
    created_at: now()
  };
  data.rooms.push(room);
  data.room_members.push({ room_id: id, user_id: req.user.id });
  for (const mid of memberIds) {
    if (!data.room_members.some(m => m.room_id === id && m.user_id === mid)) data.room_members.push({ room_id: id, user_id: mid });
    notifyUser(mid, 'room_invite', 'Room invitation', `${req.user.name} invited you to ${room.title}.`, { roomId: id, roomTitle: room.title });
  }
  saveData();

  if (!approved) {
    createApprovalRequest({ requester_id: req.user.id, target_type: 'room', target_id: id, title: room.title, body: `Public classroom request: ${room.title}`, payload: { description, requested_public: wantsPublic ? 1 : 0, privacy, allow_link_join, waiting_room, max_members } });
    return res.json({ id, room, pending_approval: true, message: 'Room created privately and sent to admin for public approval.' });
  }

  res.json({id, room, pending_approval: false});
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

  socket.on('dm:join', ({threadId}) => {
    const data = readData();
    const thread = data.direct_threads.find(t => t.id === threadId);
    if (!userInDmThread(thread, socket.user.id)) return;
    socket.join(`dm:${thread.id}`);
  });
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
    const rawBody = body.trim();
    const hits = findBannedWords(rawBody);
    const message = { id: uuid(), room_id: roomId, user_id: socket.user.id, body: censorText(rawBody), created_at: new Date().toISOString(), name: socket.user.name, avatar: socket.user.avatar };
    db.prepare('INSERT INTO messages (id,room_id,user_id,body,created_at) VALUES (?,?,?,?,?)').run(message.id, roomId, socket.user.id, message.body, message.created_at);
    saveViolation({ user_id:socket.user.id, target_type:'room_message', target_id:message.id, text:rawBody, hits });
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
