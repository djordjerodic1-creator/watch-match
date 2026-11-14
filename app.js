// Watch Match — Tinder-style movie & show picker for two.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('wm-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wm-' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('wm-' + k); } catch {} },
};
const DEFAULT_NAMES = { a: 'Person A', b: 'Person B' };
const other = w => (w === 'a' ? 'b' : 'a');

// ---------- Storage backends ----------
async function makeStore(room) {
  const cfg = window.FIREBASE_CONFIG;
  if (cfg && cfg.databaseURL) {
    const V = '10.12.2';
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
    const { getDatabase, ref, onValue, update } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`);
    const db = getDatabase(initializeApp(cfg));
    const root = ref(db, `rooms/${room}`);
    return {
      mode: 'firebase',
      listen(cb) { onValue(root, snap => cb(snap.val() || {})); },
      // updates: { 'swipes/a/id': 1, 'names/a': 'X', 'watched/id': null }
      write(updates) { return update(root, updates); },
    };
  }
  // Local demo mode: syncs across tabs in the same browser only.
  const key = 'local-' + room;
  const listeners = [];
  const emit = () => listeners.forEach(cb => cb(LS.get(key, {})));
  addEventListener('storage', e => { if (e.key === 'wm-' + key) emit(); });
  return {
    mode: 'local',
    listen(cb) { listeners.push(cb); cb(LS.get(key, {})); },
    write(updates) {
      const tree = LS.get(key, {});
      for (const [path, val] of Object.entries(updates)) {
        const parts = path.split('/'); let node = tree;
        for (const p of parts.slice(0, -1)) node = node[p] ??= {};
        if (val === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = val;
      }
      LS.set(key, tree); emit(); return Promise.resolve();
    },
  };
}

// ---------- State ----------
let catalog = [], byId = {}, store, room, me;
let data = { names: {}, swipes: { a: {}, b: {} }, watched: {}, matchedAt: {} };
let kindFilter = LS.get('kind', 'all');
let genreFilter = new Set(LS.get('genres', []));
let matchFilter = 'todo';
const toasted = new Set();
let deck = [], undoStack = [], firstData = true, knownMatches = new Set();

const names = () => ({ a: data.names?.a || DEFAULT_NAMES.a, b: data.names?.b || DEFAULT_NAMES.b });
const mySwipes = () => data.swipes?.[me] || {};
const theirSwipes = () => data.swipes?.[other(me)] || {};
const isMatch = id => (data.swipes?.a?.[id] ?? 0) >= 1 && (data.swipes?.b?.[id] ?? 0) >= 1;
const matches = () => Object.keys(data.swipes?.a || {}).filter(id => byId[id] && isMatch(id));

// Seeded random so both of you see a similar order (more early matches).
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.toggle('hidden', s.id !== id));
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Boot ----------
async function boot() {
  const hashRoom = new URLSearchParams(location.hash.slice(1)).get('room');
  if (hashRoom) { LS.set('room', hashRoom.trim()); window.history.replaceState(null, '', location.pathname); }
  room = LS.get('room');
  try {
    const res = await fetch('data/catalog.json');
    catalog = (await res.json()).items;
  } catch { catalog = []; }
  byId = Object.fromEntries(catalog.map(x => [x.id, x]));
  if (!room) return showScreen('screen-setup');
  await enterRoom();
}

async function enterRoom() {
  store = await makeStore(room);
  me = LS.get('me:' + room);
  knownMatches = new Set(LS.get('seen:' + room, []));
  store.listen(onData);
  if (!me) { showScreen('screen-who'); $('#room-hint').textContent = `Room ${room}`; }
}

function onData(val) {
  data = { names: {}, watched: {}, matchedAt: {}, ...val, swipes: { a: {}, b: {}, ...(val.swipes || {}) } };
  const n = names();
  $$('[data-name]').forEach(el => (el.textContent = n[el.dataset.name]));
  if (!me) return;
  // Detect matches the partner completed while we're online.
  const ms = matches();
  if (!firstData) {
    for (const id of ms) if (!knownMatches.has(id) && !undoStack.some(h => h.id === id)) { if (!toasted.has(id)) { toasted.add(id); toast(`New match: ${byId[id].title} ♥`); } }
  }
  firstData = false;
  if ($('#screen-main').classList.contains('hidden')) startMain();
  else { renderMatchBadge(); if (!$('#view-matches').classList.contains('hidden')) renderMatches(); if (!$('#view-me').classList.contains('hidden')) renderMe(); refillDeck(); }
}

// ---------- Setup ----------
$('#btn-create').onclick = async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  room = [...bytes].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  LS.set('room', room); await enterRoom();
};
$('#form-join').onsubmit = async e => {
  e.preventDefault();
  let code = $('#join-code').value.trim();
  const m = code.match(/room=([\w-]+)/); if (m) code = m[1];
  if (!/^[\w-]{4,}$/.test(code)) return toast('That code looks off');
  room = code; LS.set('room', room); await enterRoom();
};
$$('.who').forEach(b => b.onclick = () => {
  const who = b.dataset.who;
  if (data.names?.[who]) return pickWho(who);
  $('.who-grid').classList.add('hidden');
  $('#name-form').classList.remove('hidden');
  $('#name-form').dataset.who = who;
  $('#name-input').focus();
});
$('#name-form').onsubmit = e => {
  e.preventDefault();
  const who = e.target.dataset.who, nm = $('#name-input').value.trim().slice(0, 20);
  if (nm) store.write({ [`names/${who}`]: nm });
  $('.who-grid').classList.remove('hidden'); e.target.classList.add('hidden');
  pickWho(who);
};
function pickWho(who) {
  me = who; LS.set('me:' + room, me);
  firstData = true; knownMatches = new Set(matches()); saveSeen();
  startMain();
}

// ---------- Main ----------
function startMain() {
  showScreen('screen-main');
  $$('#kind-filter button').forEach(b => b.classList.toggle('on', b.dataset.kind === kindFilter));
  buildGenreBar(); buildDeck(); renderMatchBadge();
}

$$('.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));
function switchView(v) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  ['swipe', 'matches', 'me'].forEach(x => $('#view-' + x).classList.toggle('hidden', x !== v));
  $('.top').classList.toggle('hidden', v !== 'swipe');
  $('#genre-bar').classList.toggle('hidden', v !== 'swipe' || !$('#btn-filters').classList.contains('on'));
  if (v === 'matches') { renderMatches(); knownMatches = new Set(matches()); saveSeen(); renderMatchBadge(); }
  if (v === 'me') renderMe();
}

$$('#kind-filter button').forEach(b => b.onclick = () => {
  kindFilter = b.dataset.kind; LS.set('kind', kindFilter);
  $$('#kind-filter button').forEach(x => x.classList.toggle('on', x === b));
  buildGenreBar(); buildDeck();
});
$('#btn-filters').onclick = () => {
  const on = $('#btn-filters').classList.toggle('on');
  $('#genre-bar').classList.toggle('hidden', !on);
};
function buildGenreBar() {
  const counts = {};
  for (const x of catalog) if (kindFilter === 'all' || x.kind === kindFilter) for (const g of x.genres || []) counts[g] = (counts[g] || 0) + 1;
  const top = Object.entries(counts).filter(([, c]) => c >= 8).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([g]) => g);
  const bar = $('#genre-bar'); bar.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'chip' + (genreFilter.size ? '' : ' on'); all.textContent = 'Any genre';
  all.onclick = () => { genreFilter.clear(); LS.set('genres', []); buildGenreBar(); buildDeck(); };
  bar.append(all);
  for (const g of top) {
    const c = document.createElement('button');
    c.className = 'chip' + (genreFilter.has(g) ? ' on' : ''); c.textContent = g;
    c.onclick = () => { genreFilter.has(g) ? genreFilter.delete(g) : genreFilter.add(g); LS.set('genres', [...genreFilter]); buildGenreBar(); buildDeck(); };
    bar.append(c);
  }
}

function eligible(x) {
  if (kindFilter !== 'all' && x.kind !== kindFilter) return false;
  if (genreFilter.size && !(x.genres || []).some(g => genreFilter.has(g))) return false;
  return !(x.id in mySwipes());
}
function buildDeck() {
  const rank = {}, n = { movie: 0, show: 0 }, total = { movie: 0, show: 0 };
  for (const x of catalog) total[x.kind]++;
  for (const x of catalog) rank[x.id] = n[x.kind]++ / total[x.kind];
  const pool = catalog.filter(eligible).map(x => ({ x, k: rank[x.id] + hash(room + x.id) * 0.45 })).sort((a, b) => a.k - b.k).map(o => o.x);
  // Weave in things your partner liked so matches come sooner.
  const theirs = theirSwipes();
  const liked = pool.filter(x => theirs[x.id] >= 1).sort((a, b) => theirs[b.id] - theirs[a.id]);
  const rest = pool.filter(x => !(theirs[x.id] >= 1));
  deck = [];
  while (liked.length || rest.length) {
    if (liked.length && (deck.length % 3 === 1 || !rest.length)) deck.push(liked.shift());
    else deck.push(rest.shift());
  }
  renderDeck();
}
function refillDeck() {
  // Keep current top card stable; just drop items swiped elsewhere.
  deck = deck.filter(eligible);
  if (deck.length < 5) buildDeck(); else renderDeck(true);
}

function cardEl(x) {
  const el = document.createElement('div');
  el.className = 'card'; el.dataset.id = x.id;
  if (x.poster) el.style.backgroundImage = `url("${x.poster}")`; else el.classList.add('noimg');
  const theirs = theirSwipes()[x.id];
  const tags = [
    `<span class="tag kind">${x.kind === 'movie' ? 'Movie' : 'Series'}</span>`,
    theirs === 2 ? `<span class="tag hot">★ ${esc(names()[other(me)])} super-liked this</span>` : '',
    x.rating ? `<span class="tag star">★ ${x.rating}</span>` : '',
    ...(x.genres || []).slice(0, 3).map(g => `<span class="tag">${esc(g)}</span>`),
    x.meta ? `<span class="tag">${esc(x.meta)}</span>` : '',
  ].join('');
  el.innerHTML = `<div class="shade"></div>
    <div class="stamp like">LIKE</div><div class="stamp nope">NOPE</div><div class="stamp super">MUST WATCH</div>
    <div class="info"><div class="title">${esc(x.title)} ${x.year ? `<small>${x.year}</small>` : ''}</div>
    <div class="tags">${tags}</div><div class="ov">${esc(x.overview || '')}</div></div>`;
  return el;
}
function renderDeck() {
  const d = $('#deck'); d.innerHTML = '';
  if (!deck.length) {
    d.innerHTML = `<div class="empty"><div class="big">🍿</div><b>You've seen everything here</b><span>Try another filter, or check your matches.</span></div>`;
    return;
  }
  const top3 = deck.slice(0, 3);
  [...top3].reverse().forEach((x, i, arr) => {
    const el = cardEl(x); const depth = arr.length - 1 - i;
    el.style.transform = `translateY(${depth * 10}px) scale(${1 - depth * 0.04})`;
    el.style.zIndex = 10 - depth;
    d.append(el);
    if (depth === 0) attachDrag(el, x);
  });
  // Preload next posters
  deck.slice(3, 8).forEach(x => { if (x.poster) new Image().src = x.poster; });
}

