import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

const DB_FILE = path.join(process.cwd(), 'courseverse-data.json');

const initial = () => ({ users: [], courses: [], lessons: [], purchases: [], rooms: [], room_members: [], messages: [], friends: [], friend_requests: [], notifications: [], room_invites: [], direct_threads: [], direct_messages: [], reports: [], moderation_violations: [], moderation_settings: [{ banned_words: ['spam','scam'], auto_unpublish: true }], approval_requests: [] });
let data = initial();

function ensureShape() {
  const base = initial();
  for (const key of Object.keys(base)) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  for (const course of data.courses) {
    if (!course.approval_status) course.approval_status = course.published === 0 ? 'hidden' : 'approved';
  }
  for (const room of data.rooms) {
    if (typeof room.is_public === 'undefined') room.is_public = 1;
    if (!room.invite_code) room.invite_code = String(room.id).slice(0, 8).toUpperCase();
    if (!room.description) room.description = '';
    if (!room.approval_status) room.approval_status = room.is_public === 0 ? 'private' : 'approved';
    if (typeof room.requested_public === 'undefined') room.requested_public = room.is_public ? 1 : 0;
  }
}
function load() {
  if (fs.existsSync(DB_FILE)) data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  ensureShape();
}
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function now() { return new Date().toISOString(); }
function normalizeUser(u) {
  return { headline: '', bio: '', avatar: '', role: 'student', ...u };
}
function instructorFields(course) {
  const u = data.users.find(x => x.id === course.instructor_id) || {};
  return { ...course, instructor_name: u.name || 'Unknown', instructor_avatar: u.avatar || '' };
}

load();

export const db = {
  pragma() {},
  exec() { save(); },
  prepare(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    return {
      get(...params) {
        if (s.startsWith('SELECT COUNT(*) as c FROM users')) return { c: data.users.length };
        if (s.startsWith('SELECT * FROM users WHERE id=?')) return data.users.find(u => u.id === params[0]);
        if (s.startsWith('SELECT * FROM users WHERE email=?')) return data.users.find(u => u.email === params[0]);
        if (s.startsWith('SELECT id FROM users WHERE email=?')) {
          const u = data.users.find(u => u.email === params[0]);
          return u ? { id: u.id } : undefined;
        }
        if (s.startsWith('SELECT c.*, u.name instructor_name')) {
          const c = data.courses.find(c => c.id === params[0]);
          return c ? instructorFields(c) : undefined;
        }
        if (s.startsWith('SELECT * FROM courses WHERE id=?')) return data.courses.find(c => c.id === params[0]);
        if (s.startsWith('SELECT * FROM rooms WHERE id=?')) return data.rooms.find(r => r.id === params[0]);
        if (s.startsWith('SELECT 1 FROM room_members')) {
          return data.room_members.some(m => m.room_id === params[0] && m.user_id === params[1]) ? { 1: 1 } : undefined;
        }
        return undefined;
      },
      all(...params) {
        if (s.startsWith('SELECT c.*, u.name instructor_name')) {
          let q = '', category = '', level = '';
          if (s.includes('c.title LIKE')) { q = String(params.shift() || '').replaceAll('%','').toLowerCase(); params.shift(); }
          if (s.includes('c.category=?')) category = params.shift();
          if (s.includes('c.level=?')) level = params.shift();
          return data.courses
            .filter(c => c.published !== 0)
            .filter(c => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
            .filter(c => !category || c.category === category)
            .filter(c => !level || c.level === level)
            .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)))
            .map(instructorFields);
        }
        if (s.startsWith('SELECT * FROM lessons WHERE course_id=?')) {
          return data.lessons.filter(l => l.course_id === params[0]).sort((a,b) => a.position - b.position);
        }
        if (s.startsWith('SELECT c.* FROM purchases')) {
          return data.purchases
            .filter(p => p.user_id === params[0])
            .map(p => data.courses.find(c => c.id === p.course_id))
            .filter(Boolean);
        }
        if (s.startsWith('SELECT * FROM courses WHERE instructor_id=?')) {
          return data.courses.filter(c => c.instructor_id === params[0]).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
        }
        if (s.startsWith('SELECT id,name,email,avatar,role,headline FROM users')) {
          const q = String(params[0] || '').replaceAll('%','').toLowerCase();
          return data.users
            .filter(u => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
            .slice(0,25)
            .map(u => ({ id:u.id, name:u.name, email:u.email, avatar:u.avatar, role:u.role, headline:u.headline }));
        }
        if (s.startsWith('SELECT r.*, u.name owner_name FROM rooms')) {
          const userId = params[0];
          return data.rooms
            .filter(r => data.room_members.some(m => m.room_id === r.id && m.user_id === userId))
            .map(r => ({ ...r, owner_name: data.users.find(u => u.id === r.owner_id)?.name || '' }))
            .sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
        }
        if (s.startsWith('SELECT m.*, u.name, u.avatar FROM messages')) {
          return data.messages
            .filter(m => m.room_id === params[0])
            .sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)))
            .slice(0,200)
            .map(m => ({ ...m, name: data.users.find(u => u.id === m.user_id)?.name || '', avatar: data.users.find(u => u.id === m.user_id)?.avatar || '' }));
        }
        return [];
      },
      run(...params) {
        if (s.startsWith('INSERT INTO users')) {
          if (s.includes('google_id')) {
            const [id,name,email,avatar,google_id,role] = params;
            data.users.push(normalizeUser({ id,name,email,avatar,google_id,role,created_at:now() }));
          } else if (s.includes('headline,bio,avatar')) {
            const [id,name,email,password_hash,role,headline,bio,avatar] = params;
            data.users.push(normalizeUser({ id,name,email,password_hash,role,headline,bio,avatar,created_at:now() }));
          } else {
            const [id,name,email,password_hash,role,avatar] = params;
            data.users.push(normalizeUser({ id,name,email,password_hash,role,avatar,created_at:now() }));
          }
          save(); return { changes: 1 };
        }
        if (s.startsWith('UPDATE users SET')) {
          const [name,headline,bio,avatar,role,id] = params;
          const u = data.users.find(u => u.id === id);
          if (u) Object.assign(u, { name, headline, bio, avatar, role });
          save(); return { changes: u ? 1 : 0 };
        }
        if (s.startsWith('INSERT INTO courses')) {
          const [id,instructor_id,title,category,level,price,image,description,video_url] = params;
          data.courses.push({ id,instructor_id,title,category,level,price:Number(price || 0),image,description,video_url,published:1,created_at:now() });
          save(); return { changes: 1 };
        }
        if (s.startsWith('INSERT INTO lessons')) {
          if (params.length === 5) {
            const [id,course_id,title,content,position] = params;
            data.lessons.push({ id,course_id,title,video_url:'',content,position,created_at:now() });
          } else {
            const [id,course_id,title,video_url,content,position] = params;
            data.lessons.push({ id,course_id,title,video_url,content,position,created_at:now() });
          }
          save(); return { changes: 1 };
        }
        if (s.startsWith('INSERT OR IGNORE INTO purchases')) {
          const [id,user_id,course_id,amount] = params;
          if (!data.purchases.some(p => p.user_id === user_id && p.course_id === course_id)) data.purchases.push({ id,user_id,course_id,amount,created_at:now() });
          save(); return { changes: 1 };
        }
        if (s.startsWith('INSERT INTO rooms')) {
          const [id,owner_id,title,course_id] = params;
          data.rooms.push({ id,owner_id,title,course_id,description:'',is_public:1,invite_code:String(id).slice(0,8).toUpperCase(),created_at:now() });
          save(); return { changes: 1 };
        }
        if (s.startsWith('INSERT OR IGNORE INTO room_members')) {
          const [room_id,user_id] = params;
          if (!data.room_members.some(m => m.room_id === room_id && m.user_id === user_id)) data.room_members.push({ room_id,user_id });
          save(); return { changes: 1 };
        }
        if (s.startsWith('INSERT INTO messages')) {
          const [id,room_id,user_id,body,created_at] = params;
          data.messages.push({ id,room_id,user_id,body,created_at });
          save(); return { changes: 1 };
        }
        return { changes: 0 };
      }
    };
  }
};

