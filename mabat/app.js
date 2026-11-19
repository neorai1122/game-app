/* מבט — טלפרומפטר מתחת לעדשה, צילום בקטעים וכתוביות צרובות.
   מעקב הקול עובד מתוך המיקרופון של ההקלטה עצמה: עוצמה, הברות ושתיקות.
   לכן הוא לא מתנגש בהקלטה, לא תלוי בשפה, ולא נתקע כשטועים. */
'use strict';

/* =========================================================
   כלים
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
const fmt1 = (t) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = (t % 60).toFixed(1); return m + ':' + s.padStart(4, '0'); };
const hasHeb = (s) => /[֐-׿]/.test(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };

function waitEvt(el, ev, ms = 5000) {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); el.removeEventListener(ev, done); res(); }
    el.addEventListener(ev, done, { once: true });
  });
}

let toastT;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.hidden = true; void el.offsetWidth;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms);
}

function armConfirm(btn, label, fn) {
  if (btn._armed) { clearTimeout(btn._armed); btn._armed = null; btn.classList.remove('armed'); fn(); return; }
  const l = btn.querySelector('span'); const prev = l ? l.textContent : '';
  btn.classList.add('armed'); if (l) l.textContent = label;
  haptic(12);
  btn._armed = setTimeout(() => { btn._armed = null; btn.classList.remove('armed'); if (l) l.textContent = prev; }, 3000);
}

const Wake = {
  lock: null,
  async on() { try { if ('wakeLock' in navigator && !this.lock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => (this.lock = null)); } } catch (_) {} },
  off() { try { this.lock && this.lock.release(); } catch (_) {} this.lock = null; },
};

/* הקשר שמע נפרד לכל תפקיד: מיקרופון בזמן צילום וייצוא. הניגון הרגיל עובר ישירות לרמקול */
function newAC() { return new (window.AudioContext || window.webkitAudioContext)(); }

/* =========================================================
   אחסון
   ========================================================= */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mabat.' + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('mabat.' + k, JSON.stringify(v)); } catch (_) {} },
};