function attachDrag(el, x) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false, moved = false;
  const like = el.querySelector('.stamp.like'), nope = el.querySelector('.stamp.nope'), sup = el.querySelector('.stamp.super');
  el.onpointerdown = e => { dragging = true; moved = false; sx = e.clientX; sy = e.clientY; el.setPointerCapture(e.pointerId); el.classList.add('dragging'); };
  el.onpointermove = e => {
    if (!dragging) return;
    dx = e.clientX - sx; dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 14}deg)`;
    like.style.opacity = Math.max(0, Math.min(1, dx / 90));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    sup.style.opacity = Math.max(0, Math.min(1, (-dy - Math.abs(dx)) / 90));
  };
  el.onpointerup = el.onpointercancel = () => {
    if (!dragging) return; dragging = false; el.classList.remove('dragging');
    if (!moved) { openDetail(x); }
    else if (-dy > 120 && Math.abs(dx) < 110) return swipe(2);
    else if (dx > 100) return swipe(1);
    else if (dx < -100) return swipe(0);
    el.style.transform = ''; like.style.opacity = nope.style.opacity = sup.style.opacity = 0;
  };
}

function swipe(v) {
  const x = deck[0]; if (!x) return;
  const el = $(`#deck .card[data-id="${CSS.escape(x.id)}"]`);
  if (el) {
    el.classList.remove('dragging');
    el.querySelector(v === 2 ? '.stamp.super' : v ? '.stamp.like' : '.stamp.nope').style.opacity = 1;
    el.style.transform = v === 2 ? 'translateY(-130%) rotate(-4deg)' : `translateX(${v ? 140 : -140}%) rotate(${v ? 24 : -24}deg)`;
    el.style.opacity = 0.6;
  }
  deck.shift();
  undoStack.push({ id: x.id, v });
  if (undoStack.length > 30) undoStack.shift();
  const updates = { [`swipes/${me}/${x.id}`]: v };
  const willMatch = v >= 1 && (theirSwipes()[x.id] ?? 0) >= 1;
  if (willMatch) { updates[`matchedAt/${x.id}`] = Date.now(); knownMatches.add(x.id); saveSeen(); }
  store.write(updates);
  setTimeout(() => { renderDeck(); if (willMatch) celebrate(x); }, 260);
}
$('#act-like').onclick = () => swipe(1);
$('#act-nope').onclick = () => swipe(0);
$('#act-super').onclick = () => swipe(2);
$('#act-info').onclick = () => deck[0] && openDetail(deck[0]);
$('#act-undo').onclick = () => {
  const h = undoStack.pop(); if (!h) return toast('Nothing to undo');
  store.write({ [`swipes/${me}/${h.id}`]: null });
  if (byId[h.id]) { deck.unshift(byId[h.id]); renderDeck(); }
};
addEventListener('keydown', e => {
  if ($('#view-swipe').classList.contains('hidden') || $('#screen-main').classList.contains('hidden') || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') swipe(1); if (e.key === 'ArrowLeft') swipe(0); if (e.key === 'ArrowUp') swipe(2);
});

function celebrate(x) {
  $('#match-img').src = x.poster || '';
  $('#match-name').textContent = x.title;
  $('#match-sub').textContent = `You and ${names()[other(me)]} both want to watch this.`;
  $('#match-modal').classList.remove('hidden');
  renderMatchBadge();
  navigator.vibrate?.([30, 40, 60]);
}
$('#match-close').onclick = () => $('#match-modal').classList.add('hidden');
$('#match-see').onclick = () => { $('#match-modal').classList.add('hidden'); switchView('matches'); };

// ---------- Matches ----------
function saveSeen() { LS.set('seen:' + room, [...knownMatches]); }
function renderMatchBadge() {
  const fresh = matches().filter(id => !knownMatches.has(id) && !data.watched?.[id]).length;
  const b = $('#match-badge'); b.textContent = fresh; b.classList.toggle('hidden', !fresh);
}
$$('#match-filter button').forEach(b => b.onclick = () => {
  matchFilter = b.dataset.mf; $$('#match-filter button').forEach(x => x.classList.toggle('on', x === b)); renderMatches();
});
function renderMatches() {
  const g = $('#match-grid'); g.innerHTML = '';
  const list = matches().filter(id => !!data.watched?.[id] === (matchFilter === 'watched'))
    .sort((a, b) => (data.matchedAt?.[b] || 0) - (data.matchedAt?.[a] || 0));
  if (!list.length) {
    g.innerHTML = matchFilter === 'todo'
      ? `<div class="empty"><div class="big">💞</div><b>No matches yet</b><span>Keep swiping — when you both like something it shows up here.</span></div>`
      : `<div class="empty"><div class="big">🎬</div><b>Nothing watched yet</b><span>Mark matches as watched from their details.</span></div>`;
    return;
  }
  for (const id of list) {
    const x = byId[id]; const b = document.createElement('button');
    b.className = 'mcard'; if (x.poster) b.style.backgroundImage = `url("${x.poster}")`;
    const both2 = data.swipes.a[id] === 2 || data.swipes.b[id] === 2;
    b.innerHTML = `${both2 ? '<span class="sup">★</span>' : ''}<div class="mt">${esc(x.title)}</div>`;
    b.onclick = () => openDetail(x);
    g.append(b);
  }
}

// ---------- Details ----------
function openDetail(x) {
  $('#d-img').src = x.poster || ''; $('#d-title').textContent = x.title;
  $('#d-meta').textContent = [x.kind === 'movie' ? 'Movie' : 'Series', x.year, x.rating ? `★ ${x.rating}` : '', (x.genres || []).join(', '), x.meta].filter(Boolean).join(' · ');
  $('#d-overview').textContent = x.overview || 'No description available.';
  const n = names(), label = v => v == null ? 'hasn\'t swiped' : v === 2 ? 'super-liked ★' : v ? 'liked ♥' : 'passed';
  const mine = mySwipes()[x.id], theirs = theirSwipes()[x.id];
  $('#d-status').textContent = isMatch(x.id) ? `It's a match! ${data.watched?.[x.id] ? 'Watched ✓' : ''}` : `You ${label(mine).replace("hasn't", "haven't")}${mine != null ? '' : ' yet'}.`;
  const btns = $('#d-buttons'); btns.innerHTML = '';
  const add = (txt, fn, cls = '') => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = txt; b.onclick = fn; btns.append(b); };
  const link = (txt, href) => { const a = document.createElement('a'); a.className = 'btn'; a.textContent = txt; a.href = href; a.target = '_blank'; a.rel = 'noopener'; btns.append(a); };
  link('Where to watch', `https://www.justwatch.com/us/search?q=${encodeURIComponent(x.title)}`);
  link(x.link?.includes('imdb') ? 'IMDb' : 'More info', x.link || `https://www.google.com/search?q=${encodeURIComponent(x.title)}`);
  if (isMatch(x.id)) {
    const w = !!data.watched?.[x.id];
    add(w ? 'Move back to “To watch”' : 'Mark as watched ✓', () => { store.write({ [`watched/${x.id}`]: w ? null : Date.now() }); closeDetail(); }, 'primary');
    add('Unmatch', () => { if (confirm(`Remove “${x.title}” from your likes?`)) { store.write({ [`swipes/${me}/${x.id}`]: 0 }); closeDetail(); } });
  }
  $('#detail').classList.remove('hidden');
}
function closeDetail() { $('#detail').classList.add('hidden'); }
$('#detail-close').onclick = closeDetail;
$('#detail').onclick = e => { if (e.target.id === 'detail') closeDetail(); };

