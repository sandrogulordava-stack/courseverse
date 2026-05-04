# CourseVerse One-Shot Course Publish Fix

ეს ZIP არის ბოლო patch. შეიცავს:

- `server/src/index.js` — კურსების შექმნა/approval/public visibility სრულად გასწორებულია
- `server/src/db.js` — ძველი/გაფუჭებული კურსების status normalization დაემატა
- `client/src/main.jsx` — არსებული final frontend შენარჩუნებულია
- `client/src/styles.css` — არსებული final style შენარჩუნებულია
- `client/dist` — build უკვე გაკეთებულია და შეგიძლია პირდაპირ Netlify-ზე ატვირთო

## რა გასწორდა

1. Admin approve-ის შემდეგ კურსი ხდება:
   - `published = 1`
   - `hidden = 0`
   - `status = 'published'`
   - `approval_status = 'approved'`

2. Courses გვერდი აჩვენებს მხოლოდ რეალურად public კურსებს.

3. ძველი approved კურსები, რომლებსაც `published = 0` დარჩათ, ავტომატურად self-heal-დება `/api/courses` გამოძახებისას.

4. დაემატა emergency endpoint:

```js
POST /api/admin/fix-course-visibility
```

თუ ძველი approved კურსები მაინც არ ჩანს, admin account-ით browser console-ში გაუშვი:

```js
fetch('https://courseverse-backend-3ptn.onrender.com/api/admin/fix-course-visibility', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
}).then(r => r.json()).then(console.log)
```

## როგორ ჩასვა

ჩაანაცვლე შენს პროექტში ეს ფაილები:

```txt
server/src/index.js
server/src/db.js
client/src/main.jsx
client/src/styles.css
```

შემდეგ:

```bash
cd ~/Desktop/codes/courseverse
git add .
git commit -m "fix course approval publishing visibility"
git push
```

Render-ზე:

```txt
Manual Deploy → Deploy latest commit
```

Netlify-ზე შეგიძლია პირდაპირ ატვირთო ამ ZIP-ში არსებული:

```txt
client/dist
```

ან შენთან ააწყო თავიდან:

```bash
cd ~/Desktop/codes/courseverse/client
rm -rf dist
npm install --legacy-peer-deps
npm run build
```

და მერე ატვირთო `client/dist`.
