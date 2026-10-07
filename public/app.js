'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) e.append(k);
  return e;
};
const TITLES = {
  completed: ['Last week: tasks completed', 'What did we finish last week?'],
  pending: ['This week: tasks pending', 'What still needs to be done this week?'],
  bottleneck: ['Bottlenecks', 'What is blocking or slowing us down?'],
  clearing: ['Tasks to clear bottlenecks', 'What will unblock us?'],
};
let me, state = { tab: 'report', dept: null, week: null };

async function api(method, url, data) {
  const r = await fetch(url, { method, headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && me) { location.reload(); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const toast = (msg) => { const t = el('div', { id: 'toast', textContent: msg }); document.body.append(t); setTimeout(() => t.remove(), 2500); };
const guard = (fn) => (...a) => fn(...a).catch((e) => toast(e.message));
const shift = (w, n) => { const d = new Date(w + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };
const deptName = (id) => me.departments.find((d) => d.id === id)?.name || id;

// ---------- login ----------
async function boot() {
  const token = new URLSearchParams(location.search).get('token');
  if (token) {
    history.replaceState(null, '', '/');
    try { await api('POST', '/api/verify', { token }); } catch (e) { return showLogin(e.message); }
  }
  try { me = await api('GET', '/api/me'); } catch { return showLogin(); }
  state.dept = me.role === 'admin' ? me.departments[0].id : me.dept;
  state.week = me.thisWeek;
  state.tab = me.role === 'admin' ? 'overview' : 'report';
  $('#login').hidden = true; $('#app').hidden = false;
  $('#who').textContent = `${me.email} · ${me.role === 'admin' ? 'Admin' : deptName(me.dept)}`;
  $('#logout').onclick = async () => { await api('POST', '/api/logout', {}); location.reload(); };
  render();
}
function showLogin(msg = '') {
  $('#app').hidden = true; $('#login').hidden = false;
  $('#loginMsg').textContent = msg;
  $('#loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const msgEl = $('#loginMsg'); msgEl.textContent = 'Sending…';
    try {
      const r = await api('POST', '/api/login', { email: $('#email').value });
      msgEl.textContent = r.message;
      if (r.devLink) msgEl.append(el('br'), el('a', { href: r.devLink, textContent: 'Dev mode (no SMTP): click to sign in' }));
    } catch (e) { msgEl.textContent = e.message; }
  };
}

// ---------- shell ----------
function render() {
  const tabs = me.role === 'admin' ? [['overview', 'Overview'], ['report', 'Department report'], ['access', 'Access']] : [['report', 'Weekly report']];
  $('#tabs').replaceChildren(...tabs.map(([id, label]) => el('button', { textContent: label, className: state.tab === id ? 'on' : '', onclick: () => { state.tab = id; render(); } })));
  const view = { overview: renderOverview, report: renderReport, access: renderAccess }[state.tab];
  view().catch((e) => toast(e.message));
}
function weekBar(onChange, extra = []) {
  return el('div', { className: 'bar' },
    ...extra,
    el('button', { className: 'ghost', textContent: '←', onclick: () => { state.week = shift(state.week, -1); onChange(); } }),
    el('strong', { textContent: `Week of ${state.week}` }),
    el('button', { className: 'ghost', textContent: '→', onclick: () => { state.week = shift(state.week, 1); onChange(); } }),
    el('button', { className: 'ghost', textContent: 'This week', onclick: () => { state.week = me.thisWeek; onChange(); } }));
}

// ---------- weekly report ----------
async function renderReport() {
  const { items } = await api('GET', `/api/report?dept=${state.dept}&week=${state.week}`);
  const deptPicker = me.role === 'admin'
    ? [el('select', { onchange: (e) => { state.dept = e.target.value; render(); } }, me.departments.map((d) => el('option', { value: d.id, textContent: d.name, selected: d.id === state.dept })))]
    : [el('strong', { textContent: deptName(state.dept) })];
  const bar = weekBar(render, deptPicker);
  bar.append(el('span', { className: 'spacer' }), el('button', {
    className: 'ghost', textContent: 'Roll forward to next week', title: 'Finished tasks become next week\'s "completed"; unfinished tasks and open bottlenecks carry over',
    onclick: guard(async () => { const r = await api('POST', '/api/rollover', { dept: state.dept, week: state.week }); toast(r.added ? `${r.added} item(s) added to week of ${r.week}` : 'Nothing new to carry over'); }),
  }));
  $('#main').replaceChildren(bar, el('div', { className: 'grid' }, me.categories.map((c) => section(c, items.filter((i) => i.category === c)))));
}

function section(cat, items) {
  const [title, hint] = TITLES[cat];
  const toggles = cat !== 'completed';
  const doneLabel = cat === 'bottleneck' ? 'Resolved' : 'Done';
  const input = el('input', { placeholder: hint, maxLength: 1000 });
  const add = guard(async () => {
    if (!input.value.trim()) return;
    await api('POST', '/api/items', { dept: state.dept, week: state.week, category: cat, text: input.value });
    render();
  });
  input.onkeydown = (e) => e.key === 'Enter' && add();
  const patch = (it, p) => guard(async () => { await api('PATCH', `/api/items/${it.id}`, p); render(); });
  return el('section', { className: `card c-${cat}` },
    el('h2', { textContent: `${title} (${items.length})` }),
    items.map((it) => el('div', { className: 'item' + (it.done ? ' done' : '') },
      toggles ? el('input', { type: 'checkbox', checked: it.done, title: doneLabel, onchange: (e) => patch(it, { done: e.target.checked })() }) : '',
      el('div', { className: 't' },
        el('div', { textContent: it.text }),
        el('div', { className: 'meta' },
          el('input', { placeholder: 'Owner', value: it.owner, onchange: (e) => patch(it, { owner: e.target.value })() }),
          toggles ? el('input', { type: 'date', value: it.due, title: 'Due', onchange: (e) => patch(it, { due: e.target.value })() }) : '')),
      el('button', { className: 'icon', textContent: '✕', title: 'Delete', onclick: guard(async () => { if (confirm('Delete this item?')) { await api('DELETE', `/api/items/${it.id}`); render(); } }) }))),
    el('div', { className: 'add' }, input, el('button', { textContent: 'Add', onclick: add })));
}

// ---------- admin ----------
async function renderOverview() {
  const o = await api('GET', `/api/overview?week=${state.week}`);
  const row = (d) => el('tr', {},
    el('td', {}, el('a', { href: '#', textContent: d.name, onclick: (e) => { e.preventDefault(); state.dept = d.id; state.tab = 'report'; render(); } })),
    el('td', { textContent: d.completed }),
    el('td', { textContent: `${d.pendingDone}/${d.pending}` }),
    el('td', { className: d.openBottlenecks ? 'bad' : '', textContent: `${d.openBottlenecks} open / ${d.bottlenecks}` }),
    el('td', { textContent: `${d.clearingDone}/${d.clearing}` }));
  $('#main').replaceChildren(weekBar(render), el('div', { className: 'card' },
    el('table', {}, el('thead', {}, el('tr', {}, ['Department', 'Completed', 'Pending done', 'Bottlenecks', 'Clearing tasks done'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, o.departments.map(row)))));
}

async function renderAccess() {
  const users = await api('GET', '/api/users');
  const email = el('input', { type: 'email', placeholder: 'person@company.com' });
  const dept = el('select', {}, [...me.departments.map((d) => el('option', { value: d.id, textContent: d.name })), el('option', { value: '', textContent: 'Admin (all departments)' })]);
  const add = guard(async () => { await api('POST', '/api/users', { email: email.value, dept: dept.value, role: dept.value ? 'member' : 'admin' }); render(); });
  $('#main').replaceChildren(el('div', { className: 'card' },
    el('h2', { textContent: 'Who can sign in' }),
    el('p', { className: 'muted', textContent: 'Only emails listed here can request a sign-in link. Each member sees only their own department.' }),
    el('div', { className: 'bar' }, email, dept, el('button', { textContent: 'Add / update', onclick: add })),
    el('table', {}, el('tbody', {}, users.map((u) => el('tr', {},
      el('td', { textContent: u.email }),
      el('td', { textContent: u.role === 'admin' ? 'Admin' : deptName(u.dept) }),
      el('td', {}, u.email === me.email ? '' : el('button', { className: 'icon', textContent: 'Remove', onclick: guard(async () => { await api('DELETE', `/api/users?email=${encodeURIComponent(u.email)}`); render(); }) }))))))));
}

boot();