// ---------- Settings ----------
function renderMe() {
  const n = names();
  const mi = $('#my-name'), pi = $('#partner-name');
  if (document.activeElement !== mi) mi.value = data.names?.[me] || '';
  if (document.activeElement !== pi) pi.value = data.names?.[other(me)] || '';
  mi.placeholder = n[me]; pi.placeholder = n[other(me)];
  const cnt = s => Object.values(s).filter(v => v >= 1).length;
  $('#stats').innerHTML = `
    <div class="stat"><b>${cnt(mySwipes())}</b><span>You liked</span></div>
    <div class="stat"><b>${cnt(theirSwipes())}</b><span>${esc(n[other(me)])} liked</span></div>
    <div class="stat"><b>${matches().length}</b><span>Matches</span></div>`;
  $('#share-link').value = `${location.origin}${location.pathname}#room=${room}`;
  $('#mode-hint').textContent = store.mode === 'firebase'
    ? `Synced live ✓  ·  You are ${n[me]} on this device.`
    : `Local demo mode — add a Firebase config to sync between phones. You are ${n[me]}.`;
}
$('#my-name').onchange = e => store.write({ [`names/${me}`]: e.target.value.trim().slice(0, 20) || null });
$('#partner-name').onchange = e => store.write({ [`names/${other(me)}`]: e.target.value.trim().slice(0, 20) || null });
$('#btn-copy').onclick = async () => {
  const v = $('#share-link').value;
  try { if (navigator.share) await navigator.share({ title: 'Watch Match', text: 'Join me on Watch Match', url: v }); else { await navigator.clipboard.writeText(v); toast('Link copied'); } }
  catch { $('#share-link').select(); }
};
$('#btn-switch').onclick = () => { LS.del('me:' + room); me = null; showScreen('screen-who'); };
$('#btn-reset-mine').onclick = () => {
  if (!confirm('Delete all your swipes? Your partner\'s swipes stay.')) return;
  store.write({ [`swipes/${me}`]: null }); undoStack = []; setTimeout(buildDeck, 100); toast('Your swipes were reset');
};
$('#btn-leave').onclick = () => {
  if (!confirm('Leave this room on this device? (You can rejoin with the code.)')) return;
  LS.del('room'); LS.del('me:' + room); location.reload();
};

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

boot();