const DB = {
  _p: null,
  open() {
    if (!this._p) this._p = new Promise((res, rej) => {
      const r = indexedDB.open('mabat', 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore('segs', { keyPath: 'id' }); s.createIndex('sid', 'sid'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async run(mode, fn) {
    try {
      const d = await this.open();
      return await new Promise((res, rej) => {
        const t = d.transaction('segs', mode); const req = fn(t.objectStore('segs'));
        t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error);
      });
    } catch (e) { console.warn('IDB', e); return undefined; }
  },
  put(o) { return this.run('readwrite', (s) => s.put(o)); },
  del(id) { return this.run('readwrite', (s) => s.delete(id)); },
  async bySid(sid) { const a = (await this.run('readonly', (s) => s.index('sid').getAll(sid))) || []; return a.sort((x, y) => x.n - y.n); },
  async all() { return (await this.run('readonly', (s) => s.getAll())) || []; },
  async delSid(sid) { const a = await this.bySid(sid); for (const x of a) await this.del(x.id); },
};

const DEFAULTS = { rate: 5.0, handle: '', accent: '#ffd60a', quality: 1080, wpm: 140, pace: 1, fontSize: 22, mode: 'voice', timer: 3, maxDur: 60, eye: true, style: 'classic', pos: 72 };
const settings = Object.assign({}, DEFAULTS, LS.get('settings2', {}));
const saveSettings = () => LS.set('settings2', settings);
const ACCENTS = ['#ffd60a', '#30d158', '#0a84ff', '#ff375f', '#ffffff'];

let scripts = LS.get('scripts', null);
if (!scripts) {
  scripts = [{
    id: uid(), example: true, updated: Date.now(),
    title: 'ההוק הראשון',
    text: 'רוב האנשים מצלמים עם טלפון שני ליד המצלמה, וכולם רואים את העיניים בורחות. /\nפה הטקסט יושב בדיוק *מתחת לעדשה*. /\nאתם מדברים, והוא זז איתכם. עוצרים, והוא מחכה. /\nוכשסיימתם? *הכתוביות כבר מוכנות.*',
  }];
  LS.set('scripts', scripts);
}
const saveScripts = () => LS.set('scripts', scripts);
const scriptById = (id) => scripts.find((s) => s.id === id);

/* =========================================================
   ניתוח תסריט
   ========================================================= */
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
function normWord(s) {
  return s.replace(/[֑-ׇ]/g, '').replace(/[^א-תa-zA-Z0-9]/g, '').replace(/[ךםןףץ]/g, (c) => FINALS[c]).toLowerCase();
}
function parseScript(text) {
  const words = []; let emph = false;
  for (const para of String(text || '').split(/\n+/)) {
    for (let tok of para.split(/\s+/).filter(Boolean)) {
      if (/^\/+$/.test(tok)) { if (words.length) words[words.length - 1].brk = true; continue; }
      if (/^\*+$/.test(tok)) { emph = !emph; continue; }
      let brk = false;
      if (/\/+$/.test(tok)) { brk = true; tok = tok.replace(/\/+$/, ''); }
      if (tok.startsWith('*')) { emph = true; tok = tok.replace(/^\*+/, ''); }
      let closes = false;
      if (/\*+[.,!?:;…"'״]*$/.test(tok)) { closes = true; tok = tok.replace(/\*+(?=[.,!?:;…"'״]*$)/, ''); }
      tok = tok.replace(/\*/g, '');
      if (tok) words.push({ text: tok, emph, brk, end: /[.!?…]["'״]?$/.test(tok), norm: normWord(tok) });
      if (closes) emph = false;
    }
    if (words.length) words[words.length - 1].brk = true;
  }
  return words;
}
/* הערכת הברות למילה עברית בלי ניקוד: בערך הברה לכל שתי אותיות */
function sylOf(w) {
  const n = w.norm || '';
  if (!n) return 0.6;
  if (/\d/.test(n)) return n.length * 1.4;
  return Math.max(1, n.length * 0.5);
}
const isPhraseEnd = (w) => !!(w && (w.brk || w.end));
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const st = (x) => (x.length > 2 && 'ובהלשמכ'.includes(x[0]) ? x.slice(1) : x);
  if (st(a) === b || a === st(b) || st(a) === st(b)) return true;
  const m = Math.min(a.length, b.length);
  if (m >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (m >= 4 && lev(a, b) <= (m >= 7 ? 2 : 1)) return true;
  return false;
}

/* =========================================================
   ניווט
   ========================================================= */
let current = 'home';
const leaveHooks = {};
function show(name, push = true) {
  if (leaveHooks[current] && current !== name) leaveHooks[current]();
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  current = name;
  if (push && name !== 'home') history.pushState({ s: name }, '');
}
window.addEventListener('popstate', () => {
  if (!$('#settings').hidden) { $('#settings').hidden = true; return; }
  if (current === 'review') Review.back(); else if (current !== 'home') goHome();
});
function goHome() { show('home', false); Home.render(); }
$$('[data-back]').forEach((b) => b.addEventListener('click', () => (history.state ? history.back() : goHome())));

/* =========================================================
   בית
   ========================================================= */
const CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
const Home = {
  async render() {
    const segs = await DB.all();
    const by = {};
    segs.forEach((s) => { (by[s.sid] = by[s.sid] || { n: 0, d: 0 }); by[s.sid].n++; by[s.sid].d += s.dur; });
    scripts.sort((a, b) => b.updated - a.updated);
    $('#count-scripts').textContent = scripts.length || '';
    const ul = $('#scripts');
    if (!scripts.length) { ul.innerHTML = '<li class="empty">עוד אין תסריטים</li>'; return; }
    ul.innerHTML = scripts.map((s) => {
      const d = by[s.id];
      const first = (s.text || '').replace(/[*/]/g, '').split('\n').find((l) => l.trim()) || 'תסריט ריק';
      const tag = d ? `<span class="tag draft">טיוטה ${fmt(d.d)}</span>` : s.example ? '<span class="tag ex">דוגמה</span>' : '';
      return `<li><button class="script" data-id="${s.id}"><span class="t">${esc(s.title || 'ללא כותרת')}</span><span class="s">${esc(first)}</span>${tag}${CHEV}</button></li>`;
    }).join('');
  },
};
$('#scripts').addEventListener('click', (e) => { const b = e.target.closest('.script'); if (b) Editor.open(b.dataset.id); });
$('#btn-new').addEventListener('click', () => {
  const s = { id: uid(), title: '', text: '', updated: Date.now() };
  scripts.unshift(s); saveScripts(); Editor.open(s.id, true);
});
$('#btn-import').addEventListener('click', () => Import.open());

/* =========================================================
   עורך
   ========================================================= */
const Editor = {
  id: null,
  async open(id, fresh) {
    this.id = id; const s = scriptById(id);
    $('#ed-title').value = s.title || '';
    $('#ed-text').value = s.text || '';
    show('editor'); this.stats();
    const segs = await DB.bySid(id);
    const d = segs.reduce((a, x) => a + x.dur, 0);
    $('#ed-draft').textContent = segs.length ? 'טיוטה ' + fmt(d) : '';
    if (fresh) setTimeout(() => $('#ed-text').focus(), 150);
  },
  save() {
    const s = scriptById(this.id); if (!s) return;
    const t = $('#ed-title').value.trim(), x = $('#ed-text').value;
    if (t !== s.title || x !== s.text) { s.title = t; s.text = x; s.updated = Date.now(); s.example = false; saveScripts(); }
  },
  stats() {
    const w = parseScript($('#ed-text').value);
    const sec = (w.length / 140) * 60;
    $('#ed-stats').textContent = w.length ? `${w.length} מילים · ${sec < 60 ? Math.round(sec) + ' שנ׳' : fmt(sec)}` : '';
    const warns = []; let cur = [];
    w.forEach((x) => { cur.push(x); if (isPhraseEnd(x)) { if (cur.length > 20) warns.push(cur); cur = []; } });
    $('#ed-warn').innerHTML = warns.slice(0, 2).map((c) => `<li>המשפט ״${esc(c.slice(0, 3).map((x) => x.text).join(' '))}…״ ארוך לנשימה אחת. כדאי לפצל אותו.</li>`).join('');
    $('#ed-shoot').disabled = !w.length;
  },
};
let edT;
$('#ed-text').addEventListener('input', () => { clearTimeout(edT); edT = setTimeout(() => { Editor.save(); Editor.stats(); }, 250); });
$('#ed-title').addEventListener('input', () => Editor.save());
$('#ed-emph').addEventListener('click', () => {
  const ta = $('#ed-text'); let a = ta.selectionStart, b = ta.selectionEnd; const v = ta.value;
  if (a === b) { while (a > 0 && !/\s/.test(v[a - 1])) a--; while (b < v.length && !/\s/.test(v[b])) b++; }
  if (a === b) return;
  ta.value = v.slice(0, a) + '*' + v.slice(a, b) + '*' + v.slice(b);
  ta.focus(); ta.setSelectionRange(b + 2, b + 2); Editor.save(); Editor.stats(); haptic();
});
$('#ed-pause').addEventListener('click', () => {
  const ta = $('#ed-text'); const a = ta.selectionStart; const v = ta.value;
  ta.value = v.slice(0, a) + ' / ' + v.slice(a); ta.focus(); ta.setSelectionRange(a + 3, a + 3); Editor.save(); Editor.stats(); haptic();
});
$('#ed-shoot').addEventListener('click', () => { Editor.save(); Shoot.open(Editor.id); });
$('#ed-delete').addEventListener('click', (e) => armConfirm(e.currentTarget, 'למחוק?', async () => {
  scripts = scripts.filter((s) => s.id !== Editor.id); saveScripts(); await DB.delSid(Editor.id); goHome();
}));
leaveHooks.editor = () => { clearTimeout(edT); Editor.save(); };

/* =========================================================
   מעקב קולי
   ========================================================= */
const Pacer = {
  ac: null, an: null, src: null, buf: null, hist: null,
  attach(stream) {
    this.detach();
    if (!stream || !stream.getAudioTracks().length) return false;
    try {
      this.ac = newAC();
      this.src = this.ac.createMediaStreamSource(stream);
      this.an = this.ac.createAnalyser(); this.an.fftSize = 512; this.an.smoothingTimeConstant = 0;
      this.src.connect(this.an);
      this.buf = new Float32Array(this.an.fftSize);
    } catch (e) { console.warn(e); return false; }
    this.reset(); this.wake();
    return true;
  },
  wake() { try { if (this.ac && this.ac.state !== 'running') this.ac.resume().catch(() => {}); } catch (_) {} },
  reset() { this.hist = new Float32Array(180); this.hi = 0; this.n = 0; this.floor = -60; this.level = 0; this.voiced = false; this.hang = 0; },
  detach() {
    try { this.src && this.src.disconnect(); } catch (_) {}
    try { this.ac && this.ac.close(); } catch (_) {}
    this.ac = null; this.src = null; this.an = null;
  },
  /* קריאה בכל פריים: האם מדברים עכשיו, ורמת עוצמה 0..1 */
  read(now, dt) {
    if (!this.an) return null;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0; const b = this.buf; for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    const db = 10 * Math.log10(s / b.length + 1e-10);
    if (this.n === 0) this.hist.fill(db);
    // רצפת הרעש היא אחוזון נמוך של שלוש השניות האחרונות, כך שדיבור ארוך לא מרים אותה
    this.hist[(this.hi = (this.hi + 1) % this.hist.length)] = db; this.n++;
    if (this.n % 6 === 1) { const a = Array.from(this.hist).sort((x, y) => x - y); this.floor = clamp(a[Math.floor(a.length * 0.12)], -90, -35); }
    const above = db - this.floor;
    this.level += (clamp(above / 28, 0, 1) - this.level) * 0.5;
    if (above > 9) { this.voiced = true; this.hang = 0.18; }
    else if (above < 6) { this.hang -= dt; if (this.hang <= 0) this.voiced = false; }
    return { voiced: this.voiced, level: this.level };
  },
};

/* =========================================================
   צילום
   ========================================================= */
function pickMime(kind) {
  if (!window.MediaRecorder) return '';
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (kind === 'export') list.unshift('video/mp4;codecs=avc1.640028,mp4a.40.2');
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}
const MODE_L = { voice: 'קול', auto: 'קבוע', manual: 'ידני' };
const MODE_T = { voice: 'הטקסט עוקב אחרי הקול', auto: 'גלילה בקצב קבוע', manual: 'הקישו על הטקסט כדי להתקדם' };

const Shoot = {
  sid: null, W: [], p: 0, segs: [], stream: null, facing: 'user', mode: 'record',
  rec: null, recording: false, rehearsing: false, segStart: 0, chunks: [], stamps: {}, minP: 0,
  lines: [], lineOf: [], spans: [], lineEls: [], loopOn: false,
  f: { prog: 0, gate: false, over: 0, sil: 0, snapped: false, autoAcc: 0, rate: 5.6, phraseVT: 0, phraseSyl: 1 },
  asr: null, asrOff: false,
  lastAdvance: 0, lastCapKey: '',

  get running() { return this.recording || this.rehearsing; },

  async open(sid) {
    this.sid = sid;
    this.W = parseScript(scriptById(sid).text);
    this.segs = await DB.bySid(sid);
    this.p = this.segs.length ? this.segs[this.segs.length - 1].w1 : 0;
    this.skipEmpty();
    show('shoot');
    document.documentElement.style.setProperty('--accent', settings.accent);
    this.setMode('record');
    this.applyRail();
    this.layout();
    this.renderSegs();
    await this.startCam();
    Wake.on();
    if (settings.eye) Eye.load();
    this.startLoop();
    if (this.segs.length) toast(`ממשיכים מהטיוטה · ${fmt(this.total())}`);
  },

  async startCam() {
    this.stopCam();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      const v = $('#cam'); v.srcObject = this.stream; v.classList.toggle('mirror', this.facing === 'user');
      await v.play().catch(() => {});
      Pacer.attach(this.stream);
      this.hint('', false);
    } catch (e) {
      console.warn(e);
      this.hint('אין גישה למצלמה או למיקרופון. אפשרו אותם בהגדרות הדפדפן.', true);
    }
  },
  stopCam() { Pacer.detach(); if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; },

  /* ---------- פרומפטר ---------- */
  layout() {
    const fs = settings.fontSize; const lh = Math.round(fs * 1.55);
    const pr = $('#prompter'); pr.style.setProperty('--pfs', fs + 'px'); pr.style.setProperty('--plh', lh + 'px');
    const win = $('#pwin'); const maxW = win.clientWidth - 8;
    // מדידה בדיוק באותו פונט שמוצג על המסך
    const meas = document.createElement('div'); meas.className = 'pl'; meas.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;width:auto';
    meas.innerHTML = this.W.map((w) => `<span class="pw${w.brk ? ' brk' : ''}">${esc(w.text)}</span>`).join(' ') + '<span class="msp">&nbsp;</span>';
    win.appendChild(meas);
    const widths = $$('.pw', meas).map((e) => e.getBoundingClientRect().width);
    const sp = meas.querySelector('.msp').getBoundingClientRect().width;
    win.removeChild(meas);
    const lines = []; let line = [], lw = 0;
    this.W.forEach((w, i) => {
      const ww = widths[i];
      if (line.length && lw + sp + ww > maxW) { lines.push(line); line = []; lw = 0; }
      line.push(i); lw += (line.length > 1 ? sp : 0) + ww;
      if (isPhraseEnd(w)) { lines.push(line); line = []; lw = 0; }
    });
    if (line.length) lines.push(line);
    this.lines = lines; this.lineOf = [];
    lines.forEach((l, li) => l.forEach((i) => (this.lineOf[i] = li)));
    $('#ptrack').innerHTML = lines.map((l) => '<div class="pl">' + l.map((i) => {
      const w = this.W[i];
      return `<span class="pw${w.emph ? ' emph' : ''}${w.brk ? ' brk' : ''}" data-i="${i}">${esc(w.text)}</span>`;
    }).join(' ') + '</div>').join('') + '<div class="pl"></div><div class="pl"></div>';
    this.spans = $$('#ptrack .pw'); this.lineEls = $$('#ptrack .pl');
    this.lh = lh; this.painted = -1; this.paint();
    this.sizeCap();
  },
  curLine() { return this.p >= this.W.length ? this.lines.length : this.lineOf[this.p]; },
  paint() {
    const p = this.p;
    if (this.painted === p) return;
    const a = Math.min(p, this.painted < 0 ? 0 : this.painted), b = Math.max(p, this.painted < 0 ? this.W.length : this.painted);
    for (let i = Math.max(0, a - 1); i <= Math.min(this.W.length - 1, b + 1); i++) {
      const el = this.spans[i]; el.classList.toggle('said', i < p); el.classList.toggle('now', i === p); if (i !== p) el.style.removeProperty('--pg');
    }
    this.painted = p;
    const li = this.curLine();
    this.lineEls.forEach((el, k) => el.classList.toggle('cur', k === li));
    $('#ptrack').style.transform = `translateY(${(1 - li) * this.lh}px)`;
  },
  skipEmpty() { while (this.p < this.W.length && !this.W[this.p].norm) this.p++; },
  setPointer(p, fromUser) {
    const prev = this.p;
    this.p = clamp(p, 0, this.W.length); this.skipEmpty();
    if (this.recording) {
      this.minP = Math.min(this.minP, this.p);
      if (fromUser && this.p < prev) for (let i = this.p; i < prev; i++) delete this.stamps[i];
    }
    if (fromUser) { this.f.prog = 0; this.f.gate = false; this.f.over = 0; this.newPhrase(); }
    this.lastAdvance = performance.now();
    this.paint();
  },
  segTime() { return Math.max(0, (performance.now() - this.segStart) / 1000); },
  stampCurrent(back = 0) { if (this.recording && this.p < this.W.length && this.stamps[this.p] == null) this.stamps[this.p] = Math.max(0, this.segTime() - back); },

  /* ---------- מנוע המעקב ---------- */
  follow(dt, a) {
    const f = this.f, W = this.W;
    if (this.p >= W.length) return;
    if (settings.mode === 'auto') {
      f.autoAcc += dt; this.stampCurrent();
      const w = W[this.p]; const base = 60 / settings.wpm;
      let d = base * (0.55 + 0.45 * Math.min(2, (w.norm.length || 2) / 4));
      if (w.brk) d += 0.5; else if (w.end) d += 0.3; else if (/,$/.test(w.text)) d += 0.15;
      if (f.autoAcc >= d) { f.autoAcc -= d; this.setPointer(this.p + 1); }
      return;
    }
    if (settings.mode !== 'voice' || !a) return;
    const rate = f.rate * settings.pace;
    if (a.voiced) {
      f.sil = 0; f.snapped = false; f.phraseVT += dt;
      const inc = dt * rate;
      if (f.gate) {
        // הטקסט הגיע לסוף המשפט לפניכם: מחכים לנשימה. אם ממשיכים לדבר בלי עצירה, משחררים
        f.over += dt;
        if (f.over >= clamp(0.5 * f.gateVT, 0.9, 3.2)) { f.gate = false; f.prog = Math.min(3, f.over * rate * 0.5); f.over = 0; this.newPhrase(); this.stampCurrent(f.prog / rate); }
      } else { this.stampCurrent(); f.prog += inc; }
      while (!f.gate && this.p < W.length && f.prog >= sylOf(W[this.p])) {
        f.prog -= sylOf(W[this.p]); const w = W[this.p];
        this.setPointer(this.p + 1);
        if (isPhraseEnd(w)) { f.gate = true; f.over = 0; f.gateVT = f.phraseVT; f.prog = 0; }
        else this.stampCurrent(f.prog / rate);
      }
    } else {
      f.sil += dt;
      if (f.gate && f.sil > 0.14) { this.learn(); f.gate = false; f.over = 0; f.prog = 0; this.newPhrase(); }
      if (!f.gate && !f.snapped && f.sil > 0.42) {
        f.snapped = true;
        let k = this.p, rem = -f.prog; for (; k < W.length; k++) { rem += sylOf(W[k]); if (isPhraseEnd(W[k])) break; }
        const ratio = f.phraseVT > 0.3 ? f.phraseSyl / f.phraseVT / f.rate : 99;
        const [lo, hi] = f.cal < 2 ? [0.55, 2.0] : [0.72, 1.45];
        // עצרתם, ולפי הזמן שדיברתם סביר שסיימתם את המשפט: הטקסט מדלג לסופו ולומד את הקצב שלכם
        if (k < W.length && ((rem <= 2.5 && ratio < 2.2) || (ratio >= lo && ratio <= hi && rem <= f.phraseSyl * 0.7))) {
          const t = this.recording ? this.segTime() - f.sil : 0;
          for (let i = this.p; i <= k; i++) if (this.recording && this.stamps[i] == null) this.stamps[i] = Math.max(0, t - 0.14 * (k - i + 1));
          if (ratio >= lo && ratio <= hi) this.learn();
          this.setPointer(k + 1); f.prog = 0; this.newPhrase();
        }
      }
    }
    this.progBar();
  },
  newPhrase() {
    const f = this.f; f.phraseVT = 0; let s = 0;
    for (let k = this.p; k < this.W.length; k++) { s += sylOf(this.W[k]); if (isPhraseEnd(this.W[k])) break; }
    f.phraseSyl = Math.max(1, s);
  },
  learn() {
    const f = this.f; if (f.phraseVT < 0.5) return;
    const implied = f.phraseSyl / f.phraseVT; if (implied < 3 || implied > 11) return;
    f.rate = clamp(f.rate * 0.4 + implied * 0.6, 3.5, 9.5); f.cal = (f.cal || 0) + 1;
    settings.rate = +f.rate.toFixed(2); saveSettings();
  },
  progBar() {
    const el = this.spans[this.p]; if (!el) return;
    const w = this.W[this.p]; const v = this.f.gate ? 0 : clamp(this.f.prog / sylOf(w), 0, 1);
    el.style.setProperty('--pg', v.toFixed(2));
  },

  /* ---------- זיהוי מילים על אותו ערוץ שמע של ההקלטה (Chrome חדש) ---------- */
  matchFrom(start, toks) {
    let p = start; const W = this.W;
    for (const tk of toks) {
      const n = normWord(tk); if (!n) continue;
      const lim = Math.min(W.length, p + 6);
      for (let j = p; j < lim; j++) {
        const wn = W[j].norm; if (!wn) continue;
        if ((n.length <= 2 || wn.length <= 2) && j > p + 1) continue;
        if (similar(n, wn)) { p = j + 1; break; }
      }
    }
    return p;
  },
  startASR() {
    const SRC = window.SpeechRecognition;
    if (this.asrOff || !SRC || typeof SRC.available !== 'function' || !this.stream) return;
    const track = this.stream.getAudioTracks()[0]; if (!track) return;
    const st = { active: true, base: [], off: 0, r: new SRC() };
    const r = st.r; r.lang = 'he-IL'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const key = st.off + i; if (st.base[key] == null) st.base[key] = Math.max(0, this.p - 3);
        const np = this.matchFrom(st.base[key], e.results[i][0].transcript.split(/\s+/));
        if (np > this.p && np - this.p <= 10) this.asrJump(np);
      }
    };
    r.onerror = (ev) => { if (['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture', 'network'].includes(ev.error)) { st.active = false; this.asrOff = true; } };
    r.onend = () => { if (st.active && this.running) { st.off += 1000; setTimeout(() => { if (st.active && this.running) try { r.start(track); } catch (_) {} }, 60); } };
    try { r.start(track); } catch (e) { this.asrOff = true; return; }
    this.asr = st;
  },
  stopASR() { if (this.asr) { this.asr.active = false; try { this.asr.r.abort(); } catch (_) {} this.asr = null; } },
  asrJump(np) {
    const from = this.p; const t = this.recording ? this.segTime() : 0;
    let crossed = false;
    for (let i = from; i < np; i++) { if (isPhraseEnd(this.W[i])) crossed = true; if (this.recording && this.stamps[i] == null) this.stamps[i] = Math.max(0, t - 0.28 * (np - i)); }
    this.f.rate = clamp(this.f.rate * 1.04, 3.5, 8.5);
    this.setPointer(np); this.f.prog = 0; this.f.gate = false; this.f.over = 0;
    if (crossed) this.newPhrase();
  },

  /* ---------- כתוביות חיות בזמן הצילום ---------- */
  sizeCap() {
    const cv = $('#live-cap'); const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr); this.lastCapKey = '';
  },
  drawCap(now) {
    const cv = $('#live-cap'); const ctx = cv.getContext('2d');
    // בזמן דיבור מודגשת המילה שנאמרת עכשיו; בשתיקה, האחרונה שנאמרה
    const q = Pacer.voiced && !this.f.gate && this.p < this.W.length ? this.p : this.p - 1;
    const show = this.running && q >= 0 && (Pacer.voiced || now - this.lastAdvance < 1400);
    const age = (now - this.lastAdvance) / 1000;
    const key = show ? q + ':' + settings.style + ':' + (age < 0.2 ? Math.round(age * 60) : 'x') : 'none';
    if (key === this.lastCapKey) return;
    this.lastCapKey = key;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!show) return;
    const st = STYLES[settings.style]; const W = this.W;
    let ps = q; while (ps > 0 && !isPhraseEnd(W[ps - 1])) ps--;
    const g0 = ps + Math.floor((q - ps) / st.max) * st.max;
    const items = [];
    for (let i = g0; i < Math.min(W.length, g0 + st.max); i++) {
      if (i > g0 && isPhraseEnd(W[i - 1])) break;
      items.push({ text: W[i].text, emph: W[i].emph, active: i === q, age, future: i > q });
    }
    drawGroup(ctx, cv.width, cv.height, items, settings.style, cv.height * (settings.pos / 100), settings.accent, 1, cv.width / 1080);
  },

  /* ---------- הקלטה ---------- */
  total() { return this.segs.reduce((a, s) => a + s.dur, 0); },
  canStart() {
    if (!this.stream) { toast('המצלמה עוד לא פעילה'); return false; }
    if (this.mode === 'record' && this.total() >= settings.maxDur - 0.3) { toast('הגעתם לאורך המקסימלי'); return false; }
    if (this.p >= this.W.length && this.W.length) { toast('הגעתם לסוף התסריט. גררו את הטקסט כדי לחזור.'); return false; }
    return true;
  },
  async countdown() {
    const n = settings.timer; if (!n) return true;
    this.counting = true; const el = $('#countdown'); el.hidden = false;
    for (let i = n; i > 0 && this.counting; i--) { el.textContent = i; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); haptic(6); await new Promise((r) => setTimeout(r, 900)); }
    el.hidden = true; const ok = this.counting; this.counting = false; return ok;
  },
  startRun() {
    this.f = { prog: 0, gate: false, over: 0, sil: 0, snapped: false, autoAcc: 0, rate: settings.rate || 5.0, phraseVT: 0, phraseSyl: 1, cal: 0 };
    this.newPhrase();
    this.runStart = performance.now(); this.runW0 = this.p;
    Pacer.wake();
    if (settings.mode === 'voice') this.startASR();
    $('#s-shoot').classList.add('rec');
    haptic(14);
  },
  startSeg() {
    if (!this.canStart()) return false;
    const mime = pickMime('rec');
    try { this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 10e6, audioBitsPerSecond: 160000 } : undefined); }
    catch (e) { toast('ההקלטה לא נתמכת בדפדפן הזה'); return false; }
    this.chunks = []; this.mime = this.rec.mimeType || mime || 'video/webm';
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.segStart = performance.now();
    this.rec.onstart = () => { this.segStart = performance.now(); };
    this.rec.start(250);
    this.recording = true; this.stamps = {}; this.minP = this.p; this.segW0 = this.p;
    this.eyeAcc = { sum: 0, n: 0 };
    this.disarm(); $('#sh-del').disabled = true; $('#sh-done').disabled = true;
    this.startRun();
    return true;
  },
  stopSeg() {
    if (!this.recording) return Promise.resolve();
    const dur = this.segTime();
    this.recording = false; this.stopASR();
    $('#s-shoot').classList.remove('rec'); haptic(10);
    const rec = this.rec; const w0 = Math.min(this.minP, this.segW0), w1 = this.p, eye = this.eyeAcc, stamps = this.stamps, mirror = this.facing === 'user';
    const saved = new Promise((resolve) => {
      rec.onstop = async () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        if (dur < 0.5) { toast('הקטע קצר מדי ולא נשמר'); this.setPointer(w0); this.renderSegs(); return resolve(); }
        const seg = { id: uid(), sid: this.sid, n: this.segs.length ? this.segs[this.segs.length - 1].n + 1 : 0, blob, dur, w0, w1, stamps, mirror, mime: this.mime, eye: eye.n ? Math.round(eye.sum / eye.n) : null };
        this.segs.push(seg); this.renderSegs(); await DB.put(seg); resolve();
      };
    });
    try { rec.stop(); } catch (_) {}
    $('#seg-live').style.width = '0';
    return saved;
  },
  startRehearse() { if (!this.canStart()) return; this.rehearsing = true; this.startRun(); },
  stopRehearse() {
    this.rehearsing = false; this.stopASR(); $('#s-shoot').classList.remove('rec');
    const min = (performance.now() - this.runStart) / 60000; const n = this.p - this.runW0;
    if (n > 4 && min > 0.05) {
      const wpm = Math.round(n / min);
      toast(`${wpm} מילים לדקה · ${wpm > 175 ? 'מהיר. נשמו בין המשפטים.' : wpm < 110 ? 'רגוע. אפשר להאיץ.' : 'קצב מצוין לרילס.'}`, 3600);
    }
  },
  renderSegs() {
    const max = settings.maxDur; const bar = $('#segbar');
    $$('.seg', bar).forEach((e) => e.remove());
    const live = $('#seg-live');
    this.segs.forEach((s) => { const d = document.createElement('div'); d.className = 'seg'; d.style.width = (s.dur / max) * 100 + '%'; bar.insertBefore(d, live); });
    $('#sh-del').disabled = !this.segs.length || this.recording;
    $('#sh-done').disabled = !this.segs.length || this.recording;
    this.progress(0);
  },
  progress(live) {
    const t = this.total() + live;
    $('#timecode').textContent = fmt(t) + (this.recording || this.segs.length ? '' : ' / ' + fmt(settings.maxDur));
    $('#ring-prog').style.strokeDashoffset = 289 * (1 - clamp(t / settings.maxDur, 0, 1));
  },
  disarm() { const b = $('#sh-del'); if (b._armed) { clearTimeout(b._armed); b._armed = null; } b.classList.remove('armed'); $$('.seg').forEach((e) => e.classList.remove('armed')); },
  delLast() {
    if (!this.segs.length || this.recording) return;
    const b = $('#sh-del');
    if (!b._armed) {
      b.classList.add('armed'); haptic(12);
      const segs = $$('.seg'); segs[segs.length - 1] && segs[segs.length - 1].classList.add('armed');
      b._armed = setTimeout(() => this.disarm(), 3000);
      toast('הקשה נוספת מוחקת את הקטע האחרון');
      return;
    }
    this.disarm();
    const s = this.segs.pop(); DB.del(s.id);
    this.setPointer(s.w0, true); this.renderSegs(); haptic(18);
    toast('הקטע נמחק');
  },

  /* ---------- לולאה ראשית ---------- */
  startLoop() {
    if (this.loopOn) return; this.loopOn = true;
    let last = performance.now(), lastEye = 0, lastLight = 0;
    const lc = document.createElement('canvas'); lc.width = 32; lc.height = 18; const lctx = lc.getContext('2d', { willReadFrequently: true });
    const bars = $$('#meter i'); const meter = $('#meter');
    const tick = (nowMs) => {
      if (current !== 'shoot') { this.loopOn = false; return; }
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (nowMs - last) / 1000); last = nowMs;
      const a = Pacer.read(nowMs / 1000, dt);
      if (a) {
        meter.classList.toggle('on', a.voiced);
        bars.forEach((b, i) => (b.style.height = 3 + a.level * [7, 11, 9, 6][i] + 'px'));
      }
      if (this.running) this.follow(dt, a);
      if (this.recording) {
        const live = this.segTime();
        $('#seg-live').style.width = (live / settings.maxDur) * 100 + '%';
        this.progress(live);
        if (this.total() + live >= settings.maxDur) { this.stopSeg(); toast('הגעתם לאורך המקסימלי'); }
      }
      this.drawCap(nowMs);
      const v = $('#cam');
      if (settings.eye && Eye.lm && nowMs - lastEye > 140) {
        lastEye = nowMs; Eye.sample(v);
        const chip = $('#eye-chip'); chip.hidden = false;
        if (Eye.score == null) { chip.querySelector('b').textContent = 'מחפש פנים'; chip.className = 'chip mid'; }
        else {
          chip.querySelector('b').textContent = 'קשר עין ' + Eye.score + '%';
          chip.className = 'chip' + (Eye.score < 60 ? ' bad' : Eye.score < 80 ? ' mid' : '');
          if (this.recording) { this.eyeAcc.sum += Eye.score; this.eyeAcc.n++; }
        }
      } else if (!settings.eye) $('#eye-chip').hidden = true;
      if (!this.running && nowMs - lastLight > 800 && v.readyState >= 2 && this.stream) {
        lastLight = nowMs;
        try {
          lctx.drawImage(v, 0, 0, 32, 18); const d = lctx.getImageData(8, 3, 16, 12).data; let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          const luma = sum / (d.length / 4);
          let msg = '';
          if (luma < 45) msg = 'חשוך. פנו לחלון או למנורה';
          else if (settings.eye && Eye.lm && !Eye.face) msg = 'לא רואים את הפנים';
          else if (settings.eye && Eye.nose && (Eye.nose.x < 0.3 || Eye.nose.x > 0.7)) msg = 'זוזו קצת למרכז';
          this.hint(msg);
        } catch (_) {}
      } else if (this.running && !this._sticky) this.hint('');
    };
    requestAnimationFrame(tick);
  },
  hint(msg, sticky) { if (sticky !== undefined) this._sticky = sticky ? msg : ''; const m = this._sticky || msg; const h = $('#hint-chip'); if (h.textContent !== m) h.textContent = m; h.hidden = !m; },

  setMode(m) {
    if (this.running) return;
    this.mode = m;
    $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    $('#s-shoot').classList.toggle('rehearse', m === 'rehearse');
  },
  applyRail() {
    $('#sh-mode-l').textContent = MODE_L[settings.mode];
    $('#sh-size-l').textContent = settings.fontSize;
    $('#sh-timer-l').textContent = settings.timer ? settings.timer + ' שנ׳' : 'כבוי';
    $('#sh-len-l').textContent = settings.maxDur >= 60 ? settings.maxDur / 60 + ' דק׳' : settings.maxDur + ' שנ׳';
    $('#sh-eye').classList.toggle('on', settings.eye);
    saveSettings();
  },
  leave() {
    this.counting = false;
    if (this.recording) this.stopSeg();
    if (this.rehearsing) this.stopRehearse();
    this.stopCam(); Wake.off();
    $('#cam').srcObject = null;
    const cv = $('#live-cap'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  },
};
leaveHooks.shoot = () => Shoot.leave();

