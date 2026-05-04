import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { migrate, one, run } from './db.js';
import { buildRoutes } from './routes.js';
import { JWT_SECRET, CLIENT_URL, censor, notify } from './utils.js';

migrate();
const app = express();
const server = http.createServer(app);
const allowed = [CLIENT_URL, 'http://localhost:5173'].map(x => x.replace(/\/$/, ''));
const corsOptions = { origin: (origin, cb) => !origin || allowed.includes(origin.replace(/\/$/, '')) ? cb(null, true) : cb(new Error('CORS blocked')), credentials: true };
const io = new Server(server, { cors: corsOptions });

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 60_000, max: 240 }));
app.get('/health', (_, res) => res.json({ ok: true, service: 'courseverse-api' }));
app.use('/api', buildRoutes(io));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = one('SELECT * FROM users WHERE id=?', [payload.id]);
    if (!user || user.status !== 'active') return next(new Error('Unauthorized'));
    socket.user = user;
    next();
  } catch { next(new Error('Unauthorized')); }
});

io.on('connection', socket => {
  socket.join(`user:${socket.user.id}`);
  socket.on('room:join', ({ code }) => {
    const room = one('SELECT * FROM rooms WHERE code=?', [code]);
    if (!room || room.locked) return socket.emit('room:error', 'Room unavailable');
    socket.join(`room:${code}`);
    run('INSERT OR IGNORE INTO room_members (room_id,user_id,status) VALUES (?,?,?)', [room.id, socket.user.id, room.waiting_room && room.host_id !== socket.user.id ? 'waiting' : 'joined']);
    socket.to(`room:${code}`).emit('participant:joined', { id: socket.user.id, name: socket.user.name, avatar: socket.user.avatar });
  });
  socket.on('room:chat', ({ code, body }) => {
    const room = one('SELECT * FROM rooms WHERE code=?', [code]);
    if (!room) return;
    const safe = censor(body || '');
    const info = run('INSERT INTO room_messages (room_id,user_id,body) VALUES (?,?,?)', [room.id, socket.user.id, safe]);
    const msg = { id: info.lastInsertRowid, room_id: room.id, user_id: socket.user.id, name: socket.user.name, avatar: socket.user.avatar, body: safe, created_at: new Date().toISOString() };
    io.to(`room:${code}`).emit('room:chat', msg);
  });
  socket.on('signal:offer', data => socket.to(`user:${data.to}`).emit('signal:offer', { ...data, from: socket.user.id }));
  socket.on('signal:answer', data => socket.to(`user:${data.to}`).emit('signal:answer', { ...data, from: socket.user.id }));
  socket.on('signal:ice', data => socket.to(`user:${data.to}`).emit('signal:ice', { ...data, from: socket.user.id }));
  socket.on('meeting:raise-hand', ({ code }) => socket.to(`room:${code}`).emit('meeting:raise-hand', { userId: socket.user.id, name: socket.user.name }));
  socket.on('host:mute', ({ userId, code }) => io.to(`user:${userId}`).emit('host:mute', { code }));
  socket.on('host:remove', ({ userId, code }) => { io.to(`user:${userId}`).emit('host:remove', { code }); socket.to(`room:${code}`).emit('participant:removed', { userId }); });
  socket.on('host:lock', ({ code, locked }) => { const room = one('SELECT * FROM rooms WHERE code=?', [code]); if (room?.host_id === socket.user.id) { run('UPDATE rooms SET locked=? WHERE id=?', [locked?1:0, room.id]); io.to(`room:${code}`).emit('room:locked', { locked }); } });
  socket.on('meeting:end', ({ code }) => { const room = one('SELECT * FROM rooms WHERE code=?', [code]); if (room?.host_id === socket.user.id) io.to(`room:${code}`).emit('meeting:ended'); });
});

const port = process.env.PORT || 5000;
server.listen(port, () => console.log(`CourseVerse API running on ${port}`));
