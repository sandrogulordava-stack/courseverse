# CourseVerse Polished Final Upgrade

ამ ვერსიაში დამატებულია/გასწორებულია:

- Refresh-ის შემდეგ account რჩება შესული, token-ის ვადა 30 დღემდე გაიზარდა.
- Google login token და invite link ერთად მუშაობს.
- Profile photo აღარ უნდა იშლებოდეს თავიდან შესვლისას; ახალი ფოტო ისევ მიდის admin approval-ში.
- ქართული/ინგლისური ენის გადართვის ღილაკი navbar-ში.
- უკეთესი marketplace/course store დიზაინი.
- გაუმჯობესებული room creation settings.
- Room invite link: `https://your-site.netlify.app/?join=CODE` — ლინკზე შესვლისას user login-ის შემდეგ ავტომატურად joins room-ში.
- Fullscreen Zoom room-ში ქვედა control panel ჩანს fixed bottom-ზე.
- Screen share რჩება მთავარი stage.
- Messenger/Classrooms/Profile ვიზუალი გაუმჯობესებულია.

## როგორ ჩასვა

შეცვალე შენი პროექტში ეს ფაილები ამ ZIP-იდან:

```txt
client/src/main.jsx
client/src/styles.css
server/src/auth.js
server/src/index.js
```

შემდეგ:

```bash
cd ~/Desktop/codes/courseverse
git add .
git commit -m "polish ui room invites language and session"
git push
```

Render-ზე: Manual Deploy → Deploy latest commit

Frontend:

```bash
cd ~/Desktop/codes/courseverse/client
rm -rf dist
npm run build
```

Netlify-ზე ატვირთე ახალი `client/dist`.

## მნიშვნელოვანი
Render Environment-ში `CLIENT_URL` უნდა იყოს slash-ის გარეშე:

```env
CLIENT_URL=https://your-course-3.netlify.app
```