export function migrate() {
  load();
  if (data.users.length === 0) seed();
  ensureShape();
  save();
}

export function readData() {
  load();
  return data;
}

export function saveData() {
  ensureShape();
  save();
}

export function publicUserFromData(u) {
  if (!u) return null;
  return { id:u.id, name:u.name, email:u.email, avatar:u.avatar || '', role:u.role || 'student', headline:u.headline || '', bio:u.bio || '' };
}

function seed() {
  const pass = bcrypt.hashSync('demo12345', 10);
  const u1 = uuid();
  const u2 = uuid();
  data.users.push(normalizeUser({ id:u1, name:'Demo Instructor', email:'instructor@courseverse.dev', password_hash:pass, role:'instructor', headline:'Senior Frontend Mentor', bio:'I teach practical web development.', avatar:'https://i.pravatar.cc/120?img=12', created_at:now() }));
  data.users.push(normalizeUser({ id:u2, name:'Demo Student', email:'student@courseverse.dev', password_hash:pass, role:'student', headline:'Future developer', bio:'Learning one project at a time.', avatar:'https://i.pravatar.cc/120?img=32', created_at:now() }));

  const courses = [
    ['React Masterclass 2026','Programming','Beginner',39,'https://images.unsplash.com/photo-1633356122544-f134324a6cee?q=80&w=1400&auto=format&fit=crop','Build modern React apps with components, hooks, routing and real projects.'],
    ['UI/UX Design System','Design','Intermediate',49,'https://images.unsplash.com/photo-1545235617-9465d2a55698?q=80&w=1400&auto=format&fit=crop','Create polished interfaces, design tokens, layouts and clickable prototypes.'],
    ['Digital Marketing Launchpad','Marketing','Beginner',29,'https://images.unsplash.com/photo-1460925895917-afdab827c52f?q=80&w=1400&auto=format&fit=crop','Plan campaigns, funnels, content calendars and analytics dashboards.']
  ];
  for (const [title, category, level, price, image, description] of courses) {
    const cid = uuid();
    data.courses.push({ id:cid, instructor_id:u1, title, category, level, price, image, description, video_url:'https://www.youtube.com/embed/dQw4w9WgXcQ', published:1, created_at:now() });
    for (let i=1;i<=4;i++) data.lessons.push({ id:uuid(), course_id:cid, title:`Lesson ${i}: ${['Intro','Core Concepts','Practice','Project'][i-1]}`, video_url:'', content:`Detailed lesson notes for ${title}.`, position:i, created_at:now() });
  }
}
