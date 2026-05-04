import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { migrate, one, run } from './db.js';

migrate();
const password = bcrypt.hashSync('demo12345', 10);
const users = [
  ['Admin', 'admin@courseverse.dev', 'admin', 'Platform owner and moderation lead', 'Keeps CourseVerse safe'],
  ['Mariam Instructor', 'instructor@courseverse.dev', 'instructor', 'Teaches practical web development and design', 'Senior full-stack instructor'],
  ['Sandro Student', 'student@courseverse.dev', 'student', 'Learning programming and creative tools', 'Curious student']
];
for (const [name,email,role,bio,headline] of users) {
  if (!one('SELECT id FROM users WHERE email=?', [email])) {
    run('INSERT INTO users (name,email,password_hash,role,bio,headline,avatar) VALUES (?,?,?,?,?,?,?)', [name,email,password,role,bio,headline,`https://api.dicebear.com/8.x/avataaars/svg?seed=${encodeURIComponent(name)}`]);
  }
}
const instructor = one('SELECT id FROM users WHERE email=?', ['instructor@courseverse.dev']);
const courses = [
  ['React SaaS Interfaces', 'Build polished dashboards, reusable components, and a deployable Vite app.', 'Programming', 'Intermediate', 49, 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200', JSON.stringify(['Design system setup','Routing and layouts','Reusable cards','Deployment'])],
  ['AI Product Design', 'Create useful AI products with UX flows, prompts, safety states, and launch checklists.', 'AI', 'Beginner', 39, 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=1200', JSON.stringify(['AI UX basics','Prompt systems','Evaluation','Launch plan'])],
  ['Marketing Analytics', 'Measure campaigns, conversion funnels, attribution, and growth experiments.', 'Marketing', 'Advanced', 59, 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=1200', JSON.stringify(['Metrics','Dashboards','Funnels','Experiments'])]
];
for (const c of courses) {
  if (!one('SELECT id FROM courses WHERE title=?', [c[0]])) {
    run('INSERT INTO courses (title,description,category,level,price,thumbnail,lessons,instructor_id,status,students_count) VALUES (?,?,?,?,?,?,?,?,?,?)', [...c, instructor.id, 'approved', Math.floor(Math.random()*300)+40]);
  }
}
if (!one('SELECT id FROM banned_words WHERE word=?', ['scam'])) run('INSERT INTO banned_words (word) VALUES (?)', ['scam']);
const admin = one('SELECT id FROM users WHERE email=?', ['admin@courseverse.dev']);
const code = 'DEMO123';
if (!one('SELECT id FROM rooms WHERE code=?', [code])) run('INSERT INTO rooms (code,title,description,visibility,max_participants,host_id) VALUES (?,?,?,?,?,?)', [code,'Live React Workshop','A public demo classroom with chat and meeting UI.','public',24, instructor.id]);
console.log('Seed complete. Demo users: admin@courseverse.dev, instructor@courseverse.dev, student@courseverse.dev / demo12345');
