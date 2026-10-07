'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, DEPARTMENTS, CATEGORIES, normEmail, validEmail, weekStart, isWeek, shiftWeek } = require('./lib/store');
const mailer = require('./lib/mailer');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const isProd = () => process.env.NODE_ENV === 'production';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function createApp({ store, baseUrl }) {
  const hits = new Map(); // naive in-memory rate limiter
  const limited = (key, max, windowMs) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length > max;
  };

  const cookie = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
  const setSession = (res, id, maxAge) =>
    res.setHeader('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isProd() ? '; Secure' : ''}`);

  async function body(req) {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 65536) throw new HttpError(413, 'Too large'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'Bad JSON'); }
  }

  const deptOk = (d) => DEPARTMENTS.some((x) => x.id === d);
  // Members are pinned to their own department; admins may pick any.
  function resolveDept(user, requested) {
    const dept = user.role === 'admin' ? requested : user.dept;
    if (!deptOk(dept)) throw new HttpError(400, 'Unknown department');
    return dept;
  }
  const needAdmin = (u) => { if (u.role !== 'admin') throw new HttpError(403, 'Admin only'); };
  const weekParam = (w) => { w = w || weekStart(); if (!isWeek(w)) throw new HttpError(400, 'Bad week'); return w; };
  function ownedItem(user, id) {
    const it = store.getItem(id);
    if (!it || (user.role !== 'admin' && it.dept !== user.dept)) throw new HttpError(404, 'Not found');
    return it;
  }
  const clean = (t, n = 1000) => String(t || '').trim().slice(0, n);

  async function api(req, res, url) {
    const m = req.method, p = url.pathname;
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

    // ---- unauthenticated ----
    if (m === 'POST' && p === '/api/login') {
      const { email: raw } = await body(req);
      const email = normEmail(raw);
      if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email');
      if (limited('ip:' + req.socket.remoteAddress, 20, 60e3) || limited('em:' + email, 3, 10 * 60e3)) throw new HttpError(429, 'Too many requests, try later');
      const out = { ok: true, message: 'If this email has access, a sign-in link has been sent.' };
      if (store.findUser(email)) {
        const link = `${baseUrl}/?token=${store.createLoginToken(email)}`;
        try {
          const sent = await mailer.sendLoginLink(email, link);
          if (!sent && !isProd()) out.devLink = link; // no SMTP configured: dev convenience only
        } catch (e) { console.error('mail failed:', e.message); throw new HttpError(502, 'Could not send email'); }
      }
      return json(out);
    }
    if (m === 'POST' && p === '/api/verify') {
      if (limited('v:' + req.socket.remoteAddress, 30, 60e3)) throw new HttpError(429, 'Too many requests');
      const { token } = await body(req);
      const email = store.consumeLoginToken(token);
      if (!email) throw new HttpError(401, 'This link is invalid or expired. Request a new one.');
      setSession(res, store.createSession(email), 7 * 24 * 3600);
      return json({ ok: true });
    }

    // ---- authenticated ----
    const sid = cookie(req).sid;
    const user = store.sessionUser(sid);
    if (!user) throw new HttpError(401, 'Not signed in');

    if (m === 'POST' && p === '/api/logout') { store.destroySession(sid); setSession(res, '', 0); return json({ ok: true }); }
    if (m === 'GET' && p === '/api/me')
      return json({ email: user.email, role: user.role, dept: user.dept, departments: DEPARTMENTS, categories: CATEGORIES, thisWeek: weekStart() });

    if (m === 'GET' && p === '/api/report') {
      const dept = resolveDept(user, url.searchParams.get('dept'));
      const week = weekParam(url.searchParams.get('week'));
      return json({ dept, week, items: store.listItems(dept, week) });
    }
    if (m === 'POST' && p === '/api/items') {
      const b = await body(req);
      const dept = resolveDept(user, b.dept);
      const text = clean(b.text);
      if (!text) throw new HttpError(400, 'Text required');
      if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Bad category');
      return json(store.addItem(dept, weekParam(b.week), b.category, text, user.email), 201);
    }
    const im = p.match(/^\/api\/items\/([\w-]+)$/);
    if (im && m === 'PATCH') { const it = ownedItem(user, im[1]); return json(store.updateItem(it.id, await body(req))); }
    if (im && m === 'DELETE') { const it = ownedItem(user, im[1]); store.deleteItem(it.id); return json({ ok: true }); }

    // Roll a week forward: finished work becomes next week's "last week completed",
    // unfinished tasks and open bottlenecks carry over.
    if (m === 'POST' && p === '/api/rollover') {
      const b = await body(req);
      const dept = resolveDept(user, b.dept);
      const from = weekParam(b.week), to = shiftWeek(from, 1);
      const existing = store.listItems(dept, to);
      let added = 0;
      for (const it of store.listItems(dept, from)) {
        const cat = it.category === 'completed' ? null : it.done ? (it.category === 'bottleneck' ? null : 'completed') : it.category;
        if (!cat || existing.some((e) => e.copiedFrom === it.id)) continue;
        const n = store.addItem(dept, to, cat, it.text, user.email);
        n.owner = it.owner; n.due = it.due; n.copiedFrom = it.id;
        added++;
      }
      store.save();
      return json({ ok: true, added, week: to });
    }

    // ---- admin ----
    if (m === 'GET' && p === '/api/overview') {
      needAdmin(user);
      const week = weekParam(url.searchParams.get('week'));
      return json({
        week,
        departments: DEPARTMENTS.map((d) => {
          const items = store.listItems(d.id, week);
          const c = (cat, f = () => true) => items.filter((i) => i.category === cat && f(i)).length;
          return { ...d, completed: c('completed'), pending: c('pending'), pendingDone: c('pending', (i) => i.done),
            bottlenecks: c('bottleneck'), openBottlenecks: c('bottleneck', (i) => !i.done), clearing: c('clearing'), clearingDone: c('clearing', (i) => i.done) };
        }),
      });
    }
    if (p === '/api/users') {
      needAdmin(user);
      if (m === 'GET') return json(store.db.users.map(({ email, dept, role }) => ({ email, dept, role })));
      if (m === 'POST') {
        const b = await body(req);
        const role = b.role === 'admin' ? 'admin' : 'member';
        if (role === 'member' && !deptOk(b.dept)) throw new HttpError(400, 'Choose a department');
        try { return json(store.upsertUser(b.email, b.dept, role), 201); } catch (e) { throw new HttpError(400, e.message); }
      }
      if (m === 'DELETE') {
        const email = normEmail(url.searchParams.get('email'));
        if (email === user.email) throw new HttpError(400, 'You cannot remove yourself');
        store.removeUser(email);
        return json({ ok: true });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      const full = path.join(PUBLIC, path.normalize(file));
      if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Server error' }));
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const store = new Store(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'), path.join(__dirname, 'access.json'));
  createApp({ store, baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '') })
    .listen(port, () => console.log(`Dept Tracker on http://localhost:${port}${mailer.configured() ? '' : '  (no SMTP: sign-in links print here)'}`));
}

module.exports = { createApp };
