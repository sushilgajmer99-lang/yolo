'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEPARTMENTS = [
  { id: 'marketing', name: 'Marketing & Content' },
  { id: 'retail', name: 'Retail' },
  { id: 'operation', name: 'Operation' },
  { id: 'finance', name: 'Finance' },
  { id: 'inventory', name: 'Inventory' },
  { id: 'support', name: 'Customer Support' },
];

// The four things tracked per department, per week.
const CATEGORIES = ['completed', 'pending', 'bottleneck', 'clearing'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;

class Store {
  constructor(file, seedFile) {
    this.file = file;
    this.db = { users: [], items: [], sessions: {}, tokens: {} };
    if (fs.existsSync(file)) this.db = { ...this.db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    else if (seedFile && fs.existsSync(seedFile)) this.seed(JSON.parse(fs.readFileSync(seedFile, 'utf8')));
    this.save();
  }

  seed(cfg) {
    for (const e of cfg.admins || []) this.upsertUser(e, null, 'admin');
    for (const [dept, emails] of Object.entries(cfg.departments || {}))
      if (DEPARTMENTS.some((d) => d.id === dept)) for (const e of emails) this.upsertUser(e, dept, 'member');
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- users / access ----
  findUser(email) { return this.db.users.find((u) => u.email === normEmail(email)); }
  upsertUser(email, dept, role) {
    email = normEmail(email);
    if (!validEmail(email)) throw new Error('Invalid email');
    let u = this.findUser(email);
    if (!u) this.db.users.push((u = { email }));
    u.dept = role === 'admin' ? null : dept;
    u.role = role;
    this.save();
    return u;
  }
  removeUser(email) {
    const u = this.findUser(email);
    if (!u) return;
    this.db.users = this.db.users.filter((x) => x !== u);
    for (const [k, s] of Object.entries(this.db.sessions)) if (s.email === u.email) delete this.db.sessions[k];
    this.save();
  }

  // ---- magic links & sessions (only hashes are stored) ----
  createLoginToken(email, ttlMs = 15 * 60e3) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.prune();
    this.db.tokens[sha(token)] = { email: normEmail(email), exp: Date.now() + ttlMs };
    this.save();
    return token;
  }
  consumeLoginToken(token) {
    const h = sha(String(token || ''));
    const t = this.db.tokens[h];
    if (!t) return null;
    delete this.db.tokens[h]; // single use
    this.save();
    if (t.exp < Date.now() || !this.findUser(t.email)) return null;
    return t.email;
  }
  createSession(email, ttlMs = 7 * 24 * 3600e3) {
    const id = crypto.randomBytes(32).toString('base64url');
    this.db.sessions[sha(id)] = { email, exp: Date.now() + ttlMs };
    this.save();
    return id;
  }
  sessionUser(id) {
    const s = this.db.sessions[sha(String(id || ''))];
    if (!s || s.exp < Date.now()) return null;
    return this.findUser(s.email) || null;
  }
  destroySession(id) { delete this.db.sessions[sha(String(id || ''))]; this.save(); }
  prune() {
    const now = Date.now();
    for (const m of [this.db.tokens, this.db.sessions])
      for (const [k, v] of Object.entries(m)) if (v.exp < now) delete m[k];
  }

  // ---- items ----
  listItems(dept, week) { return this.db.items.filter((i) => i.dept === dept && i.week === week); }
  addItem(dept, week, category, text, by) {
    const item = { id: crypto.randomUUID(), dept, week, category, text, owner: '', due: '', done: false, createdBy: by, createdAt: new Date().toISOString() };
    this.db.items.push(item);
    this.save();
    return item;
  }
  updateItem(id, patch) {
    const it = this.db.items.find((i) => i.id === id);
    if (!it) return null;
    if (typeof patch.text === 'string' && patch.text.trim()) it.text = patch.text.trim().slice(0, 1000);
    if (typeof patch.owner === 'string') it.owner = patch.owner.trim().slice(0, 100);
    if (typeof patch.due === 'string' && (patch.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(patch.due))) it.due = patch.due;
    if (typeof patch.done === 'boolean') it.done = patch.done;
    this.save();
    return it;
  }
  getItem(id) { return this.db.items.find((i) => i.id === id); }
  deleteItem(id) { this.db.items = this.db.items.filter((i) => i.id !== id); this.save(); }
}

// Monday (UTC date string) of the week containing `d`.
function weekStart(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
const isWeek = (w) => /^\d{4}-\d{2}-\d{2}$/.test(w) && weekStart(new Date(w + 'T00:00:00Z')) === w;
function shiftWeek(w, n) {
  const d = new Date(w + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7 * n);
  return d.toISOString().slice(0, 10);
}

module.exports = { Store, DEPARTMENTS, CATEGORIES, normEmail, validEmail, weekStart, isWeek, shiftWeek };
