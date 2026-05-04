import express from 'express';
import bcrypt from 'bcryptjs';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { v4 as uuid } from 'uuid';
import { all, one, run } from './db.js';
import { authRequired, adminRequired, instructorRequired, publicUser, signToken, notify, admins, censor, containsBanned, CLIENT_URL } from './utils.js';

export function buildRoutes(io) {
  const router = express.Router();
  const adminEmails = (process.env.ADMIN_EMAILS || 'admin@courseverse.dev').split(',').map(e => e.trim().toLowerCase());

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback'
    }, (_, __, profile, done) => {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(null, false);
      let user = one('SELECT * FROM users WHERE email=?', [email]);
      if (!user) {
        const role = adminEmails.includes(email) ? 'admin' : 'student';
        const info = run('INSERT INTO users (name,email,google_id,role,avatar) VALUES (?,?,?,?,?)', [profile.displayName || email, email, profile.id, role, profile.photos?.[0]?.value || '']);
        user = one('SELECT * FROM users WHERE id=?', [info.lastInsertRowid]);
      } else if (!user.google_id) run('UPDATE users SET google_id=? WHERE id=?', [profile.id, user.id]);
      done(null, user);
    }));
  }

  router.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and 8+ char password required' });
    if (one('SELECT id FROM users WHERE email=?', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already registered' });
    const role = adminEmails.includes(email.toLowerCase()) ? 'admin' : 'student';
    const hash = await bcrypt.hash(password, 10);
    const info = run('INSERT INTO users (name,email,password_hash,role,avatar) VALUES (?,?,?,?,?)', [name, email.toLowerCase(), hash, role, `https://api.dicebear.com/8.x/avataaars/svg?seed=${encodeURIComponent(email)}`]);
    const user = one('SELECT * FROM users WHERE id=?', [info.lastInsertRowid]);
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const user = one('SELECT * FROM users WHERE email=?', [(email || '').toLowerCase()]);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Invalid login or account blocked/deleted' });
    if (!user.password_hash || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: 'Invalid login' });
    res.json({ token: signToken(user), user: publicUser(user) });
  });

  router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
  router.get('/auth/google/callback', passport.authenticate('google', { session: false, failureRedirect: `${CLIENT_URL}/login?error=google` }), (req, res) => {
    if (req.user.status !== 'active') return res.redirect(`${CLIENT_URL}/login?error=blocked`);
    res.redirect(`${CLIENT_URL}/oauth?token=${signToken(req.user)}`);
  });

  router.get('/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

  router.get('/users', authRequired, (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const users = all("SELECT id,name,email,role,avatar,bio,headline FROM users WHERE status='active' AND (name LIKE ? OR email LIKE ?) ORDER BY name LIMIT 40", [q, q]).map(publicUser);
    res.json(users);
  });
  router.get('/users/:id', authRequired, (req, res) => {
    const user = one("SELECT id,name,email,role,avatar,bio,headline,created_at FROM users WHERE id=? AND status='active'", [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const courses = all("SELECT * FROM courses WHERE instructor_id=? AND status='approved'", [req.params.id]);
    res.json({ user, courses });
  });
  router.patch('/profile', authRequired, (req, res) => {
    const { name, bio, headline, avatar } = req.body;
    run('UPDATE users SET name=COALESCE(?,name), bio=COALESCE(?,bio), headline=COALESCE(?,headline), pending_avatar=COALESCE(?,pending_avatar) WHERE id=?', [name, bio, headline, avatar, req.user.id]);
    if (avatar) admins().forEach(a => notify(io, a.id, 'profile_photo', 'Profile photo approval', `${req.user.name} requested a new avatar`, '/admin'));
    res.json({ user: publicUser(one('SELECT * FROM users WHERE id=?', [req.user.id])) });
  });

  router.get('/courses', (req, res) => {
    const { category, level, freePaid, sort = 'newest', q = '' } = req.query;
    const where = ["c.status='approved'"]; const params = [];
    if (category) { where.push('c.category=?'); params.push(category); }
    if (level) { where.push('c.level=?'); params.push(level); }
    if (freePaid === 'free') where.push('c.price=0');
    if (freePaid === 'paid') where.push('c.price>0');
    if (q) { where.push('(c.title LIKE ? OR c.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const order = { popular:'c.students_count DESC', rating:'c.rating DESC', priceLow:'c.price ASC', priceHigh:'c.price DESC', newest:'c.created_at DESC' }[sort] || 'c.created_at DESC';
    const courses = all(`SELECT c.*, u.name instructor, u.avatar instructor_avatar FROM courses c JOIN users u ON u.id=c.instructor_id WHERE ${where.join(' AND ')} ORDER BY ${order}`, params);
    res.json(courses);
  });
  router.get('/courses/:id', authRequired, (req, res) => {
    const course = one('SELECT c.*, u.name instructor, u.avatar instructor_avatar, u.bio instructor_bio FROM courses c JOIN users u ON u.id=c.instructor_id WHERE c.id=?', [req.params.id]);
    if (!course || (!['approved','pending'].includes(course.status) && course.instructor_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Course not found' });
    const enrolled = !!one('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?', [req.user.id, req.params.id]);
    const reviews = all('SELECT r.*, u.name, u.avatar FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.course_id=? ORDER BY r.created_at DESC', [req.params.id]);
    res.json({ course, enrolled, reviews });
  });
  router.post('/courses', authRequired, instructorRequired, (req, res) => {
    const { title, description, category, level, price = 0, thumbnail, preview_video, lessons = [] } = req.body;
    if (!title || !description || !category) return res.status(400).json({ error: 'Title, description and category required' });
    const status = containsBanned(`${title} ${description}`) ? 'pending' : 'pending';
    const info = run('INSERT INTO courses (title,description,category,level,price,thumbnail,preview_video,lessons,instructor_id,status) VALUES (?,?,?,?,?,?,?,?,?,?)', [title, description, category, level || 'Beginner', Number(price), thumbnail || '', preview_video || '', JSON.stringify(lessons), req.user.id, status]);
    admins().forEach(a => notify(io, a.id, 'course_approval', 'Course approval request', `${req.user.name} submitted ${title}`, '/admin'));
    res.json({ course: one('SELECT * FROM courses WHERE id=?', [info.lastInsertRowid]) });
  });
  router.post('/courses/:id/enroll', authRequired, (req, res) => {
    const course = one("SELECT * FROM courses WHERE id=? AND status='approved'", [req.params.id]);
    if (!course) return res.status(404).json({ error: 'Course unavailable' });
    run('INSERT OR IGNORE INTO enrollments (user_id,course_id) VALUES (?,?)', [req.user.id, req.params.id]);
    run('UPDATE courses SET students_count=students_count+1 WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  });
  router.get('/dashboard', authRequired, (req, res) => {
    const purchased = all('SELECT c.* FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=?', [req.user.id]);
    const published = all('SELECT * FROM courses WHERE instructor_id=? ORDER BY created_at DESC', [req.user.id]);
    res.json({ purchased, published });
  });

  router.post('/instructor/apply', authRequired, (req, res) => {
    const existing = one("SELECT * FROM instructor_applications WHERE user_id=? AND status='pending'", [req.user.id]);
    if (existing) return res.json(existing);
    const info = run('INSERT INTO instructor_applications (user_id,note) VALUES (?,?)', [req.user.id, req.body.note || '']);
    admins().forEach(a => notify(io, a.id, 'instructor_application', 'Instructor application', `${req.user.name} applied to teach`, '/admin'));
    res.json(one('SELECT * FROM instructor_applications WHERE id=?', [info.lastInsertRowid]));
  });

  router.post('/friends/:id/request', authRequired, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself' });
    const reverse = one('SELECT * FROM friends WHERE requester_id=? AND receiver_id=? AND status="pending"', [id, req.user.id]);
    if (reverse) { run('UPDATE friends SET status="accepted" WHERE id=?', [reverse.id]); notify(io, id, 'friend_accept', 'Friend request accepted', `${req.user.name} accepted your request`, '/messenger'); return res.json({ status:'Friends' }); }
    run('INSERT OR IGNORE INTO friends (requester_id,receiver_id,status) VALUES (?,?,"pending")', [req.user.id, id]);
    notify(io, id, 'friend_request', 'New friend request', `${req.user.name} sent you a friend request`, '/people');
    res.json({ status:'Pending' });
  });
  router.post('/friends/:id/respond', authRequired, (req, res) => {
    const status = req.body.accept ? 'accepted' : 'rejected';
    const fr = one('SELECT * FROM friends WHERE requester_id=? AND receiver_id=? AND status="pending"', [req.params.id, req.user.id]);
    if (!fr) return res.status(404).json({ error: 'Request not found' });
    run('UPDATE friends SET status=? WHERE id=?', [status, fr.id]);
    if (status === 'accepted') notify(io, fr.requester_id, 'friend_accept', 'Friend request accepted', `${req.user.name} accepted your request`, '/messenger');
    res.json({ ok:true });
  });
  router.delete('/friends/:id', authRequired, (req, res) => { run('DELETE FROM friends WHERE (requester_id=? AND receiver_id=?) OR (requester_id=? AND receiver_id=?)', [req.user.id, req.params.id, req.params.id, req.user.id]); res.json({ ok:true }); });
  router.get('/friends', authRequired, (req, res) => {
    const rows = all(`SELECT u.id,u.name,u.email,u.avatar,u.headline FROM friends f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.receiver_id ELSE f.requester_id END WHERE (f.requester_id=? OR f.receiver_id=?) AND f.status='accepted' AND u.status='active'`, [req.user.id, req.user.id, req.user.id]);
    res.json(rows);
  });

  router.get('/messages/:friendId', authRequired, (req, res) => {
    const rows = all('SELECT * FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY created_at ASC LIMIT 200', [req.user.id, req.params.friendId, req.params.friendId, req.user.id]);
    run('UPDATE messages SET seen_at=CURRENT_TIMESTAMP WHERE receiver_id=? AND sender_id=? AND seen_at IS NULL', [req.user.id, req.params.friendId]);
    res.json(rows);
  });
  router.post('/messages/:friendId', authRequired, (req, res) => {
    const body = censor(req.body.body || '');
    const info = run('INSERT INTO messages (sender_id,receiver_id,body,image_url,sticker) VALUES (?,?,?,?,?)', [req.user.id, req.params.friendId, body, req.body.image_url || '', req.body.sticker || '']);
    const msg = one('SELECT * FROM messages WHERE id=?', [info.lastInsertRowid]);
    io.to(`user:${req.params.friendId}`).emit('message:new', msg);
    notify(io, req.params.friendId, 'message', 'New message', `${req.user.name}: ${body.slice(0,50)}`, '/messenger');
    res.json(msg);
  });

  router.get('/rooms', authRequired, (req, res) => res.json(all("SELECT r.*, u.name host FROM rooms r JOIN users u ON u.id=r.host_id WHERE r.visibility='public' ORDER BY r.created_at DESC")));
  router.post('/rooms', authRequired, (req, res) => {
    const code = uuid().slice(0, 8).toUpperCase();
    const { title, description='', visibility='public', max_participants=20, allow_invite_link=true, waiting_room=false, friends_only=false, host_controls=true } = req.body;
    const info = run('INSERT INTO rooms (code,title,description,visibility,max_participants,allow_invite_link,waiting_room,friends_only,host_controls,host_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [code,title,description,visibility,max_participants,allow_invite_link?1:0,waiting_room?1:0,friends_only?1:0,host_controls?1:0,req.user.id]);
    run('INSERT INTO room_members (room_id,user_id,role,status) VALUES (?,?,"host","joined")', [info.lastInsertRowid, req.user.id]);
    res.json({ room: one('SELECT * FROM rooms WHERE id=?', [info.lastInsertRowid]), inviteLink: `${CLIENT_URL}/?join=${code}` });
  });
  router.get('/rooms/:code', authRequired, (req, res) => {
    const room = one('SELECT r.*, u.name host FROM rooms r JOIN users u ON u.id=r.host_id WHERE r.code=?', [req.params.code]);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.locked && room.host_id !== req.user.id) return res.status(403).json({ error: 'Room is locked' });
    res.json({ room, messages: all('SELECT rm.*, u.name, u.avatar FROM room_messages rm JOIN users u ON u.id=rm.user_id WHERE room_id=? ORDER BY rm.created_at', [room.id]) });
  });
  router.delete('/rooms/:id', authRequired, (req, res) => {
    const room = one('SELECT * FROM rooms WHERE id=?', [req.params.id]);
    if (!room || (room.host_id !== req.user.id && req.user.role !== 'admin')) return res.status(403).json({ error: 'Not allowed' });
    run('DELETE FROM room_messages WHERE room_id=?', [room.id]); run('DELETE FROM room_invites WHERE room_id=?', [room.id]); run('DELETE FROM room_members WHERE room_id=?', [room.id]); run('DELETE FROM rooms WHERE id=?', [room.id]);
    io.to(`room:${room.code}`).emit('room:deleted'); res.json({ ok:true });
  });

  router.get('/notifications', authRequired, (req, res) => res.json(all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.user.id])));
  router.patch('/notifications/read', authRequired, (req, res) => { run('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]); res.json({ ok:true }); });
  router.post('/reports', authRequired, (req, res) => { const info = run('INSERT INTO reports (reporter_id,target_type,target_id,reason) VALUES (?,?,?,?)', [req.user.id, req.body.target_type, req.body.target_id, req.body.reason]); admins().forEach(a => notify(io, a.id, 'report', 'New report', `${req.user.name} submitted a report`, '/admin')); res.json(one('SELECT * FROM reports WHERE id=?', [info.lastInsertRowid])); });

  router.get('/admin/overview', authRequired, adminRequired, (req, res) => res.json({ users: one('SELECT COUNT(*) count FROM users'), courses: one('SELECT COUNT(*) count FROM courses'), rooms: one('SELECT COUNT(*) count FROM rooms'), reports: one("SELECT COUNT(*) count FROM reports WHERE status='open'") }));
  router.get('/admin/users', authRequired, adminRequired, (_, res) => res.json(all('SELECT id,name,email,role,status,avatar,pending_avatar,bio,headline,created_at FROM users ORDER BY created_at DESC')));
  router.patch('/admin/users/:id', authRequired, adminRequired, (req, res) => {
    const { role, status, removePhoto } = req.body;
    if (role) run('UPDATE users SET role=? WHERE id=?', [role, req.params.id]);
    if (status) run('UPDATE users SET status=? WHERE id=?', [status, req.params.id]);
    if (removePhoto) run('UPDATE users SET avatar=NULL,pending_avatar=NULL WHERE id=?', [req.params.id]);
    if (status === 'deleted') run("UPDATE courses SET status='hidden' WHERE instructor_id=?", [req.params.id]);
    res.json(one('SELECT id,name,email,role,status,avatar,pending_avatar FROM users WHERE id=?', [req.params.id]));
  });
  router.get('/admin/approvals', authRequired, adminRequired, (_, res) => res.json({
    courses: all("SELECT c.*, u.name instructor FROM courses c JOIN users u ON u.id=c.instructor_id WHERE c.status='pending'"),
    avatars: all('SELECT id,name,email,avatar,pending_avatar FROM users WHERE pending_avatar IS NOT NULL AND pending_avatar != ""'),
    instructors: all("SELECT ia.*, u.name, u.email FROM instructor_applications ia JOIN users u ON u.id=ia.user_id WHERE ia.status='pending'")
  }));
  router.post('/admin/courses/:id/decision', authRequired, adminRequired, (req, res) => {
    const course = one('SELECT * FROM courses WHERE id=?', [req.params.id]);
    if (!course) return res.status(404).json({ error:'Missing course' });
    const status = req.body.approve ? 'approved' : 'rejected';
    run('UPDATE courses SET status=?, rejection_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', [status, req.body.reason || '', course.id]);
    notify(io, course.instructor_id, `course_${status}`, `Course ${status}`, req.body.approve ? `${course.title} is now public` : `${course.title} rejected: ${req.body.reason || 'No reason'}`, '/dashboard');
    res.json(one('SELECT * FROM courses WHERE id=?', [course.id]));
  });
  router.post('/admin/avatars/:id/decision', authRequired, adminRequired, (req, res) => {
    const u = one('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!u) return res.status(404).json({ error:'Missing user' });
    if (req.body.approve) run('UPDATE users SET avatar=pending_avatar,pending_avatar=NULL WHERE id=?', [u.id]); else run('UPDATE users SET pending_avatar=NULL WHERE id=?', [u.id]);
    notify(io, u.id, 'profile_photo_decision', req.body.approve ? 'Profile photo approved' : 'Profile photo rejected', req.body.reason || '', '/profile');
    res.json({ ok:true });
  });
  router.post('/admin/instructors/:id/decision', authRequired, adminRequired, (req, res) => {
    const app = one('SELECT * FROM instructor_applications WHERE id=?', [req.params.id]);
    if (!app) return res.status(404).json({ error:'Missing application' });
    const status = req.body.approve ? 'approved' : 'rejected';
    run('UPDATE instructor_applications SET status=?, reason=? WHERE id=?', [status, req.body.reason || '', app.id]);
    if (req.body.approve) run("UPDATE users SET role='instructor' WHERE id=?", [app.user_id]);
    notify(io, app.user_id, 'instructor_decision', `Instructor application ${status}`, req.body.reason || '', '/dashboard');
    res.json({ ok:true });
  });
  router.get('/admin/reports', authRequired, adminRequired, (_, res) => res.json(all('SELECT r.*, u.name reporter FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC')));
  router.get('/admin/banned-words', authRequired, adminRequired, (_, res) => res.json(all('SELECT * FROM banned_words ORDER BY word')));
  router.post('/admin/banned-words', authRequired, adminRequired, (req, res) => { run('INSERT OR IGNORE INTO banned_words (word) VALUES (?)', [req.body.word]); res.json(all('SELECT * FROM banned_words ORDER BY word')); });
  router.delete('/admin/banned-words/:id', authRequired, adminRequired, (req, res) => { run('DELETE FROM banned_words WHERE id=?', [req.params.id]); res.json({ ok:true }); });

  return router;
}