/* כפתור הצילום: הקשה מתחילה ועוצרת, לחיצה ארוכה מצלמת כל עוד מחזיקים */
(() => {
  const btn = $('#sh-rec'); let downAt = 0, startedHere = false, pendingTap = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault(); downAt = performance.now(); startedHere = false; pendingTap = false;
    const S = Shoot; Pacer.wake();
    if (S.counting) { S.counting = false; return; }
    if (S.mode === 'rehearse') { S.rehearsing ? S.stopRehearse() : S.startRehearse(); return; }
    if (S.recording) { S.stopSeg(); return; }
    if (settings.timer) { pendingTap = true; return; }
    startedHere = S.startSeg();
  });
  const up = async () => {
    const held = performance.now() - downAt;
    if (startedHere && held > 450 && Shoot.recording) { Shoot.stopSeg(); startedHere = false; return; }
    if (pendingTap) { pendingTap = false; if (!Shoot.canStart()) return; if (await Shoot.countdown()) Shoot.startSeg(); }
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
})();

$('#sh-del').addEventListener('click', () => Shoot.delLast());
$('#sh-done').addEventListener('click', async () => { await Shoot.stopSeg(); Exporter.prime(); Review.fromShoot(Shoot.sid); });
$('#s-shoot').addEventListener('pointerdown', () => Pacer.wake());
$('#sh-close').addEventListener('click', () => { const n = Shoot.segs.length; history.state ? history.back() : goHome(); if (n) toast('הטיוטה נשמרה'); });
$('#sh-flip').addEventListener('click', () => { if (Shoot.running) return; Shoot.facing = Shoot.facing === 'user' ? 'environment' : 'user'; Shoot.startCam(); haptic(); });
$('#modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { Shoot.setMode(b.dataset.m); haptic(); toast(b.dataset.m === 'rehearse' ? 'חזרה: הטקסט רץ בלי הקלטה' : 'צילום'); } });
$('#sh-mode').addEventListener('click', () => {
  const o = ['voice', 'auto', 'manual']; settings.mode = o[(o.indexOf(settings.mode) + 1) % 3];
  Shoot.applyRail(); toast(MODE_T[settings.mode]); haptic();
});
$('#sh-size').addEventListener('click', () => { const o = [18, 22, 26, 30]; settings.fontSize = o[(o.indexOf(settings.fontSize) + 1) % o.length]; Shoot.applyRail(); Shoot.layout(); haptic(); });
$('#sh-timer').addEventListener('click', () => { const o = [0, 3, 10]; settings.timer = o[(o.indexOf(settings.timer) + 1) % o.length]; Shoot.applyRail(); haptic(); });
$('#sh-len').addEventListener('click', () => { const o = [15, 60, 180]; settings.maxDur = o[(o.indexOf(settings.maxDur) + 1) % o.length]; Shoot.applyRail(); Shoot.renderSegs(); haptic(); });
$('#sh-eye').addEventListener('click', () => { settings.eye = !settings.eye; Shoot.applyRail(); if (settings.eye) Eye.load(); haptic(); });

/* גרירת הפרומפטר למעלה ולמטה, והקשה על מילה כדי לקפוץ אליה */
(() => {
  const pr = $('#prompter'); let y0 = 0, li0 = 0, drag = false, id = null;
  pr.addEventListener('pointerdown', (e) => { id = e.pointerId; y0 = e.clientY; li0 = Shoot.curLine(); drag = false; pr.setPointerCapture(id); });
  pr.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dy = e.clientY - y0;
    if (!drag && Math.abs(dy) > 8) drag = true;
    if (!drag) return;
    const li = clamp(li0 - Math.round(dy / Shoot.lh), 0, Shoot.lines.length);
    const target = li >= Shoot.lines.length ? Shoot.W.length : Shoot.lines[li][0];
    if (target !== Shoot.p) { Shoot.setPointer(target, true); haptic(4); }
  });
  pr.addEventListener('pointerup', (e) => {
    if (e.pointerId !== id) return; id = null;
    if (drag) return;
    if (settings.mode === 'manual') { const nx = Shoot.lines[Shoot.curLine() + 1]; Shoot.setPointer(nx ? nx[0] : Shoot.W.length, true); return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const w = el && el.closest && el.closest('.pw'); if (w) { Shoot.setPointer(+w.dataset.i, true); haptic(); }
  });
})();
window.addEventListener('resize', () => { if (current === 'shoot') Shoot.layout(); });

