# CourseVerse — Functional Course Marketplace MVP

ეს არის full-stack MVP კურსების გაყიდვის პლატფორმისთვის.

## რა შედის

- React + Vite frontend
- Node.js + Express backend
- SQLite database, ავტომატური seed მონაცემებით
- Email/password რეგისტრაცია და ლოგინი
- Google OAuth login-ის მზა კოდი
- JWT protected API
- მომხმარებლის პროფილი
- კურსების სია, ძებნა, კატეგორიის ფილტრი
- instructor-ის მიერ კურსის გამოქვეყნება
- lesson-ების დამატება
- demo purchase/enroll flow
- dashboard: ნაყიდი და გამოქვეყნებული კურსები
- classroom room-ების შექმნა
- კურსელების/მომხმარებლების დამატება ოთახში
- realtime chat Socket.IO-ით
- video call WebRTC signaling-ით
- screen sharing

## გაშვება

```bash
cd courseverse
npm install
npm run install:all
cp server/.env.example server/.env
npm run dev
```

Frontend: http://localhost:5173  
Backend: http://localhost:4000

## Demo accounts

```txt
student@courseverse.dev / demo12345
instructor@courseverse.dev / demo12345
```

## Google login

1. შედი Google Cloud Console-ში
2. შექმენი OAuth Client ID
3. Authorized redirect URI:

```txt
http://localhost:4000/auth/google/callback
```

4. `server/.env` ფაილში ჩასვი:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

## ვიდეოზარი და screen sharing

ორ სხვადასხვა ბრაუზერში ან incognito ფანჯარაში შედი ორი demo account-ით, შექმენი classroom და ორივე account დაამატე. შემდეგ ორივემ დააჭიროს `Start / join call`.

Production-ში უკეთესი ხარისხისთვის დაგჭირდება TURN server, მაგალითად Coturn ან Twilio Network Traversal.

## Payments

ამ ვერსიაში ყიდვა demo enrollment-ია. Production-ში ჩასასმელია Stripe Checkout ან PayPal. Backend-ში ამის ადგილი არის:

```txt
POST /api/courses/:id/buy
```

## შენიშვნა

ეს არ არის უბრალოდ დიზაინი — პროექტი რეალურად ეშვება და აქვს backend, database, auth, API, realtime chat და WebRTC signaling. Production-ისთვის საჭიროა payment integration, file/video hosting, admin panel, moderation და deployment კონფიგურაცია.

## Zoom-style Classroom Upgrade

This build includes a more Zoom-like classroom experience:

- Pre-join screen
- Large video stage
- Participant sidebar
- Chat/sidebar tabs
- Friend invites from inside the room
- Copy invite code
- Mute/unmute microphone
- Start/stop camera
- Screen sharing + stop sharing
- Leave call
- Fullscreen meeting mode
- Typing indicator
- Pinned chat message UI
- Participant live/idle status

After copying this version into your project, redeploy backend on Render and rebuild/reupload the frontend `client/dist` on Netlify.
