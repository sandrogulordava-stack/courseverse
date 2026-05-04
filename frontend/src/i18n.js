export const dict = {
  en: {
    app: 'CourseVerse', courses: 'Courses', dashboard: 'Dashboard', people: 'People', messenger: 'Messenger', rooms: 'Rooms', admin: 'Admin', login: 'Login', logout: 'Logout', profile: 'Profile', search: 'Search', explore: 'Explore courses', teach: 'Become instructor', heroTitle: 'Teach live, sell courses, and build a learning community.', heroText: 'A polished SaaS-style platform with marketplace, approvals, realtime chat and Zoom-like classrooms.', create: 'Create', save: 'Save', submit: 'Submit', enroll: 'Buy / Enroll', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', free: 'Free', paid: 'Paid', notifications: 'Notifications', friends: 'Friends'
  },
  ka: {
    app: 'CourseVerse', courses: 'კურსები', dashboard: 'დეშბორდი', people: 'ადამიანები', messenger: 'მესენჯერი', rooms: 'ოთახები', admin: 'ადმინი', login: 'შესვლა', logout: 'გასვლა', profile: 'პროფილი', search: 'ძებნა', explore: 'კურსების ნახვა', teach: 'ინსტრუქტორი გახდი', heroTitle: 'ასწავლე ლაივში, გაყიდე კურსები და შექმენი სასწავლო საზოგადოება.', heroText: 'პროფესიონალური SaaS სტილის პლატფორმა მარკეტით, დამტკიცებებით, ჩატით და Zoom-ის მსგავს ოთახებით.', create: 'შექმნა', save: 'შენახვა', submit: 'გაგზავნა', enroll: 'ყიდვა / ჩაწერა', pending: 'მოლოდინში', approved: 'დამტკიცებულია', rejected: 'უარყოფილია', free: 'უფასო', paid: 'ფასიანი', notifications: 'შეტყობინებები', friends: 'მეგობრები'
  }
};
export const t = (lang, key) => dict[lang]?.[key] || dict.en[key] || key;
