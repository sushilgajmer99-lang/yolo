# Dept Tracker

Weekly task tracker for six departments: Marketing & Content, Retail, Operation, Finance, Inventory, Customer Support.

Each department tracks four lists per week:
1. Last week's tasks completed
2. This week's tasks pending
3. Bottlenecks
4. Tasks to clear bottlenecks

**Access is by email.** Only emails listed in `access.json` (or added later on the admin *Access* tab) can request a one-time sign-in link (15 min, single use). Members see and edit only their own department; admins see an overview of all departments and manage access.

"Roll forward to next week" turns finished tasks into next week's *completed* list and carries unfinished tasks and open bottlenecks over.

## Run
```
npm install
# edit access.json with real emails (used only the first time, to seed data/db.json)
npm start            # http://localhost:3000
npm test
```

## Email (required in production)
```
SMTP_URL=smtps://user:app-password@smtp.gmail.com:465
MAIL_FROM="Dept Tracker <you@company.com>"
BASE_URL=https://tracker.yourcompany.com
NODE_ENV=production
```
Without `SMTP_URL` (dev only) the sign-in link is printed to the server console and shown on the login page. With `NODE_ENV=production` it is never shown.

Data lives in `data/db.json` (set `DATA_FILE` to move it; back it up). Serve behind HTTPS in production.