/* =========================================================
   מד קשר עין (MediaPipe, נטען רק כשצריך)
   ========================================================= */
const Eye = {
  lm: null, loading: false, failed: false, score: null, ema: null, face: false, nose: null, lastTs: 0,
  async load() {
    if (this.lm || this.loading || this.failed) return;
    this.loading = true;
    const V = '0.10.14';
    try {
      const m = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${V}/vision_bundle.mjs`);
      const fs = await m.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${V}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', delegate },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true,
      });
      try { this.lm = await m.FaceLandmarker.createFromOptions(fs, opts('GPU')); }
      catch (_) { this.lm = await m.FaceLandmarker.createFromOptions(fs, opts('CPU')); }
    } catch (e) { console.warn('eye', e); this.failed = true; }
    this.loading = false;
  },
  sample(v) {
    if (!this.lm || v.readyState < 2) return;
    const now = performance.now(); if (now <= this.lastTs) return; this.lastTs = now;
    let r; try { r = this.lm.detectForVideo(v, now); } catch (_) { return; }
    if (!r.faceBlendshapes || !r.faceBlendshapes.length) { this.face = false; this.score = null; this.ema = null; return; }
    this.face = true;
    const c = {}; r.faceBlendshapes[0].categories.forEach((x) => (c[x.categoryName] = x.score));
    const g = (k) => c[k] || 0;
    const horiz = Math.max((g('eyeLookOutLeft') + g('eyeLookInRight')) / 2, (g('eyeLookInLeft') + g('eyeLookOutRight')) / 2);
    const down = (g('eyeLookDownLeft') + g('eyeLookDownRight')) / 2;
    const up = (g('eyeLookUpLeft') + g('eyeLookUpRight')) / 2;
    let s = 100 - 160 * Math.max(0, horiz - 0.14) - 110 * Math.max(0, down - 0.42) - 120 * Math.max(0, up - 0.3);
    const L = r.faceLandmarks && r.faceLandmarks[0];
    if (L) {
      const a = L[33], b = L[263], n = L[1]; this.nose = n;
      const span = Math.abs(b.x - a.x) || 1; const yaw = (n.x - (a.x + b.x) / 2) / span;
      s -= 200 * Math.max(0, Math.abs(yaw) - 0.12);
    }
    s = clamp(s, 0, 100);
    this.ema = this.ema == null ? s : this.ema * 0.7 + s * 0.3;
    this.score = Math.round(this.ema);
  },
};

/* =========================================================
   ניתוח קול לקובץ: קטעי דיבור ותזמון מילים
   ========================================================= */
async function analyzeAudio(blob, fallbackDur) {
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await new OAC(1, 44100, 44100).decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0); const sr = buf.sampleRate; const hop = Math.round(sr * 0.02);
    const db = [];
    for (let i = 0; i + hop <= data.length; i += hop) { let s = 0; for (let j = i; j < i + hop; j++) s += data[j] * data[j]; db.push(10 * Math.log10(s / hop + 1e-10)); }
    const sorted = db.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(clamp(p, 0, 0.999) * sorted.length)] ?? -100;
    const noise = q(0.12), peak = q(0.97);
    if (peak - noise < 8) return { dur: buf.duration, ranges: [] };
    const on = noise + Math.max(9, (peak - noise) * 0.32), off = noise + Math.max(6, (peak - noise) * 0.22);
    let ranges = []; let st = -1, hang = 0;
    db.forEach((v, i) => {
      if (st < 0) { if (v > on) { st = i; hang = 0; } }
      else if (v < off) { hang++; if (hang > 8) { ranges.push([st * 0.02, (i - hang + 1) * 0.02]); st = -1; } }
      else hang = 0;
    });
    if (st >= 0) ranges.push([st * 0.02, db.length * 0.02]);
    const merged = [];
    for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] - l[1] < 0.12) l[1] = r[1]; else merged.push(r.slice()); }
    ranges = merged.filter((r) => r[1] - r[0] >= 0.08);
    return { dur: buf.duration, ranges };
  } catch (e) {
    console.warn('decode', e);
    return { dur: fallbackDur, ranges: [] };
  }
}

/* יישור טקסט לקול: גבולות משפטים ננעלים על השתיקות הקרובות, ובתוך משפט מחלקים לפי הברות */
function alignWords(words, ranges, dur) {
  if (!words.length) return;
  if (!ranges.length) ranges = [[Math.min(0.15, dur * 0.05), Math.max(0.2, dur - 0.15)]];
  const lens = ranges.map((r) => r[1] - r[0]); const total = lens.reduce((a, b) => a + b, 0);
  const cumR = []; let c = 0; for (const l of lens) { cumR.push(c); c += l; }
  const v2t = (x) => { for (let i = 0; i < ranges.length; i++) if (x < cumR[i] + lens[i] - 1e-6) return ranges[i][0] + Math.max(0, x - cumR[i]); return ranges[ranges.length - 1][1]; };
  const syl = words.map(sylOf); const S = syl.reduce((a, b) => a + b, 0);
  const cumS = []; c = 0; for (const s of syl) { cumS.push(c); c += s; }
  const gaps = []; for (let i = 1; i < ranges.length; i++) gaps.push({ v: cumR[i], len: ranges[i][0] - ranges[i - 1][1], used: false });
  const anchors = [{ i: 0, v: 0 }]; let lastV = 0;
  for (let k = 0; k < words.length - 1; k++) {
    const w = words[k]; const strong = isPhraseEnd(w); const soft = /[,:;]$/.test(w.text);
    if (!strong && !soft) continue;
    const e = (cumS[k + 1] / S) * total; const tol = Math.max(0.9, total * 0.1);
    let best = null, bs = 1e9;
    for (const g of gaps) {
      if (g.used || g.v <= lastV + 0.15) continue;
      const d = Math.abs(g.v - e); if (d > tol) continue;
      if (g.len < (strong ? 0.16 : 0.26)) continue;
      const score = d - Math.min(g.len, 1.2) * 0.7; if (score < bs) { bs = score; best = g; }
    }
    if (best) { best.used = true; anchors.push({ i: k + 1, v: best.v }); lastV = best.v; }
  }
  anchors.push({ i: words.length, v: total });
  for (let a = 0; a < anchors.length - 1; a++) {
    const A = anchors[a], B = anchors[a + 1];
    const s0 = cumS[A.i], s1 = B.i < words.length ? cumS[B.i] : S;
    for (let k = A.i; k < B.i; k++) { const f = s1 > s0 ? (cumS[k] - s0) / (s1 - s0) : 0; words[k].t = v2t(A.v + f * (B.v - A.v)); }
  }
}
function snapVoiced(t, ranges) {
  for (const r of ranges) { if (t >= r[0] - 0.05 && t < r[1]) return t; if (r[0] > t) return r[0] - t < 1.2 ? r[0] : t; }
  return t;
}
/* משלב את חותמות הזמן שנאספו בזמן הצילום עם ניתוח הקול */
function timeClipWords(words, stamps, ranges, dur) {
  const have = words.filter((w) => stamps && stamps[w.idx] != null).length;
  if (have < Math.max(2, words.length * 0.5)) { alignWords(words, ranges, dur); return; }
  words.forEach((w) => { w.t = stamps[w.idx] != null ? snapVoiced(clamp(stamps[w.idx], 0, dur), ranges) : null; });
  for (let i = 0; i < words.length; i++) {
    if (words[i].t != null) continue;
    let a = i - 1; while (a >= 0 && words[a].t == null) a--;
    let b = i + 1; while (b < words.length && words[b].t == null) b++;
    const ta = a >= 0 ? words[a].t : Math.max(0, (words[b] ? words[b].t : 0.2) - 0.3 * (b - i));
    const tb = b < words.length ? words[b].t : Math.min(dur, ta + 0.3 * (b - a));
    for (let k = i; k < b; k++) words[k].t = ta + ((k - a) / (b - a)) * (tb - ta);
    i = b - 1;
  }
  for (let i = 1; i < words.length; i++) if (words[i].t < words[i - 1].t + 0.06) words[i].t = Math.min(dur, words[i - 1].t + 0.06);
}
function keepRanges(ranges, dur, trim) {
  if (!trim || !ranges.length) return [[0, dur]];
  const out = [];
  for (const r of ranges) {
    const a = Math.max(0, r[0] - 0.12), b = Math.min(dur, r[1] + 0.2);
    const l = out[out.length - 1];
    if (l && a - l[1] < 0.35) l[1] = b; else out.push([a, b]);
  }
  return out;
}

/* =========================================================
   סגנונות כתוביות
   ========================================================= */
const STYLES = {
  classic: { name: 'קלאסי', size: 96, lh: 1.16, max: 3, chars: 18, font: (px) => `900 ${px}px Heebo, sans-serif` },
  box: { name: 'תיבה', size: 86, lh: 1.32, max: 3, chars: 18, font: (px) => `800 ${px}px Heebo, sans-serif` },
  tall: { name: 'דחוס', size: 150, lh: 1.0, max: 3, chars: 16, font: (px) => `700 ${px}px Karantina, Heebo, sans-serif` },
  serif: { name: 'אלגנט', size: 84, lh: 1.32, max: 4, chars: 22, font: (px) => `500 ${px}px "Frank Ruhl Libre", serif` },
  sub: { name: 'כתובית', size: 56, lh: 1.42, max: 7, chars: 34, font: (px) => `600 ${px}px Rubik, sans-serif` },
};
if (!STYLES[settings.style]) settings.style = 'classic';

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}
function wrapItems(items, maxW, sp) {
  const lines = []; let line = [], lw = 0;
  for (const it of items) {
    const add = line.length ? sp + it.w : it.w;
    if (line.length && lw + add > maxW) { lines.push({ items: line, w: lw }); line = [it]; lw = it.w; }
    else { line.push(it); lw += add; }
  }
  if (line.length) lines.push({ items: line, w: lw });
  return lines;
}

/* ציור קבוצת מילים. items: {text, emph, active, age, future} */
function drawGroup(ctx, W, H, items, key, yc, accent, alpha = 1, scale) {
  const st = STYLES[key]; const s = scale || W / 1080; const px = st.size * s;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.font = st.font(px); ctx.textBaseline = 'middle'; ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.lineJoin = 'round';
  const sp = ctx.measureText(' ').width * (key === 'tall' ? 1.5 : key === 'box' ? 1.3 : 1.05);
  items = items.map((it) => ({ ...it, w: ctx.measureText(it.text).width }));
  const lines = wrapItems(items, W * 0.84, sp);
  const LH = px * st.lh;
  let y = yc - ((lines.length - 1) * LH) / 2;
  const shadow = (k = 1) => { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18 * s * k; ctx.shadowOffsetY = 3 * s * k; };
  const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
  for (const line of lines) {
    if (key === 'sub') {
      noShadow(); ctx.fillStyle = 'rgba(0,0,0,.62)';
      const pad = 22 * s; rrect(ctx, W / 2 - line.w / 2 - pad, y - LH / 2 + 6 * s, line.w + pad * 2, LH - 12 * s, 14 * s); ctx.fill();
    }
    let x = W / 2 + line.w / 2;
    for (const it of line.items) {
      const cx = x - it.w / 2;
      const k = it.active ? clamp((it.age || 0) / 0.16, 0, 1) : 1;
      const ease = 1 - Math.pow(1 - k, 3);
      const sc = it.active && key !== 'sub' && key !== 'serif' ? 1.12 - 0.12 * ease : 1;
      ctx.save(); ctx.translate(cx, y); ctx.scale(sc, sc); ctx.translate(-cx, -y);
      if (key === 'classic') {
        ctx.strokeStyle = '#000'; ctx.lineWidth = 11 * s; shadow(0.6); ctx.strokeText(it.text, x, y);
        noShadow(); ctx.fillStyle = it.active ? accent : it.emph ? accent : '#fff';
        if (it.emph && it.active) ctx.fillStyle = '#fff';
        ctx.fillText(it.text, x, y);
      } else if (key === 'box') {
        if (it.active) {
          noShadow(); const pad = 18 * s; ctx.fillStyle = accent;
          rrect(ctx, x - it.w - pad, y - px * 0.6, it.w + pad * 2, px * 1.18, 18 * s); ctx.fill();
          ctx.fillStyle = '#000';
        } else { shadow(); ctx.fillStyle = it.emph ? accent : '#fff'; }
        ctx.fillText(it.text, x, y + px * 0.03);
      } else if (key === 'tall') {
        if (it.active) {
          noShadow(); const pad = 16 * s; ctx.fillStyle = it.emph ? accent : '#fff';
          rrect(ctx, x - it.w - pad, y - px * 0.47, it.w + pad * 2, px * 0.9, 14 * s); ctx.fill();
          ctx.fillStyle = '#000';
        } else { shadow(); ctx.fillStyle = it.emph ? accent : '#fff'; }
        ctx.fillText(it.text, x, y + px * 0.04);
      } else if (key === 'serif') {
        shadow(); ctx.fillStyle = it.future ? 'rgba(255,255,255,.55)' : it.emph ? accent : '#fff'; ctx.fillText(it.text, x, y);
        if (it.active) { noShadow(); ctx.fillStyle = accent; ctx.fillRect(x - it.w * ease, y + px * 0.52, it.w * ease, 5 * s); }
      } else {
        noShadow(); ctx.fillStyle = it.active ? '#fff' : it.emph ? accent : 'rgba(255,255,255,.78)'; ctx.fillText(it.text, x, y);
      }
      ctx.restore();
      x -= it.w + sp;
    }
    y += LH;
  }
  ctx.restore();
}

/* =========================================================
   עריכה ונגן
   ========================================================= */
const R = {
  from: 'shoot', sid: null, clips: [], words: [], tl: [], total: 0, groups: [],
  pos: settings.pos, trim: true, hook: true, hookText: '', brand: true, caps: true, eye: null,
};

function drawHook(ctx, W, H, G, accent) {
  if (!R.hook || !R.hookText || G > 2.4) return;
  const s = W / 1080; const a = G < 2.1 ? 1 : clamp((2.4 - G) / 0.3, 0, 1);
  ctx.save(); ctx.globalAlpha = a;
  const px = 96 * s; ctx.font = `900 ${px}px Heebo, sans-serif`; ctx.textBaseline = 'middle'; ctx.direction = 'rtl'; ctx.textAlign = 'center';
  const words = R.hookText.split(/\s+/).filter(Boolean);
  const sp = ctx.measureText(' ').width;
  const lines = wrapItems(words.map((t) => ({ text: t, w: ctx.measureText(t).width })), W * 0.66, sp);
  const LH = px * 1.18; const padX = 34 * s, padY = 22 * s;
  const bw = Math.max(...lines.map((l) => l.w)) + padX * 2, bh = lines.length * LH + padY * 2;
  const top = H * 0.17;
  const k = clamp(G / 0.25, 0, 1); const sc = 0.92 + 0.08 * (1 - Math.pow(1 - k, 3));
  ctx.translate(W / 2, top + bh / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -(top + bh / 2));
  ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 30 * s; ctx.shadowOffsetY = 8 * s;
  rrect(ctx, W / 2 - bw / 2, top, bw, bh, 26 * s); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.fillStyle = '#000';
  let y = top + padY + LH / 2;
  for (const l of lines) { ctx.fillText(l.items.map((i) => i.text).join(' '), W / 2, y + px * 0.03); y += LH; }
  ctx.fillStyle = accent; rrect(ctx, W / 2 - 40 * s, top + bh - 7 * s, 80 * s, 7 * s, 3.5 * s); ctx.fill();
  ctx.restore();
}
function drawBrand(ctx, W, H) {
  const h = (settings.handle || '').trim(); if (!R.brand || !h) return;
  const s = W / 1080; ctx.save();
  ctx.font = `600 ${30 * s}px Rubik, sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.direction = hasHeb(h) ? 'rtl' : 'ltr'; ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 10 * s;
  ctx.fillText(h, W / 2, H * 0.94);
  ctx.restore();
}
function render(G, target, pl = Player) {
  const cv = target || $('#rv-canvas'); const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  if (G == null) G = pl.G();
  const v = pl.v;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (v && v.readyState >= 2 && v.videoWidth) {
    const sc = Math.max(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    const seg = R.tl[pl.k]; const mirror = seg && R.clips[seg.clip] && R.clips[seg.clip].mirror;
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }
  const accent = settings.accent;
  if (R.caps) {
    const gi = groupAt(G);
    if (gi >= 0) {
      const gr = R.groups[gi]; const items = [];
      let act = -1; for (let i = gr.i0; i < gr.i1; i++) if (R.words[i].g <= G + 0.02) act = i;
      for (let i = gr.i0; i < gr.i1; i++) { const w = R.words[i]; items.push({ text: w.text, emph: w.emph, active: i === act, age: G - w.g, future: i > act }); }
      drawGroup(ctx, W, H, items, settings.style, H * (R.pos / 100), accent, clamp((G - gr.start) / 0.08, 0, 1));
    }
  }
  drawHook(ctx, W, H, G, accent);
  drawBrand(ctx, W, H);
  if (!target || target.id === 'rv-canvas') Review.ui(G);
  return G;
}
function groupAt(G) {
  const gs = R.groups; let lo = 0, hi = gs.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (gs[m].start <= G) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 && G < gs[ans].end ? ans : -1;
}
function buildTimeline() {
  R.tl = []; let g = 0;
  R.clips.forEach((c, ci) => {
    c.keep = keepRanges(c.ranges, c.dur, R.trim);
    c.keep.forEach(([a, b]) => { R.tl.push({ clip: ci, a, b, g }); g += b - a; });
  });
  R.total = g;
  R.words.forEach((w) => (w.g = toGlobal(w.clip, w.t)));
  computeGroups();
}
function toGlobal(ci, t) {
  let last = null;
  for (const s of R.tl) {
    if (s.clip !== ci) continue;
    if (t < s.a) return s.g;
    if (t < s.b) return s.g + (t - s.a);
    last = s;
  }
  return last ? last.g + (last.b - last.a) - 0.05 : 0;
}
function toLocal(G) {
  for (const s of R.tl) if (G < s.g + (s.b - s.a)) return { clip: s.clip, t: s.a + Math.max(0, G - s.g) };
  const s = R.tl[R.tl.length - 1]; return { clip: s.clip, t: s.b };
}
function computeGroups() {
  const st = STYLES[settings.style]; const out = []; let cur = null;
  R.words.forEach((w, i) => {
    const prev = R.words[i - 1];
    const brk = !cur || cur.n >= st.max || cur.chars + w.text.length > st.chars ||
      (prev && isPhraseEnd(prev)) || (prev && /[,:;]$/.test(prev.text) && cur.n >= 2) ||
      (prev && prev.clip !== w.clip) || (prev && w.g - prev.g > 1.0);
    if (brk) { cur = { i0: i, i1: i + 1, n: 1, chars: w.text.length, start: w.g }; out.push(cur); }
    else { cur.i1 = i + 1; cur.n++; cur.chars += w.text.length + 1; }
  });
  out.forEach((gr, j) => {
    const last = R.words[gr.i1 - 1]; const next = out[j + 1];
    const est = last.g + Math.max(0.4, sylOf(last) * 0.22) + 0.45;
    gr.end = next ? Math.min(next.start, est) : Math.min(R.total, est + 0.4);
    if (gr.end <= gr.start) gr.end = gr.start + 0.3;
  });
  R.groups = out;
}

function makePlayer(ui) {
  return {
    ui, v: null, k: 0, playing: false, busy: false, hooks: null, target: null, onEnd: null, onFrame: null, dest: null, src: null,
    init() {
      if (this.v) return;
      const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
      this.v = v;
    },
    /* רק לנגן הייצוא: השמע נשלח להקלטה ולא לרמקול */
    audio(ac) {
      this.init(); if (this.src) return;
      this.src = ac.createMediaElementSource(this.v);
      this.dest = ac.createMediaStreamDestination(); this.src.connect(this.dest);
    },
    async load(url) {
      this.init();
      const v = this.v; if (v._url === url) return;
      v._url = url; v.src = url;
      await waitEvt(v, 'loadedmetadata');
      if (!isFinite(v.duration)) { v.currentTime = 1e7; await waitEvt(v, 'durationchange', 2500); v.currentTime = 0; await waitEvt(v, 'seeked', 2500); }
    },
    async seekVideo(t) {
      const v = this.v; if (Math.abs(v.currentTime - t) < 0.015 && v.readyState >= 2) return;
      v.currentTime = t; await waitEvt(v, 'seeked', 3000);
    },
    G() {
      const s = R.tl[this.k]; if (!s || !this.v) return 0;
      return clamp(s.g + (this.v.currentTime - s.a), s.g, s.g + (s.b - s.a));
    },
    async seek(G) {
      if (!R.tl.length) return;
      G = clamp(G, 0, Math.max(0, R.total - 0.01));
      let k = R.tl.findIndex((s) => G < s.g + (s.b - s.a)); if (k < 0) k = R.tl.length - 1;
      const s = R.tl[k]; this.k = k;
      await this.load(R.clips[s.clip].url);
      await this.seekVideo(s.a + (G - s.g));
      render(G, this.target, this);
    },
    async play() {
      if (this.playing || !R.tl.length) return false;
      this.init();
      if (this.G() >= R.total - 0.08) await this.seek(0);
      this.playing = true; if (this.ui) $('#stage').classList.add('playing');
      try { await this.v.play(); } catch (e) { this.pause(); return false; }
      const loop = () => {
        if (!this.playing) return;
        requestAnimationFrame(loop);
        if (this.busy) return;
        const s = R.tl[this.k];
        if (this.v.currentTime >= s.b - 0.03 || this.v.ended) { this.advance(); return; }
        render(null, this.target, this);
        if (this.onFrame) this.onFrame();
      };
      requestAnimationFrame(loop);
      return true;
    },
    pause() { this.playing = false; if (this.v) this.v.pause(); if (this.ui) $('#stage').classList.remove('playing'); },
    async advance() {
      this.busy = true;
      const k = this.k + 1;
      if (k >= R.tl.length) {
        this.pause(); this.busy = false; render(R.total - 0.001, this.target, this);
        const f = this.onEnd;
        if (f) f(); else if (this.ui && current === 'review') { await this.seek(0); this.play(); }
        return;
      }
      const cur = R.tl[this.k], nx = R.tl[k]; this.k = k;
      if (nx.clip === cur.clip && Math.abs(this.v.currentTime - nx.a) < 0.06) { this.busy = false; return; }
      if (this.hooks) this.hooks.pause();
      this.v.pause();
      await this.load(R.clips[nx.clip].url);
      await this.seekVideo(nx.a);
      if (this.playing) await this.v.play().catch(() => {});
      if (this.hooks) this.hooks.resume();
      this.busy = false;
    },
  };
}
const Player = makePlayer(true);

const Review = {
  lastG: -1, lastGroup: -2, openSheet: null,
  async fromShoot(sid) {
    const segs = await DB.bySid(sid); if (!segs.length) { toast('אין עדיין קטעים מצולמים'); return; }
    const W = parseScript(scriptById(sid).text);
    R.from = 'shoot'; R.sid = sid; R.trim = true; R.hook = true;
    R.clips = segs.map((s) => ({ blob: s.blob, dur: s.dur, url: URL.createObjectURL(s.blob), mirror: s.mirror !== false, stamps: s.stamps || {} }));
    const assign = segs.map((s) => [s.w0, s.w1]);
    const tracked = segs.reduce((a, s) => a + Math.max(0, s.w1 - s.w0), 0);
    if (!tracked) {
      const T = segs.reduce((a, s) => a + s.dur, 0); let acc = 0, i0 = 0;
      segs.forEach((s, i) => { acc += s.dur; const i1 = i === segs.length - 1 ? W.length : Math.round((acc / T) * W.length); assign[i] = [i0, i1]; i0 = i1; });
    } else {
      const last = assign[assign.length - 1];
      if (last[1] < W.length && last[1] >= W.length * 0.8) last[1] = W.length;
    }
    R.words = [];
    assign.forEach(([a, b], ci) => { for (let i = a; i < b; i++) if (W[i]) R.words.push({ ...W[i], idx: i, clip: ci, t: 0 }); });
    const eyes = segs.filter((s) => s.eye != null);
    R.eye = eyes.length ? Math.round(eyes.reduce((a, s) => a + s.eye * s.dur, 0) / eyes.reduce((a, s) => a + s.dur, 0)) : null;
    await this.open();
  },
  async fromImport(file, text, dur) {
    R.from = 'import'; R.sid = null; R.trim = false; R.hook = false; R.eye = null;
    R.clips = [{ blob: file, dur, url: URL.createObjectURL(file), mirror: false, stamps: {} }];
    R.words = parseScript(text).map((w, i) => ({ ...w, idx: i, clip: 0, t: 0 }));
    await this.open();
  },
  async open() {
    show('review');
    Player.init(); Player.target = null; Player.hooks = null; Player.onEnd = null; Player.onFrame = null;
    if (Exporter.pl) { Exporter.pl.v._url = null; }
    this.sheet(null);
    $('#rv-trim').checked = R.trim; $('#rv-hook').checked = R.hook; $('#rv-brand').checked = R.brand; $('#rv-caps').checked = R.caps;
    $('#rv-pos').value = R.pos;
    $('#rv-brand-l').textContent = settings.handle ? settings.handle : 'הוסיפו שם בהגדרות שבמסך הבית';
    const ey = $('#rv-eye'); ey.hidden = R.eye == null; if (R.eye != null) ey.innerHTML = `<i></i>קשר עין ${R.eye}%`;
    const first = []; for (const w of R.words) { first.push(w.text); if (isPhraseEnd(w) || first.length >= 7) break; }
    R.hookText = first.join(' ').replace(/[,.:;…]$/, '');
    $('#rv-hook-text').value = R.hookText; $('#rv-hook-text').hidden = !R.hook;
    this.busy(true);
    await Promise.all([document.fonts.ready, ...Object.values(STYLES).map((s) => document.fonts.load(s.font(40), 'אבג'))].map((p) => Promise.resolve(p).catch(() => {})));
    for (const [ci, c] of R.clips.entries()) {
      const a = await analyzeAudio(c.blob, c.dur);
      c.ranges = a.ranges; if (isFinite(a.dur) && a.dur > 0) c.dur = a.dur;
      timeClipWords(R.words.filter((w) => w.clip === ci), c.stamps, c.ranges, c.dur);
    }
    buildTimeline();
    this.styles(); this.swatches(); this.groupsList();
    this.busy(false);
    await Player.seek(0);
    Player.play();
  },
  busy(on) { $('#rv-busy').hidden = !on; },
  ui(G) {
    if (Math.abs(G - this.lastG) > 0.05) {
      this.lastG = G;
      $('#rv-t').textContent = fmt(G); $('#rv-d').textContent = fmt(R.total);
      if (!this.scrubbing) $('#rv-seek').value = R.total ? Math.round((G / R.total) * 1000) : 0;
    }
    const gi = groupAt(G);
    if (gi !== this.lastGroup) { this.lastGroup = gi; $$('#groups .group').forEach((el, i) => el.classList.toggle('now', i === gi)); }
  },
  sheet(name) {
    this.openSheet = name;
    ['style', 'caps', 'edit'].forEach((n) => ($('#sheet-' + n).hidden = n !== name));
    $$('.rv-rail .rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.sheet === name));
  },
  styles() {
    const box = $('#styles');
    box.innerHTML = Object.entries(STYLES).map(([k, s]) => `<button class="style-card${k === settings.style ? ' on' : ''}" data-k="${k}"><canvas width="192" height="192"></canvas>${s.name}</button>`).join('');
    $$('.style-card', box).forEach((b) => {
      const cv = b.querySelector('canvas'); const ctx = cv.getContext('2d');
      const items = [{ text: 'ככה', active: false }, { text: 'זה', active: true, age: 1 }, { text: 'נראה', active: false, future: true }];
      drawGroup(ctx, 192, 192, items, b.dataset.k, 96, settings.accent, 1, { classic: 0.42, box: 0.42, tall: 0.3, serif: 0.42, sub: 0.5 }[b.dataset.k]);
    });
  },
  swatches() {
    $('#rv-accent').innerHTML = ACCENTS.map((c) => `<button class="swatch${c === settings.accent ? ' on' : ''}" style="background:${c}" data-c="${c}" aria-label="צבע"></button>`).join('');
  },
  groupsList() {
    $('#groups').innerHTML = R.groups.map((g, i) => {
      const txt = R.words.slice(g.i0, g.i1).map((w) => (w.emph ? '*' + w.text + '*' : w.text)).join(' ');
      return `<li class="group" data-i="${i}"><span class="tc">${fmt1(g.start)}</span><input value="${esc(txt)}" aria-label="כתובית ${i + 1}" dir="rtl"><span class="nudge"><button data-d="-0.1" aria-label="מוקדם יותר">−</button><button data-d="0.1" aria-label="מאוחר יותר">+</button></span></li>`;
    }).join('');
    this.lastGroup = -2;
  },
  editGroup(i, text) {
    const g = R.groups[i]; if (!g) return;
    const nw = parseScript(text); if (!nw.length) return;
    const old = R.words.slice(g.i0, g.i1);
    const start = g.start, end = Math.max(g.end - 0.15, start + 0.3);
    const S = nw.reduce((a, w) => a + sylOf(w), 0); let acc = 0;
    const words = nw.map((w) => { const G = start + (acc / S) * (end - start); acc += sylOf(w); const L = toLocal(G); return { ...w, idx: old[0].idx, clip: L.clip, t: L.t }; });
    R.words.splice(g.i0, g.i1 - g.i0, ...words);
    buildTimeline(); this.groupsList(); render(Player.G());
  },
  nudge(i, d) {
    const g = R.groups[i]; if (!g) return;
    const prev = R.groups[i - 1], next = R.groups[i + 1];
    const lo = prev ? prev.start + 0.1 : 0, hi = next ? next.start - 0.1 : R.total;
    const shift = clamp(g.start + d, lo, hi) - g.start; if (!shift) return;
    for (let k = g.i0; k < g.i1; k++) { const w = R.words[k]; const L = toLocal(clamp(w.g + shift, 0, R.total)); w.clip = L.clip; w.t = L.t; }
    buildTimeline(); this.groupsList(); Player.pause(); Player.seek(R.groups[i] ? R.groups[i].start + 0.05 : 0);
  },
  back() {
    Player.pause();
    if (R.from === 'shoot' && R.sid) Shoot.open(R.sid);
    else show('import', false);
  },
};
leaveHooks.review = () => { Player.pause(); Review.sheet(null); };

$('#rv-back').addEventListener('click', () => Review.back());
$('#rv-play').addEventListener('click', (e) => { e.stopPropagation(); Player.play(); });
$('#stage').addEventListener('click', () => { if (Review.openSheet) { Review.sheet(null); return; } Player.playing ? Player.pause() : Player.play(); });
$$('.rv-rail .rail-btn').forEach((b) => b.addEventListener('click', () => { Review.sheet(Review.openSheet === b.dataset.sheet ? null : b.dataset.sheet); haptic(); }));
$('#rv-seek').addEventListener('input', (e) => { Review.scrubbing = true; Player.pause(); const G = (e.target.value / 1000) * R.total; clearTimeout(Review._sk); Review._sk = setTimeout(() => Player.seek(G), 30); });
$('#rv-seek').addEventListener('change', () => (Review.scrubbing = false));
$('#styles').addEventListener('click', (e) => {
  const b = e.target.closest('.style-card'); if (!b) return;
  settings.style = b.dataset.k; saveSettings(); haptic();
  $$('.style-card').forEach((x) => x.classList.toggle('on', x === b));
  computeGroups(); Review.groupsList(); if (!Player.playing) render(Player.G());
});
$('#rv-accent').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch'); if (!b) return;
  settings.accent = b.dataset.c; saveSettings(); haptic();
  document.documentElement.style.setProperty('--accent', settings.accent);
  Review.swatches(); Review.styles(); if (!Player.playing) render(Player.G());
});
$('#rv-pos').addEventListener('input', (e) => { R.pos = settings.pos = +e.target.value; saveSettings(); if (!Player.playing) render(Player.G()); });
$('#rv-trim').addEventListener('change', async (e) => { const G = Player.G(); R.trim = e.target.checked; Player.pause(); buildTimeline(); Review.groupsList(); await Player.seek(Math.min(G, R.total)); toast(R.trim ? `השתיקות נחתכו · ${fmt(R.total)}` : `באורך מלא · ${fmt(R.total)}`); });
$('#rv-hook').addEventListener('change', (e) => { R.hook = e.target.checked; $('#rv-hook-text').hidden = !R.hook; Player.pause(); Player.seek(0.5); });
$('#rv-hook-text').addEventListener('input', (e) => { R.hookText = e.target.value; if (!Player.playing) Player.seek(0.5); });
$('#rv-brand').addEventListener('change', (e) => { R.brand = e.target.checked; render(Player.G()); });
$('#rv-caps').addEventListener('change', (e) => { R.caps = e.target.checked; render(Player.G()); });
$('#groups').addEventListener('change', (e) => { const li = e.target.closest('.group'); if (li && e.target.tagName === 'INPUT') Review.editGroup(+li.dataset.i, e.target.value); });
$('#groups').addEventListener('click', (e) => {
  const li = e.target.closest('.group'); if (!li) return;
  const b = e.target.closest('button[data-d]'); const i = +li.dataset.i;
  if (b) { Review.nudge(i, +b.dataset.d); haptic(); return; }
  if (e.target.tagName !== 'INPUT') { Player.pause(); Player.seek(R.groups[i].start + 0.05); }
});

/* ---------- סנכרון בהקשות ---------- */
const TapSync = {
  i: 0, starts: [],
  async start() {
    if (!R.groups.length) return;
    this.i = 0; this.starts = [];
    Review.sheet(null);
    $('#tapsync').hidden = false; this.paint();
    Player.pause(); await Player.seek(0);
    Player.onEnd = () => this.finish();
    Player.play();
  },
  paint() {
    const g = R.groups[this.i];
    $('#ts-step').textContent = `${Math.min(this.i + 1, R.groups.length)} / ${R.groups.length}`;
    $('#ts-next').textContent = g ? R.words.slice(g.i0, g.i1).map((w) => w.text).join(' ') : 'סיימתם';
  },
  hit() {
    if (this.i >= R.groups.length) return;
    this.starts[this.i] = Player.G(); this.i++; this.paint(); haptic(6);
    if (this.i >= R.groups.length) setTimeout(() => this.finish(), 500);
  },
  finish() {
    Player.onEnd = null; Player.pause(); $('#tapsync').hidden = true;
    if (!this.starts.length) return;
    const gs = R.groups.map((g) => ({ ...g }));
    gs.forEach((g, j) => {
      const S0 = this.starts[j]; if (S0 == null) return;
      const nextS = this.starts[j + 1] != null ? this.starts[j + 1] : g.end + (S0 - g.start);
      const words = R.words.slice(g.i0, g.i1);
      const total = words.reduce((a, w) => a + sylOf(w), 0);
      const span = Math.min(Math.max(0.3, nextS - S0 - 0.05), total * 0.24 + 0.3);
      let acc = 0;
      words.forEach((w) => { const G = S0 + (acc / total) * span; acc += sylOf(w); const L = toLocal(G); w.clip = L.clip; w.t = L.t; });
    });
    buildTimeline(); Review.groupsList(); Player.seek(0).then(() => Player.play());
    toast(`התזמון עודכן לפי ${this.starts.length} הקשות`);
  },
};
$('#rv-tapsync').addEventListener('click', () => TapSync.start());
$('#ts-hit').addEventListener('pointerdown', (e) => { e.preventDefault(); TapSync.hit(); });
$('#ts-cancel').addEventListener('click', () => { Player.onEnd = null; Player.pause(); $('#tapsync').hidden = true; });

/* =========================================================
   ייצוא
   ========================================================= */
const Exporter = {
  rec: null, cancelled: false, blob: null, url: null, ext: 'mp4', ac: null, pl: null,
  /* נקרא מתוך הקשה של המשתמש, כדי שהדפדפן יאפשר את ערוץ השמע של הייצוא */
  prime() {
    try {
      if (!this.ac) this.ac = newAC();
      if (this.ac.state !== 'running') this.ac.resume().catch(() => {});
      if (!this.pl) { this.pl = makePlayer(false); this.pl.audio(this.ac); }
    } catch (e) { console.warn(e); }
  },
  async run() {
    if (!R.tl.length) return;
    if (!window.MediaRecorder) { toast('הדפדפן הזה לא תומך בייצוא וידאו'); return; }
    this.prime();
    const pl = this.pl;
    Review.sheet(null); Player.pause();
    if (this.ac.state !== 'running') { await Promise.race([this.ac.resume(), new Promise((r) => setTimeout(r, 800))]).catch(() => {}); }
    if (this.ac.state !== 'running') { toast('הדפדפן חסם את השמע. הקישו שוב על ייצוא.'); return; }
    const W = settings.quality === 720 ? 720 : 1080, H = W === 720 ? 1280 : 1920;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const prev = $('#rv-canvas'); const pctx = prev.getContext('2d');
    const stream = cv.captureStream(30);
    pl.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mime = pickMime('export');
    this.cancelled = false; this.ui('run');
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: W === 1080 ? 14e6 : 7e6, audioBitsPerSecond: 192000 } : undefined); }
    catch (e) { toast('הייצוא נכשל בדפדפן הזה'); this.ui('close'); return; }
    this.rec = rec; const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    pl.target = cv; await pl.seek(0);
    Wake.on();
    const done = new Promise((res) => { rec.onstop = res; });
    pl.hooks = { pause: () => { try { rec.state === 'recording' && rec.pause(); } catch (_) {} }, resume: () => { try { rec.state === 'paused' && rec.resume(); } catch (_) {} } };
    pl.onFrame = () => { pctx.drawImage(cv, 0, 0, prev.width, prev.height); this.progress(clamp(pl.G() / R.total, 0, 1)); };
    pl.onEnd = () => { setTimeout(() => { try { rec.state !== 'inactive' && rec.stop(); } catch (_) {} }, 250); };
    rec.start(500);
    await pl.play();
    await done;
    pl.hooks = null; pl.onFrame = null; pl.onEnd = null; Wake.off();
    render(Player.G());
    if (this.cancelled) { this.ui('close'); return; }
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    this.blob = new Blob(chunks, { type });
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(this.blob);
    this.ext = type.includes('mp4') ? 'mp4' : 'webm';
    this.progress(1); this.ui('done'); haptic(20);
  },
  progress(p) { $('#ex-pct').textContent = Math.round(p * 100) + '%'; $('#ex-arc').style.strokeDashoffset = 276.5 * (1 - p); },
  ui(state) {
    const wrap = $('#exporter');
    if (state === 'close') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const done = state === 'done';
    $('#ex-ring').hidden = done; $('#ex-result').hidden = !done; $('#ex-actions').hidden = !done;
    $('#ex-h').textContent = done ? 'הסרטון מוכן' : 'מייצא';
    $('#ex-sub').textContent = done ? (this.ext === 'mp4' ? 'MP4 אנכי, מוכן לטיקטוק, לרילס ולשורטס.' : 'הקובץ בפורמט WebM. לייצוא MP4 השתמשו ב־Chrome מעודכן.') : 'הסרטון נצרב עם הכתוביות. השאירו את המסך פתוח.';
    $('#ex-close').textContent = done ? 'סגירה' : 'ביטול';
    if (done) {
      const v = $('#ex-result'); v.src = this.url; v.play().catch(() => {});
      const name = `mabat-${new Date().toISOString().slice(0, 10)}.${this.ext}`;
      const a = $('#ex-download'); a.href = this.url; a.download = name;
      const file = new File([this.blob], name, { type: this.blob.type });
      const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
      $('#ex-share').hidden = !canShare;
      $('#ex-share').onclick = () => navigator.share({ files: [file] }).catch(() => {});
    } else this.progress(0);
  },
  cancel() {
    if (this.rec && this.rec.state !== 'inactive') { this.cancelled = true; this.pl.pause(); try { this.rec.stop(); } catch (_) {} }
    else { $('#ex-result').pause(); this.ui('close'); if (current === 'review') Player.play(); }
  },
};
$('#rv-export').addEventListener('click', () => { Exporter.prime(); Exporter.run(); });
$('#ex-close').addEventListener('click', () => Exporter.cancel());

