# CourseVerse Admin + Approval + Friends Fix

ეს ZIP აგვარებს:

- Admin Panel → Users-ში მომხმარებლის profile photo remove
- user block / unblock
- user soft delete და მისი კურსების დამალვა
- avatar approval preview
- course approval-ის შემდეგ course-ის `published=1` და `approval_status=approved`
- People/Friends request flow-ის გამყარება
- დაბლოკილი ან deleted user აღარ ჩანს People-ში და ვეღარ შედის login-ით

## ჩასმა

შეცვალე პროექტში ეს ფაილები ამ ZIP-იდან:

- `server/src/db.js`
- `server/src/auth.js`
- `server/src/index.js`
- `client/src/main.jsx`
- `client/src/styles.css`

ან მთლიანად გადაიტანე ZIP-ის შიგთავსი შენს `courseverse` ფოლდერში.

## Deploy

```bash
cd ~/Desktop/codes/courseverse
git add .
git commit -m "fix admin users approvals and friends"
git push
```

Render-ზე:

```txt
Manual Deploy → Deploy latest commit
```

Frontend:

```bash
cd ~/Desktop/codes/courseverse/client
rm -rf dist
npm install --legacy-peer-deps
npm run build
```

Netlify-ზე ატვირთე ახალი `client/dist`.

## მნიშვნელოვანი

Render Environment-ში `CLIENT_URL` იყოს slash-ის გარეშე:

```env
CLIENT_URL=https://your-course-3.netlify.app
```
