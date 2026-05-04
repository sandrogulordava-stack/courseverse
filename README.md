# CourseVerse — Full-Stack Online Course Platform

CourseVerse is a full-stack online course marketplace and live teaching platform built with React + Vite, Node.js + Express, SQLite, JWT authentication, Google OAuth support, Socket.IO realtime messaging, and WebRTC-ready classroom signaling.

It is designed as a serious SaaS-style learning platform, not a plain Udemy/Coursera clone: dark/light theme, glassmorphism cards, responsive layouts, admin approvals, moderation, social features, messenger, notifications, and Zoom-like classrooms.

## Demo Accounts

All demo accounts use this password:

```txt
demo12345
```

| Role | Email |
|---|---|
| Admin | admin@courseverse.dev |
| Instructor | instructor@courseverse.dev |
| Student | student@courseverse.dev |

## Main Features

- Email/password registration and login
- JWT session persistence through browser refresh/reopen
- `/api/me` session restore
- Google OAuth route support
- Roles: student, instructor, admin
- Blocked/deleted users cannot log in
- Public profile pages and editable profile fields
- Avatar changes require admin approval
- Course marketplace with filters and sorting
- Course publishing approval flow
- Purchased and submitted courses dashboard
- Instructor applications and approval flow
- People search, friend requests, accepted friends
- Facebook Messenger-style private chat
- Realtime notifications with Socket.IO
- Classroom rooms with invite codes and public/private/unlisted visibility
- Zoom-like meeting UI with camera preview, mute, screen share, tiles, sidebar chat, host signaling controls
- Admin panel: overview, users, approvals, reports, moderation words
- Banned words moderation and chat auto-censoring
- English/Georgian translation dictionary with persisted language preference
- Netlify-ready frontend redirects
- Render-ready backend environment variables

## Folder Structure

```txt
courseverse/
  backend/
    src/
      db.js
      routes.js
      seed.js
      server.js
      utils.js
    .env.example
    package.json
  frontend/
    public/
      _redirects
    src/
      api.js
      i18n.js
      main.jsx
      styles.css
    .env.example
    index.html
    package.json
  package.json
  README.md
```

## Local Setup

### 1. Install dependencies

From the project root:

```bash
npm run install:all
```

Or install separately:

```bash
cd backend
npm install
cd ../frontend
npm install
```

### 2. Configure environment variables

Create backend `.env` from the example:

```bash
cd backend
cp .env.example .env
```

Recommended local backend `.env`:

```env
PORT=5000
CLIENT_URL=http://localhost:5173
JWT_SECRET=replace_with_long_random_secret
SESSION_SECRET=replace_with_another_secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback
ADMIN_EMAILS=admin@courseverse.dev
DATABASE_URL=./courseverse.sqlite
```

Create frontend `.env`:

```bash
cd ../frontend
cp .env.example .env
```

Recommended local frontend `.env`:

```env
VITE_API_URL=http://localhost:5000
```

### 3. Seed the database

```bash
cd backend
npm run seed
```

This creates demo users, sample courses, banned words, and a demo room.

### 4. Start development servers

From the project root:

```bash
npm run dev
```

Frontend: `http://localhost:5173`  
Backend: `http://localhost:5000`

## Production Build

Frontend:

```bash
cd frontend
npm run build
```

Backend:

```bash
cd backend
npm start
```

## Netlify Frontend Deployment

1. Set base directory to `frontend`.
2. Build command:

```bash
npm run build
```

3. Publish directory:

```txt
dist
```

4. Add environment variable:

```env
VITE_API_URL=https://your-render-backend.onrender.com
```

The file `frontend/public/_redirects` already contains:

```txt
/* /index.html 200
```

## Render Backend Deployment

1. Create a new Web Service from the `backend` folder.
2. Build command:

```bash
npm install && npm run seed
```

3. Start command:

```bash
npm start
```

4. Add environment variables:

```env
CLIENT_URL=https://your-netlify-site.netlify.app
JWT_SECRET=your_long_random_secret
SESSION_SECRET=your_other_secret
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=https://your-render-backend.onrender.com/api/auth/google/callback
ADMIN_EMAILS=admin@courseverse.dev,your@email.com
DATABASE_URL=./courseverse.sqlite
```

## Important Notes

- SQLite is used for local development and simple Render deployment. The database access is centralized in `backend/src/db.js`, so migration to PostgreSQL later is straightforward.
- Uploaded image handling is represented with URL fields and upload-ready structure. For real production uploads, connect Cloudinary, S3, or a similar storage provider.
- WebRTC peer connection UI/signaling hooks are present through Socket.IO events. For large meetings, add an SFU such as LiveKit, mediasoup, or Daily.
- Google OAuth only activates when Google client environment variables are provided.
- Admin emails are configurable via `ADMIN_EMAILS`.

## Stability Checklist Included

- Fallback avatars and course thumbnails
- No hardcoded production localhost in frontend/backend deployment paths
- CORS normalizes trailing slashes
- `/api/me` restores session after refresh
- Protected routes block deleted/blocked users
- Course approvals notify instructors
- Profile photo approvals notify users
- Friend/message/room/admin notifications are realtime-ready
- Georgian text uses a dictionary and responsive navbar/dropdown layout