/* =========================================================
   ייבוא סרטון קיים
   ========================================================= */
const Import = {
  file: null, dur: 0,
  open() {
    show('import');
    $('#imp-pick').innerHTML = '<option value="">מתסריט…</option>' + scripts.filter((s) => s.text.trim()).map((s) => `<option value="${s.id}">${esc(s.title || 'ללא כותרת')}</option>`).join('');
    this.check();
  },
  async setFile(f) {
    if (!f) return;
    this.file = f;
    const v = $('#imp-preview'); if (v._url) URL.revokeObjectURL(v._url);
    v._url = URL.createObjectURL(f); v.src = v._url; v.hidden = false;
    $('#drop').classList.add('has'); $('#drop-empty').hidden = true;
    await waitEvt(v, 'loadedmetadata');
    this.dur = isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(1, this.dur / 2);
    const m = $('#drop-meta'); m.hidden = false; m.textContent = `${fmt(this.dur)} · ${(f.size / 1048576).toFixed(1)}MB`;
    if (this.dur > 180) toast('סרטון ארוך מ־3 דקות. הייצוא ייקח יותר זמן.');
    this.check();
  },
  check() { $('#imp-go').disabled = !(this.file && parseScript($('#imp-text').value).length); },
};
$('#imp-file').addEventListener('change', (e) => Import.setFile(e.target.files[0]));
$('#imp-text').addEventListener('input', () => Import.check());
$('#imp-pick').addEventListener('change', (e) => { const s = scriptById(e.target.value); if (s) { $('#imp-text').value = s.text; Import.check(); } e.target.value = ''; });
$('#imp-go').addEventListener('click', () => { Exporter.prime(); Review.fromImport(Import.file, $('#imp-text').value, Import.dur); });
const drop = $('#drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => e.preventDefault()));
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('video')) Import.setFile(f); });

/* =========================================================
   הגדרות
   ========================================================= */
function openSettings() {
  $('#set-handle').value = settings.handle;
  $$('#set-pace button').forEach((b) => b.classList.toggle('on', +b.dataset.v === settings.pace));
  $$('#set-quality button').forEach((b) => b.classList.toggle('on', +b.dataset.v === settings.quality));
  $('#set-wpm').value = settings.wpm; $('#set-wpm-l').textContent = settings.wpm + ' מילים לדקה';
  $('#settings').hidden = false;
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-handle').addEventListener('input', (e) => { settings.handle = e.target.value; saveSettings(); });
const segctl = (sel, key) => $(sel).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; settings[key] = +b.dataset.v; saveSettings(); haptic(); $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b)); });
segctl('#set-pace', 'pace'); segctl('#set-quality', 'quality');
$('#set-wpm').addEventListener('input', (e) => { settings.wpm = +e.target.value; $('#set-wpm-l').textContent = settings.wpm + ' מילים לדקה'; saveSettings(); });
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) $('#settings').hidden = true; });

/* =========================================================
   התחלה
   ========================================================= */
document.documentElement.style.setProperty('--accent', settings.accent);
Home.render();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
