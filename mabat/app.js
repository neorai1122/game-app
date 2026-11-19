/* מבט — טלפרומפטר מתחת לעדשה, צילום בקטעים וכתוביות צרובות.
   הכל רץ בדפדפן. תסריטים ב-localStorage, קטעי וידאו ב-IndexedDB. */
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

function waitEvt(el, ev, ms = 5000) {
  return new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); el.removeEventListener(ev, done); res(); }
    el.addEventListener(ev, done, { once: true });
  });
}

let toastT;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), ms);
}

/* כפתור מחיקה בשתי הקשות: הראשונה מבקשת אישור, השנייה מבצעת */
function armConfirm(btn, label, fn) {
  if (btn._armed) { clearTimeout(btn._armed); btn._armed = null; btn.classList.remove('armed'); fn(); return; }
  btn.classList.add('armed');
  const l = btn.querySelector('span'); const prev = l ? l.textContent : null;
  if (l) l.textContent = label;
  toast(label);
  btn._armed = setTimeout(() => { btn._armed = null; btn.classList.remove('armed'); if (l) l.textContent = prev; }, 3000);
}

const Wake = {
  lock: null,
  async on() { try { if ('wakeLock' in navigator && !this.lock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => (this.lock = null)); } } catch (_) {} },
  off() { try { this.lock && this.lock.release(); } catch (_) {} this.lock = null; },
};

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

const DEFAULTS = { handle: '', accent: '#7fe0c4', quality: 1080, wpm: 140, fontSize: 22, mode: 'voice', timer: 3, maxDur: 60, eye: true, style: 'optique', pos: 70 };
const settings = Object.assign({}, DEFAULTS, LS.get('settings', {}));
const saveSettings = () => LS.set('settings', settings);
const ACCENTS = ['#7fe0c4', '#ffd84d', '#ff7a6b', '#7ab8ff', '#ffffff'];

let scripts = LS.get('scripts', null);
if (!scripts) {
  scripts = [{
    id: uid(), example: true, updated: Date.now(),
    title: 'דוגמה: ההוק הראשון',
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

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
const PREFIX = 'ובהלשמכ';
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const st = (s) => (s.length > 2 && PREFIX.includes(s[0]) ? s.slice(1) : s);
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
window.addEventListener('popstate', () => { if (current === 'review') Review.back(); else if (current !== 'home') goHome(); });
function goHome() { show('home', false); Home.render(); }
$$('[data-back]').forEach((b) => b.addEventListener('click', () => history.length > 1 ? history.back() : goHome()));

/* =========================================================
   בית
   ========================================================= */
const Home = {
  async render() {
    const segs = await DB.all();
    const by = {};
    segs.forEach((s) => { (by[s.sid] = by[s.sid] || { n: 0, d: 0 }); by[s.sid].n++; by[s.sid].d += s.dur; });
    scripts.sort((a, b) => b.updated - a.updated);
    $('#count-scripts').textContent = scripts.length ? scripts.length + '' : '';
    const ul = $('#scripts');
    if (!scripts.length) { ul.innerHTML = '<li class="empty">עוד אין תסריטים. התחילו בצילום חדש.</li>'; return; }
    ul.innerHTML = scripts.map((s) => {
      const w = parseScript(s.text).length;
      const d = by[s.id];
      const first = (s.text || '').replace(/[*/]/g, '').split('\n').find((l) => l.trim()) || 'תסריט ריק';
      return `<li><button class="script" data-id="${s.id}">
        <b>${esc(s.title || 'ללא שם')}</b>
        <span class="sub">${esc(first)}</span>
        <span class="meta">${d ? `<span class="badge draft">טיוטה · ${d.n} ${d.n === 1 ? 'קטע' : 'קטעים'} · ${fmt(d.d)}</span>` : s.example ? '<span class="badge example">דוגמה</span>' : ''}
        <span class="badge">${w} מילים</span></span>
      </button></li>`;
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
    show('editor');
    this.stats();
    const segs = await DB.bySid(id);
    const d = segs.reduce((a, x) => a + x.dur, 0);
    $('#ed-draft').textContent = segs.length ? ' · טיוטה ' + fmt(d) : '';
    if (fresh) setTimeout(() => $('#ed-text').focus(), 120);
  },
  save() {
    const s = scriptById(this.id); if (!s) return;
    s.title = $('#ed-title').value.trim(); s.text = $('#ed-text').value; s.updated = Date.now(); s.example = false;
    saveScripts();
  },
  stats() {
    const text = $('#ed-text').value;
    const w = parseScript(text);
    const sec = (w.length / settings.wpm) * 60;
    $('#ed-stats').textContent = w.length ? `${w.length} מילים · כ־${sec < 60 ? Math.round(sec) + ' שנ׳' : fmt(sec) + ' דק׳'}` : '';
    const warns = [];
    let cur = [];
    w.forEach((x) => { cur.push(x); if (x.end || x.brk) { if (cur.length > 20) warns.push(cur); cur = []; } });
    if (cur.length > 20) warns.push(cur);
    $('#ed-warn').innerHTML = warns.slice(0, 3).map((c) => `<li>המשפט שמתחיל ב״${esc(c.slice(0, 3).map((x) => x.text).join(' '))}…״ ארוך לנשימה אחת (${c.length} מילים). כדאי לפצל.</li>`).join('');
    $('#ed-shoot').disabled = !w.length;
  },
  wrap(before, after) {
    const ta = $('#ed-text'); const a = ta.selectionStart, b = ta.selectionEnd; const v = ta.value;
    const sel = v.slice(a, b) || 'מילה';
    ta.value = v.slice(0, a) + before + sel + after + v.slice(b);
    ta.focus(); ta.setSelectionRange(a + before.length, a + before.length + sel.length);
    this.save(); this.stats();
  },
};
let edT;
$('#ed-text').addEventListener('input', () => { clearTimeout(edT); edT = setTimeout(() => { Editor.save(); Editor.stats(); }, 250); });
$('#ed-title').addEventListener('input', () => Editor.save());
$('#ed-emph').addEventListener('click', () => Editor.wrap('*', '*'));
$('#ed-pause').addEventListener('click', () => {
  const ta = $('#ed-text'); const a = ta.selectionStart; const v = ta.value;
  ta.value = v.slice(0, a) + ' / ' + v.slice(a); ta.focus(); ta.setSelectionRange(a + 3, a + 3); Editor.save(); Editor.stats();
});
$('#ed-shoot').addEventListener('click', () => { Editor.save(); Shoot.open(Editor.id); });
$('#ed-to-import').addEventListener('click', () => { Editor.save(); Import.open(Editor.id); });
$('#ed-delete').addEventListener('click', (e) => armConfirm(e.currentTarget, 'הקשה נוספת תמחק את התסריט והטיוטה', async () => {
  scripts = scripts.filter((s) => s.id !== Editor.id); saveScripts(); await DB.delSid(Editor.id); goHome();
}));
leaveHooks.editor = () => { clearTimeout(edT); Editor.save(); };

/* =========================================================
   מצלמה ופרומפטר
   ========================================================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MODES = { voice: 'גלילה לפי הקול', auto: 'גלילה בקצב קבוע', manual: 'גלילה בהקשה' };
const MODE_L = { voice: 'קול', auto: 'קצב', manual: 'הקשה' };

function pickMime(kind) {
  if (!window.MediaRecorder) return '';
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (kind === 'export') list.unshift('video/mp4;codecs=avc1.640028,mp4a.40.2');
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}

const Shoot = {
  sid: null, W: [], p: 0, segs: [], stream: null, facing: 'user',
  rec: null, recording: false, rehearse: false, segStart: 0, w0: 0, chunks: [],
  eyeAcc: null, lines: [], spans: [], lineOf: [], loopOn: false,

  async open(sid) {
    this.sid = sid;
    const s = scriptById(sid);
    this.W = parseScript(s.text);
    this.segs = await DB.bySid(sid);
    this.p = this.segs.length ? this.segs[this.segs.length - 1].w1 : 0;
    this.skipEmpty();
    show('shoot');
    document.documentElement.style.setProperty('--accent', settings.accent);
    this.applyRail();
    this.layout();
    this.renderProgress();
    await this.startCam();
    Wake.on();
    if (settings.eye) Eye.load();
    this.startLoop();
    if (this.segs.length) toast(`ממשיכים מהטיוטה · ${this.segs.length} ${this.segs.length === 1 ? 'קטע' : 'קטעים'}`);
  },

  async startCam() {
    this.stopCam();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const v = $('#cam'); v.srcObject = this.stream; v.classList.toggle('mirror', this.facing === 'user');
      await v.play().catch(() => {});
      this.hint('', false);
    } catch (e) {
      console.warn(e);
      this.hint('אין גישה למצלמה או למיקרופון. אפשרו אותם בהגדרות הדפדפן ונסו שוב.', true);
    }
  },
  stopCam() { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; },

  /* ---------- פרומפטר ---------- */
  layout() {
    const fs = settings.fontSize; const lh = Math.round(fs * 1.55);
    const pr = $('#prompter'); pr.style.setProperty('--pfs', fs + 'px'); pr.style.setProperty('--plh', lh + 'px');
    const maxW = pr.clientWidth - 10;
    const c = document.createElement('canvas').getContext('2d');
    c.font = `600 ${fs}px "IBM Plex Sans Hebrew", sans-serif`;
    const sp = c.measureText(' ').width;
    const lines = []; let line = [], lw = 0;
    this.W.forEach((w, i) => {
      const ww = c.measureText(w.text + (w.brk ? ' ·' : '')).width;
      if (line.length && lw + sp + ww > maxW) { lines.push(line); line = []; lw = 0; }
      line.push(i); lw += (line.length > 1 ? sp : 0) + ww;
      if (w.end || w.brk) { lines.push(line); line = []; lw = 0; }
    });
    if (line.length) lines.push(line);
    this.lines = lines; this.lineOf = [];
    lines.forEach((l, li) => l.forEach((i) => (this.lineOf[i] = li)));
    $('#ptrack').innerHTML = lines.map((l) => '<div class="pl">' + l.map((i) => {
      const w = this.W[i];
      return `<span class="pw${w.emph ? ' emph' : ''}${w.brk ? ' brk' : ''}" data-i="${i}">${esc(w.text)}</span>`;
    }).join(' ') + '</div>').join('') + '<div class="pl"></div><div class="pl"></div>';
    this.spans = $$('#ptrack .pw'); this.lineEls = $$('#ptrack .pl');
    this.lh = lh; this.paint();
  },
  paint() {
    const p = this.p, N = this.W.length;
    this.spans.forEach((el, i) => { el.classList.toggle('said', i < p); el.classList.toggle('next', i === p); });
    const li = p >= N ? this.lines.length : this.lineOf[p];
    this.lineEls.forEach((el, k) => el.classList.toggle('cur', k === li));
    $('#ptrack').style.transform = `translateY(${(1 - li) * this.lh}px)`;
  },
  skipEmpty() { while (this.p < this.W.length && !this.W[this.p].norm) this.p++; },
  setPointer(p) { this.p = clamp(p, 0, this.W.length); this.skipEmpty(); this.paint(); },

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

  /* ---------- גלילה ---------- */
  voice: null, autoT: null, runStart: 0, runW0: 0,
  startScroll() {
    this.runStart = performance.now(); this.runW0 = this.p;
    if (settings.mode === 'voice') { if (!this.startVoice()) { settings.mode = 'auto'; this.applyRail(); toast('זיהוי קול לא זמין בדפדפן הזה. עברנו לגלילה בקצב קבוע.'); } }
    if (settings.mode === 'auto') this.autoNext(700);
  },
  stopScroll() { this.stopVoice(); clearTimeout(this.autoT); this.autoT = null; $('#mode-chip').hidden = true; },
  autoNext(delay) {
    clearTimeout(this.autoT);
    this.autoT = setTimeout(() => {
      if (this.p >= this.W.length) return;
      const w = this.W[this.p];
      this.setPointer(this.p + 1);
      const base = 60 / settings.wpm;
      let d = base * (0.55 + 0.45 * Math.min(2, (w.norm.length || 2) / 4));
      if (w.brk) d += 0.5; else if (w.end) d += 0.3; else if (/,$/.test(w.text)) d += 0.15;
      this.autoNext(d * 1000);
    }, delay);
  },
  startVoice() {
    if (!SR) return false;
    const self = this; const v = { active: true, base: [], off: 0, r: new SR() };
    const r = v.r; r.lang = 'he-IL'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const key = v.off + i; if (v.base[key] == null) v.base[key] = self.p;
        const np = self.matchFrom(v.base[key], e.results[i][0].transcript.split(/\s+/));
        if (np > self.p) self.setPointer(np);
      }
    };
    r.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') {
        v.active = false; settings.mode = 'auto'; self.applyRail();
        toast('הדפדפן לא מאפשר זיהוי קול במקביל לצילום. עברנו לגלילה בקצב קבוע.', 3600);
        if (self.recording || self.rehearsing) self.autoNext(300);
      }
    };
    r.onend = () => { if (v.active) { v.off += 1000; setTimeout(() => { if (v.active) try { r.start(); } catch (_) {} }, 120); } };
    try { r.start(); } catch (_) { return false; }
    this.voice = v;
    const mc = $('#mode-chip'); mc.innerHTML = '<i></i>מקשיב'; mc.hidden = false;
    return true;
  },
  stopVoice() { if (this.voice) { this.voice.active = false; try { this.voice.r.abort(); } catch (_) {} this.voice = null; } },

  /* ---------- הקלטה בקטעים ---------- */
  total() { return this.segs.reduce((a, s) => a + s.dur, 0); },
  async toggle() {
    if (this.counting) return;
    if (this.rehearse) return this.rehearsing ? this.stopRehearse() : this.startRehearse();
    if (this.recording) return this.stopSeg();
    if (!this.stream) { toast('המצלמה עוד לא פעילה'); return; }
    if (this.total() >= settings.maxDur - 0.3) { toast('הגעתם לאורך המקסימלי. אפשר לעבור לעריכה.'); return; }
    if (this.p >= this.W.length && this.W.length) { toast('הגעתם לסוף התסריט. הקישו על מילה כדי לחזור אליה.'); return; }
    await this.countdown();
    this.startSeg();
  },
  async countdown() {
    const n = settings.timer; if (!n) return;
    this.counting = true; const el = $('#countdown'); el.hidden = false;
    for (let i = n; i > 0; i--) { el.textContent = i; el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); await new Promise((r) => setTimeout(r, 900)); }
    el.hidden = true; this.counting = false;
  },
  startSeg() {
    const mime = pickMime('rec');
    try { this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined); }
    catch (e) { toast('ההקלטה לא נתמכת בדפדפן הזה'); return; }
    this.chunks = []; this.mime = this.rec.mimeType || mime || 'video/webm';
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.recording = true; this.segStart = performance.now(); this.w0 = this.p;
    this.eyeAcc = { sum: 0, n: 0 };
    this.disarm(); $('#sh-del').disabled = true;
    $('#s-shoot').classList.add('recording');
    this.startScroll();
  },
  stopSeg() {
    if (!this.recording) return Promise.resolve();
    const dur = (performance.now() - this.segStart) / 1000;
    this.recording = false; this.stopScroll();
    $('#s-shoot').classList.remove('recording');
    const rec = this.rec; const w0 = this.w0, w1 = this.p, eye = this.eyeAcc;
    const saved = new Promise((resolve) => {
      rec.onstop = async () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        if (dur < 0.4) { toast('הקטע קצר מדי ולא נשמר'); this.setPointer(w0); return resolve(); }
        const seg = { id: uid(), sid: this.sid, n: this.segs.length ? this.segs[this.segs.length - 1].n + 1 : 0, blob, dur, w0, w1, mime: this.mime, eye: eye.n ? Math.round(eye.sum / eye.n) : null };
        this.segs.push(seg); this.renderProgress(); await DB.put(seg); resolve();
      };
    });
    try { rec.stop(); } catch (_) {}
    $('#prog-live').style.width = '0';
    return saved;
  },
  renderProgress() {
    const max = settings.maxDur; const bar = $('#progress');
    $$('.prog-seg', bar).forEach((e) => e.remove());
    const live = $('#prog-live');
    this.segs.forEach((s) => { const d = document.createElement('div'); d.className = 'prog-seg'; d.style.width = (s.dur / max) * 100 + '%'; bar.insertBefore(d, live); });
    $('#sh-del').disabled = !this.segs.length || this.recording;
    $('#sh-done').disabled = !this.segs.length;
    this.timecode();
  },
  timecode(extra = 0) { $('#timecode').innerHTML = `${fmt(this.total() + extra)}<span> / ${fmt(settings.maxDur)}</span>`; },
  disarm() { const b = $('#sh-del'); if (b._armed) { clearTimeout(b._armed); b._armed = null; } b.classList.remove('armed'); $('#sh-del-l').textContent = 'מחיקה'; $$('.prog-seg').forEach((e) => e.classList.remove('armed')); },
  delLast() {
    if (!this.segs.length || this.recording) return;
    const b = $('#sh-del');
    if (!b._armed) {
      b.classList.add('armed'); $('#sh-del-l').textContent = 'למחוק?';
      const segs = $$('.prog-seg'); segs[segs.length - 1] && segs[segs.length - 1].classList.add('armed');
      b._armed = setTimeout(() => this.disarm(), 3000);
      return;
    }
    this.disarm();
    const s = this.segs.pop(); DB.del(s.id);
    this.setPointer(s.w0); this.renderProgress();
    toast('הקטע האחרון נמחק. הטקסט חזר לנקודה שבה התחיל.');
  },

  /* ---------- חזרה ---------- */
  startRehearse() { this.rehearsing = true; $('#s-shoot').classList.add('recording'); this.startScroll(); },
  stopRehearse() {
    this.rehearsing = false; this.stopScroll(); $('#s-shoot').classList.remove('recording');
    const min = (performance.now() - this.runStart) / 60000; const n = this.p - this.runW0;
    if (n > 4 && min > 0.05) {
      const wpm = Math.round(n / min);
      toast(`הקצב שלכם: ${wpm} מילים לדקה. ${wpm > 175 ? 'מהר. נסו לנשום בין המשפטים.' : wpm < 110 ? 'רגוע. אפשר להאיץ קצת.' : 'קצב טוב לרילס.'}`, 4200);
    }
  },

  /* ---------- לולאת מצב ---------- */
  startLoop() {
    if (this.loopOn) return; this.loopOn = true;
    let lastEye = 0, lastLight = 0;
    const lc = document.createElement('canvas'); lc.width = 32; lc.height = 18; const lctx = lc.getContext('2d', { willReadFrequently: true });
    const tick = (now) => {
      if (current !== 'shoot') { this.loopOn = false; return; }
      requestAnimationFrame(tick);
      const v = $('#cam');
      if (this.recording) {
        const live = (now - this.segStart) / 1000;
        $('#prog-live').style.width = (live / settings.maxDur) * 100 + '%';
        this.timecode(live);
        if (this.total() + live >= settings.maxDur) { this.stopSeg(); toast('הגעתם לאורך המקסימלי'); }
      }
      if (settings.eye && Eye.lm && now - lastEye > 140) {
        lastEye = now; Eye.sample(v);
        const chip = $('#eye-chip'); chip.hidden = false;
        if (Eye.score == null) { chip.querySelector('b').textContent = '--'; chip.className = 'hud-chip low'; }
        else {
          chip.querySelector('b').textContent = Eye.score + '%';
          chip.className = 'hud-chip' + (Eye.score < 60 ? ' bad' : Eye.score < 80 ? ' low' : '');
          if (this.recording) { this.eyeAcc.sum += Eye.score; this.eyeAcc.n++; }
        }
      } else if (!settings.eye) $('#eye-chip').hidden = true;
      if (!this.recording && now - lastLight > 700 && v.readyState >= 2 && this.stream) {
        lastLight = now;
        try {
          lctx.drawImage(v, 0, 0, 32, 18); const d = lctx.getImageData(8, 3, 16, 12).data; let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          const luma = sum / (d.length / 4);
          let msg = '';
          if (luma < 48) msg = 'חשוך מדי. פנו לחלון או למנורה.';
          else if (settings.eye && Eye.lm && !Eye.face) msg = 'לא רואים את הפנים. התקרבו למרכז.';
          else if (settings.eye && Eye.nose && (Eye.nose.x < 0.3 || Eye.nose.x > 0.7)) msg = 'זוזו קצת למרכז הפריים.';
          this.hint(msg);
        } catch (_) {}
      }
    };
    requestAnimationFrame(tick);
  },
  hint(msg, sticky) { if (sticky !== undefined) this._sticky = sticky ? msg : ''; const m = this._sticky || msg; const h = $('#hint-chip'); h.textContent = m; h.hidden = !m; },

  /* ---------- כלי צד ---------- */
  applyRail() {
    $('#sh-mode-l').textContent = MODE_L[settings.mode];
    $('#sh-size-l').textContent = settings.fontSize;
    $('#sh-timer-l').textContent = settings.timer ? settings.timer + ' שנ׳' : 'כבוי';
    $('#sh-len-l').textContent = settings.maxDur >= 60 ? settings.maxDur / 60 + ' דק׳' : settings.maxDur + ' שנ׳';
    $('#sh-eye').classList.toggle('on', settings.eye);
    $('#sh-rehearse').classList.toggle('on', this.rehearse);
    $('#s-shoot').classList.toggle('rehearse', this.rehearse);
    saveSettings();
  },

  leave() {
    if (this.recording) this.stopSeg();
    if (this.rehearsing) this.stopRehearse();
    this.stopScroll(); this.stopCam(); Wake.off();
    $('#cam').srcObject = null;
  },
};
leaveHooks.shoot = () => Shoot.leave();

$('#sh-rec').addEventListener('click', () => Shoot.toggle());
$('#sh-del').addEventListener('click', () => Shoot.delLast());
$('#sh-done').addEventListener('click', async () => { await Shoot.stopSeg(); Review.fromShoot(Shoot.sid); });
$('#sh-close').addEventListener('click', () => { const n = Shoot.segs.length; history.length > 1 ? history.back() : goHome(); if (n) toast('הטיוטה נשמרה'); });
$('#sh-flip').addEventListener('click', () => { if (Shoot.recording) return; Shoot.facing = Shoot.facing === 'user' ? 'environment' : 'user'; Shoot.startCam(); });
$('#sh-mode').addEventListener('click', () => {
  const order = ['voice', 'auto', 'manual'];
  settings.mode = order[(order.indexOf(settings.mode) + 1) % 3];
  if (settings.mode === 'voice' && !SR) { settings.mode = 'auto'; toast('זיהוי קול לא זמין בדפדפן הזה'); }
  Shoot.applyRail(); toast(MODES[settings.mode] + (settings.mode === 'manual' ? '. הקישו על הטקסט כדי להתקדם.' : ''));
});
$('#sh-size').addEventListener('click', () => { const o = [18, 22, 26, 30]; settings.fontSize = o[(o.indexOf(settings.fontSize) + 1) % o.length]; Shoot.applyRail(); Shoot.layout(); });
$('#sh-timer').addEventListener('click', () => { const o = [0, 3, 10]; settings.timer = o[(o.indexOf(settings.timer) + 1) % o.length]; Shoot.applyRail(); });
$('#sh-len').addEventListener('click', () => { const o = [15, 60, 180]; settings.maxDur = o[(o.indexOf(settings.maxDur) + 1) % o.length]; Shoot.applyRail(); Shoot.renderProgress(); });
$('#sh-rehearse').addEventListener('click', () => { if (Shoot.recording) return; Shoot.rehearse = !Shoot.rehearse; Shoot.applyRail(); toast(Shoot.rehearse ? 'מצב חזרה: הטקסט רץ בלי הקלטה' : 'חזרה לצילום'); });
$('#sh-eye').addEventListener('click', () => { settings.eye = !settings.eye; Shoot.applyRail(); if (settings.eye) { Eye.load(); toast('מד קשר עין פעיל'); } });
$('#prompter').addEventListener('click', (e) => {
  if (settings.mode === 'manual') {
    const li = Shoot.p >= Shoot.W.length ? Shoot.lines.length : Shoot.lineOf[Shoot.p];
    const next = Shoot.lines[li + 1]; Shoot.setPointer(next ? next[0] : Shoot.W.length); return;
  }
  const w = e.target.closest('.pw'); if (w) Shoot.setPointer(+w.dataset.i);
});
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
    const c = new Proxy({}, { get: (o, k) => o[k] || 0 }); r.faceBlendshapes[0].categories.forEach((x) => (c[x.categoryName] = x.score));
    const horiz = Math.max((c.eyeLookOutLeft + c.eyeLookInRight) / 2, (c.eyeLookInLeft + c.eyeLookOutRight) / 2);
    const down = (c.eyeLookDownLeft + c.eyeLookDownRight) / 2;
    const up = (c.eyeLookUpLeft + c.eyeLookUpRight) / 2;
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
   ניתוח קול: זיהוי דיבור ותזמון מילים
   ========================================================= */
let AC = null;
function audioCtx() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }

async function analyzeAudio(blob, fallbackDur) {
  try {
    const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
    const data = buf.getChannelData(0); const sr = buf.sampleRate; const hop = Math.round(sr * 0.02);
    const rms = [];
    for (let i = 0; i + hop <= data.length; i += hop) { let s = 0; for (let j = i; j < i + hop; j++) s += data[j] * data[j]; rms.push(Math.sqrt(s / hop)); }
    const sorted = rms.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor(clamp(p, 0, 0.999) * sorted.length)] || 0;
    const noise = q(0.15), peak = q(0.95);
    if (peak < 0.004) return { dur: buf.duration, ranges: [] };
    const thr = noise + (peak - noise) * 0.16;
    let ranges = []; let st = -1;
    rms.forEach((v, i) => { if (v > thr && st < 0) st = i; if (v <= thr && st >= 0) { ranges.push([st * 0.02, i * 0.02]); st = -1; } });
    if (st >= 0) ranges.push([st * 0.02, rms.length * 0.02]);
    const merged = [];
    for (const r of ranges) { const l = merged[merged.length - 1]; if (l && r[0] - l[1] < 0.22) l[1] = r[1]; else merged.push(r.slice()); }
    ranges = merged.filter((r) => r[1] - r[0] >= 0.1);
    return { dur: buf.duration, ranges };
  } catch (e) {
    console.warn('decode', e);
    return { dur: fallbackDur, ranges: [] };
  }
}

/* פיזור המילים על פני קטעי הדיבור לפי אורך כל מילה */
function alignWords(words, ranges, dur) {
  if (!words.length) return;
  if (!ranges.length) ranges = [[Math.min(0.15, dur * 0.05), Math.max(0.2, dur - 0.15)]];
  const total = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
  const weight = (w) => (w.norm.length || 1) + 1.6;
  const W = words.reduce((a, w) => a + weight(w), 0);
  let acc = 0;
  for (const w of words) {
    let pos = (acc / W) * total; acc += weight(w);
    let t = ranges[0][0];
    for (const r of ranges) { const len = r[1] - r[0]; if (pos <= len) { t = r[0] + pos; break; } pos -= len; t = r[1]; }
    w.t = t;
  }
}

function keepRanges(ranges, dur, trim) {
  if (!trim || !ranges.length) return [[0, dur]];
  const out = [];
  for (const r of ranges) {
    const a = Math.max(0, r[0] - 0.14), b = Math.min(dur, r[1] + 0.22);
    const l = out[out.length - 1];
    if (l && a - l[1] < 0.38) l[1] = b; else out.push([a, b]);
  }
  return out;
}

/* =========================================================
   עריכה ונגן
   ========================================================= */
const STYLES = {
  optique: { name: 'אופטיקה', size: 150, lh: 1.02, max: 3, chars: 16, font: (px) => `700 ${px}px Karantina, "IBM Plex Sans Hebrew", sans-serif` },
  brass: { name: 'פליז', size: 82, lh: 1.32, max: 4, chars: 22, font: (px) => `500 ${px}px "Frank Ruhl Libre", serif` },
  pearl: { name: 'פנינה', size: 94, lh: 1.24, max: 3, chars: 17, font: (px) => `${px}px "Suez One", serif` },
  clean: { name: 'נקי', size: 70, lh: 1.3, max: 5, chars: 26, font: (px) => `800 ${px}px Assistant, sans-serif` },
};

const R = {
  from: 'shoot', sid: null, clips: [], words: [], tl: [], total: 0, groups: [],
  style: settings.style, pos: settings.pos, trim: true, hook: true, hookText: '', brand: true, caps: true, eye: null,
};

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
}

function wrapItems(ctx, items, maxW, sp) {
  const lines = []; let line = [], lw = 0;
  for (const it of items) {
    const add = line.length ? sp + it.w : it.w;
    if (line.length && lw + add > maxW) { lines.push({ items: line, w: lw }); line = [it]; lw = it.w; }
    else { line.push(it); lw += add; }
  }
  if (line.length) lines.push({ items: line, w: lw });
  return lines;
}

/* מצייר קבוצת מילים בסגנון נתון. items: {text, emph, active, age, said} */
function drawGroup(ctx, W, H, items, styleKey, yc, accent, alpha = 1, scale) {
  const st = STYLES[styleKey]; const s = scale || W / 1080; const px = st.size * s;
  ctx.save();
  ctx.globalAlpha = alpha; ctx.font = st.font(px); ctx.textBaseline = 'middle'; ctx.direction = 'rtl'; ctx.textAlign = 'right';
  const sp = ctx.measureText(' ').width * (styleKey === 'optique' ? 1.5 : 1.05);
  items = items.map((it) => ({ ...it, w: ctx.measureText(it.text).width }));
  const lines = wrapItems(ctx, items, W * 0.84, sp);
  const LH = px * st.lh;
  let y = yc - ((lines.length - 1) * LH) / 2;
  const shadow = () => { ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 22 * s; ctx.shadowOffsetY = 4 * s; };
  const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
  for (const line of lines) {
    if (styleKey === 'clean') {
      noShadow(); ctx.fillStyle = 'rgba(8,10,12,.62)';
      const pad = 26 * s; rrect(ctx, W / 2 - line.w / 2 - pad, y - LH / 2 + 4 * s, line.w + pad * 2, LH - 8 * s, 18 * s); ctx.fill();
    }
    let x = W / 2 + line.w / 2;
    for (const it of line.items) {
      const cx = x - it.w / 2;
      const k = it.active ? clamp(it.age / 0.14, 0, 1) : 1;
      const sc = it.active ? 1.1 - 0.1 * (1 - Math.pow(1 - k, 3)) : 1;
      ctx.save(); ctx.translate(cx, y); ctx.scale(sc, sc); ctx.translate(-cx, -y);
      if (styleKey === 'optique') {
        if (it.active) {
          noShadow(); const pad = 16 * s; ctx.fillStyle = it.emph ? accent : '#ffffff';
          rrect(ctx, x - it.w - pad, y - px * 0.47, it.w + pad * 2, px * 0.9, 14 * s); ctx.fill();
          ctx.fillStyle = '#0b0e11';
        } else { shadow(); ctx.fillStyle = it.emph ? accent : '#ffffff'; }
        ctx.fillText(it.text, x, y + px * 0.04);
      } else if (styleKey === 'brass') {
        shadow(); ctx.fillStyle = it.active ? '#e9d3a6' : it.emph ? accent : '#f6efe2'; ctx.fillText(it.text, x, y);
        if (it.active) { noShadow(); ctx.fillStyle = '#e9d3a6'; ctx.fillRect(x - it.w, y + px * 0.5, it.w * k, 5 * s); }
      } else if (styleKey === 'pearl') {
        shadow();
        if (it.active) { const g = ctx.createLinearGradient(x - it.w, y - px / 2, x, y + px / 2); g.addColorStop(0, '#ffd2e6'); g.addColorStop(0.5, '#d4e6ff'); g.addColorStop(1, '#fff1c2'); ctx.fillStyle = g; }
        else ctx.fillStyle = it.emph ? accent : '#ffffff';
        ctx.fillText(it.text, x, y);
      } else {
        noShadow(); ctx.fillStyle = it.active ? accent : '#ffffff'; ctx.fillText(it.text, x, y);
        if (it.emph && !it.active) { ctx.fillStyle = accent; ctx.fillRect(x - it.w, y + px * 0.46, it.w, 4 * s); }
      }
      ctx.restore();
      x -= it.w + sp;
    }
    y += LH;
  }
  ctx.restore();
}

function drawHook(ctx, W, H, G, accent) {
  if (!R.hook || !R.hookText || G > 2.4) return;
  const s = W / 1080; const a = G < 2.1 ? 1 : clamp((2.4 - G) / 0.3, 0, 1);
  ctx.save(); ctx.globalAlpha = a;
  const px = 124 * s; ctx.font = `700 ${px}px Karantina, sans-serif`; ctx.textBaseline = 'middle'; ctx.direction = 'rtl'; ctx.textAlign = 'center';
  const words = R.hookText.split(/\s+/).filter(Boolean);
  const sp = ctx.measureText(' ').width * 1.4;
  const lines = wrapItems(ctx, words.map((t) => ({ text: t, w: ctx.measureText(t).width })), W * 0.84, sp);
  const LH = px * 1.0; let y = H * 0.2 - ((lines.length - 1) * LH) / 2;
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 28 * s; ctx.shadowOffsetY = 4 * s; ctx.fillStyle = '#fff';
  for (const l of lines) { ctx.fillText(l.items.map((i) => i.text).join(' '), W / 2, y); y += LH; }
  ctx.shadowColor = 'transparent'; ctx.fillStyle = accent;
  const bw = 110 * s * clamp(G / 0.5, 0, 1); ctx.fillRect(W / 2 - bw / 2, y - LH / 2 + 18 * s, bw, 8 * s);
  ctx.restore();
}

function drawBrand(ctx, W, H) {
  const h = (settings.handle || '').trim(); if (!R.brand || !h) return;
  const s = W / 1080; ctx.save();
  ctx.font = `600 ${32 * s}px "IBM Plex Sans Hebrew", sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.direction = hasHeb(h) ? 'rtl' : 'ltr'; ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 12 * s;
  ctx.fillText(h, W / 2, H * 0.935);
  ctx.restore();
}

function render(G, target) {
  const cv = target || $('#rv-canvas'); const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  if (G == null) G = Player.G();
  const v = Player.v;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (v && v.readyState >= 2 && v.videoWidth) {
    const sc = Math.max(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  const accent = settings.accent;
  drawHook(ctx, W, H, G, accent);
  if (R.caps) {
    const gi = groupAt(G);
    if (gi >= 0) {
      const gr = R.groups[gi]; const items = [];
      let act = -1; for (let i = gr.i0; i < gr.i1; i++) if (R.words[i].g <= G + 0.02) act = i;
      for (let i = gr.i0; i < gr.i1; i++) { const w = R.words[i]; items.push({ text: w.text, emph: w.emph, active: i === act, age: G - w.g }); }
      drawGroup(ctx, W, H, items, R.style, H * (R.pos / 100), accent, clamp((G - gr.start) / 0.08, 0, 1));
    }
  }
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
  const st = STYLES[R.style]; const out = []; let cur = null;
  R.words.forEach((w, i) => {
    const prev = R.words[i - 1];
    const brk = !cur || cur.n >= st.max || cur.chars + w.text.length > st.chars ||
      (prev && (prev.brk || prev.end)) || (prev && /[,:;]$/.test(prev.text) && cur.n >= 2) ||
      (prev && prev.clip !== w.clip) || (prev && w.g - prev.g > 1.1);
    if (brk) { cur = { i0: i, i1: i + 1, n: 1, chars: w.text.length, start: w.g }; out.push(cur); }
    else { cur.i1 = i + 1; cur.n++; cur.chars += w.text.length + 1; }
  });
  out.forEach((gr, j) => {
    const last = R.words[gr.i1 - 1]; const next = out[j + 1];
    const est = last.g + Math.max(0.4, last.text.length * 0.08) + 0.5;
    gr.end = next ? Math.min(next.start, est) : Math.min(R.total, est + 0.4);
    if (gr.end <= gr.start) gr.end = gr.start + 0.3;
  });
  R.groups = out;
}

const Player = {
  v: null, k: 0, playing: false, busy: false, hooks: null, target: null, onEnd: null, out: null, dest: null, src: null,
  init() {
    if (this.v) return;
    const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
    this.v = v;
  },
  audio() {
    if (this.src) { if (AC.state === 'suspended') AC.resume(); return; }
    const ctx = audioCtx(); if (ctx.state === 'suspended') ctx.resume();
    this.src = ctx.createMediaElementSource(this.v);
    this.out = ctx.createGain(); this.src.connect(this.out); this.out.connect(ctx.destination);
    this.dest = ctx.createMediaStreamDestination(); this.src.connect(this.dest);
  },
  async load(url) {
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
    render(G, this.target);
  },
  async play() {
    if (this.playing || !R.tl.length) return;
    this.audio();
    if (this.G() >= R.total - 0.08) await this.seek(0);
    this.playing = true; $('#stage').classList.add('playing');
    await this.v.play().catch(() => {});
    const loop = () => {
      if (!this.playing) return;
      requestAnimationFrame(loop);
      if (this.busy) return;
      const s = R.tl[this.k];
      if (this.v.currentTime >= s.b - 0.03 || this.v.ended) { this.advance(); return; }
      render(null, this.target);
      if (this.onFrame) this.onFrame();
    };
    requestAnimationFrame(loop);
  },
  pause() { this.playing = false; if (this.v) this.v.pause(); $('#stage').classList.remove('playing'); },
  async advance() {
    this.busy = true;
    const k = this.k + 1;
    if (k >= R.tl.length) { this.pause(); this.busy = false; render(R.total - 0.001, this.target); const f = this.onEnd; if (f) f(); return; }
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

const Review = {
  lastG: -1, lastGroup: -2,
  async fromShoot(sid) {
    const segs = await DB.bySid(sid); if (!segs.length) { toast('אין עדיין קטעים מצולמים'); return; }
    const W = parseScript(scriptById(sid).text);
    R.from = 'shoot'; R.sid = sid; R.trim = true; R.hook = true;
    R.clips = segs.map((s) => ({ blob: s.blob, dur: s.dur, url: URL.createObjectURL(s.blob), eye: s.eye }));
    // מילים לכל קטע לפי המיקום של הפרומפטר
    let tracked = segs.reduce((a, s) => a + Math.max(0, s.w1 - s.w0), 0);
    const assign = segs.map((s) => [s.w0, s.w1]);
    if (!tracked) { // לא נקלט מעקב, מחלקים את כל התסריט לפי אורך הקטעים
      const T = segs.reduce((a, s) => a + s.dur, 0); let acc = 0, i0 = 0;
      segs.forEach((s, i) => { acc += s.dur; const i1 = i === segs.length - 1 ? W.length : Math.round((acc / T) * W.length); assign[i] = [i0, i1]; i0 = i1; });
    } else {
      const last = assign[assign.length - 1];
      if (last[1] < W.length && last[1] >= W.length * 0.8) last[1] = W.length;
    }
    R.words = [];
    assign.forEach(([a, b], ci) => { for (let i = a; i < b; i++) if (W[i]) R.words.push({ ...W[i], clip: ci, t: 0 }); });
    const eyes = segs.filter((s) => s.eye != null);
    R.eye = eyes.length ? Math.round(eyes.reduce((a, s) => a + s.eye * s.dur, 0) / eyes.reduce((a, s) => a + s.dur, 0)) : null;
    $('#rv-title').textContent = scriptById(sid).title || 'עריכה';
    await this.open();
  },
  async fromImport(file, text, dur) {
    R.from = 'import'; R.sid = null; R.trim = false; R.hook = false; R.eye = null;
    R.clips = [{ blob: file, dur, url: URL.createObjectURL(file) }];
    R.words = parseScript(text).map((w) => ({ ...w, clip: 0, t: 0 }));
    $('#rv-title').textContent = file.name.replace(/\.[^.]+$/, '') || 'כתוביות';
    await this.open();
  },
  async open() {
    show('review');
    Player.init(); Player.target = null; Player.hooks = null; Player.onEnd = null; Player.onFrame = null;
    $('#rv-trim').checked = R.trim; $('#rv-hook').checked = R.hook; $('#rv-brand').checked = R.brand; $('#rv-caps').checked = R.caps;
    $('#rv-pos').value = R.pos;
    $('#rv-brand-l').textContent = settings.handle ? settings.handle : 'הוסיפו שם בהגדרות שבמסך הבית';
    const ey = $('#rv-eye'); ey.hidden = R.eye == null; if (R.eye != null) ey.textContent = 'קשר עין ' + R.eye + '%';
    const first = []; for (const w of R.words) { first.push(w.text); if (w.end || w.brk || first.length >= 7) break; }
    R.hookText = first.join(' ').replace(/[,.:;]$/, '');
    $('#rv-hook-text').value = R.hookText; $('#rv-hook-text').hidden = !R.hook;
    this.busy(true, 'מנתח את הקול…');
    await Promise.all([document.fonts.ready, ...Object.values(STYLES).map((s) => document.fonts.load(s.font(40), 'אבג')).concat(document.fonts.load('600 20px "IBM Plex Sans Hebrew"', 'אבג'))].map((p) => p.catch(() => {})));
    for (const [ci, c] of R.clips.entries()) {
      const a = await analyzeAudio(c.blob, c.dur);
      c.ranges = a.ranges; if (isFinite(a.dur) && a.dur > 0) c.dur = a.dur;
      alignWords(R.words.filter((w) => w.clip === ci), c.ranges, c.dur);
    }
    buildTimeline();
    this.styles(); this.groupsList();
    this.busy(false);
    await Player.seek(0);
  },
  busy(on, label) { $('#rv-busy').hidden = !on; if (label) $('#rv-busy-l').textContent = label; },
  ui(G) {
    if (Math.abs(G - this.lastG) > 0.05) {
      this.lastG = G;
      $('#rv-t').textContent = fmt(G); $('#rv-d').textContent = fmt(R.total);
      if (!this.scrubbing) $('#rv-seek').value = R.total ? Math.round((G / R.total) * 1000) : 0;
    }
    const gi = groupAt(G);
    if (gi !== this.lastGroup) {
      this.lastGroup = gi;
      $$('#groups .group').forEach((el, i) => el.classList.toggle('now', i === gi));
    }
  },
  styles() {
    const box = $('#styles');
    box.innerHTML = Object.entries(STYLES).map(([k, s]) => `<button class="style-card${k === R.style ? ' on' : ''}" data-k="${k}"><canvas width="216" height="200"></canvas><span>${s.name}</span></button>`).join('');
    $$('.style-card', box).forEach((b) => {
      const cv = b.querySelector('canvas'); const ctx = cv.getContext('2d');
      const items = [{ text: 'ככה', active: false }, { text: 'זה', active: true, age: 1 }, { text: 'נראה', emph: b.dataset.k !== 'optique', active: false }];
      drawGroup(ctx, 216, 200, items.map((x) => ({ ...x, age: 1 })), b.dataset.k, 92, settings.accent, 1, { optique: 0.36, brass: 0.5, pearl: 0.44, clean: 0.5 }[b.dataset.k]);
    });
  },
  groupsList() {
    $('#groups').innerHTML = R.groups.map((g, i) => {
      const txt = R.words.slice(g.i0, g.i1).map((w) => (w.emph ? '*' + w.text + '*' : w.text)).join(' ');
      return `<li class="group" data-i="${i}"><span class="mono">${fmt1(g.start)}</span><input value="${esc(txt)}" aria-label="טקסט הכתובית ${i + 1}" dir="rtl"><span class="nudge"><button data-d="-0.1" aria-label="מוקדם יותר">−</button><button data-d="0.1" aria-label="מאוחר יותר">+</button></span></li>`;
    }).join('');
    this.lastGroup = -2;
  },
  editGroup(i, text) {
    const g = R.groups[i]; if (!g) return;
    const nw = parseScript(text); const old = R.words.slice(g.i0, g.i1);
    const start = g.start, end = Math.max(g.end - 0.15, start + 0.3);
    const clip = old[0].clip;
    const Wt = nw.reduce((a, w) => a + (w.norm.length || 1) + 1.6, 0); let acc = 0;
    const words = nw.map((w) => { const G = start + (acc / Wt) * (end - start); acc += (w.norm.length || 1) + 1.6; const L = toLocal(G); return { ...w, clip: L.clip === clip ? clip : L.clip, t: L.t }; });
    R.words.splice(g.i0, g.i1 - g.i0, ...words);
    buildTimeline(); this.groupsList(); render(Player.G());
  },
  nudge(i, d) {
    const g = R.groups[i]; if (!g) return;
    const prev = R.groups[i - 1], next = R.groups[i + 1];
    const lo = prev ? prev.start + 0.1 : 0, hi = next ? next.start - 0.1 : R.total;
    const shift = clamp(g.start + d, lo, hi) - g.start; if (!shift) return;
    for (let k = g.i0; k < g.i1; k++) { const w = R.words[k]; const L = toLocal(clamp(w.g + shift, 0, R.total)); w.clip = L.clip; w.t = L.t; }
    buildTimeline(); this.groupsList(); Player.seek(R.groups[i] ? R.groups[i].start : 0);
  },
  back() {
    Player.pause();
    if (R.from === 'shoot' && R.sid) { Shoot.open(R.sid); }
    else { show('import', false); }
  },
  cleanup() { Player.pause(); },
};
leaveHooks.review = () => Review.cleanup();

$('#rv-back').addEventListener('click', () => Review.back());
$('#rv-play').addEventListener('click', () => Player.play());
$('#rv-canvas').addEventListener('click', () => (Player.playing ? Player.pause() : Player.play()));
$('#rv-seek').addEventListener('input', (e) => { Review.scrubbing = true; Player.pause(); const G = (e.target.value / 1000) * R.total; clearTimeout(Review._sk); Review._sk = setTimeout(() => Player.seek(G), 40); });
$('#rv-seek').addEventListener('change', () => (Review.scrubbing = false));
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
  $$('.panel').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
}));
$('#styles').addEventListener('click', (e) => {
  const b = e.target.closest('.style-card'); if (!b) return;
  R.style = settings.style = b.dataset.k; saveSettings();
  $$('.style-card').forEach((x) => x.classList.toggle('on', x === b));
  computeGroups(); Review.groupsList(); render(Player.G());
});
$('#rv-pos').addEventListener('input', (e) => { R.pos = settings.pos = +e.target.value; saveSettings(); if (!Player.playing) render(Player.G()); });
$('#rv-trim').addEventListener('change', async (e) => { const G = Player.G(); R.trim = e.target.checked; Player.pause(); buildTimeline(); Review.groupsList(); await Player.seek(Math.min(G, R.total)); toast(R.trim ? `השתיקות נחתכו. אורך הסרטון ${fmt(R.total)}` : `הסרטון המלא: ${fmt(R.total)}`); });
$('#rv-hook').addEventListener('change', (e) => { R.hook = e.target.checked; $('#rv-hook-text').hidden = !R.hook; Player.seek(0); });
$('#rv-hook-text').addEventListener('input', (e) => { R.hookText = e.target.value; if (!Player.playing) Player.seek(0.6); });
$('#rv-brand').addEventListener('change', (e) => { R.brand = e.target.checked; render(Player.G()); });
$('#rv-caps').addEventListener('change', (e) => { R.caps = e.target.checked; render(Player.G()); });
$('#groups').addEventListener('change', (e) => { const li = e.target.closest('.group'); if (li && e.target.tagName === 'INPUT') Review.editGroup(+li.dataset.i, e.target.value); });
$('#groups').addEventListener('click', (e) => {
  const li = e.target.closest('.group'); if (!li) return;
  const b = e.target.closest('button[data-d]'); const i = +li.dataset.i;
  if (b) { Review.nudge(i, +b.dataset.d); return; }
  if (e.target.tagName !== 'INPUT') Player.seek(R.groups[i].start + 0.01);
});

/* ---------- סנכרון בהקשות ---------- */
const TapSync = {
  i: 0, starts: [],
  async start() {
    if (!R.groups.length) return;
    this.i = 0; this.starts = [];
    $('#tapsync').hidden = false; this.paint();
    Player.pause(); await Player.seek(0);
    Player.onEnd = () => this.finish();
    Player.play();
  },
  paint() {
    const g = R.groups[this.i];
    $('#ts-step').textContent = `שורה ${Math.min(this.i + 1, R.groups.length)} מתוך ${R.groups.length}`;
    $('#ts-next').textContent = g ? R.words.slice(g.i0, g.i1).map((w) => w.text).join(' ') : 'סיימתם';
  },
  hit() {
    if (this.i >= R.groups.length) return;
    this.starts[this.i] = Player.G(); this.i++; this.paint();
    if (this.i >= R.groups.length) setTimeout(() => this.finish(), 600);
  },
  finish() {
    Player.onEnd = null; Player.pause(); $('#tapsync').hidden = true;
    if (!this.starts.length) return;
    const gs = R.groups.map((g) => ({ ...g }));
    gs.forEach((g, j) => {
      const S = this.starts[j]; if (S == null) return;
      const nextS = this.starts[j + 1] != null ? this.starts[j + 1] : g.end + (S - g.start);
      const words = R.words.slice(g.i0, g.i1);
      const span = Math.min(Math.max(0.3, nextS - S - 0.05), words.reduce((a, w) => a + w.text.length, 0) * 0.11 + 0.4);
      const Wt = words.reduce((a, w) => a + (w.norm.length || 1) + 1.6, 0); let acc = 0;
      words.forEach((w) => { const G = S + (acc / Wt) * span; acc += (w.norm.length || 1) + 1.6; const L = toLocal(G); w.clip = L.clip; w.t = L.t; });
    });
    buildTimeline(); Review.groupsList(); Player.seek(0);
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
  rec: null, cancelled: false, blob: null, url: null,
  async run() {
    if (!R.tl.length) return;
    if (!window.MediaRecorder) { toast('הדפדפן הזה לא תומך בייצוא וידאו'); return; }
    Player.pause(); Player.audio();
    const H = settings.quality === 720 ? 1280 : 1920, W = settings.quality === 720 ? 720 : 1080;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const prev = $('#rv-canvas'); const pctx = prev.getContext('2d');
    const stream = cv.captureStream(30);
    Player.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const mime = pickMime('export');
    this.cancelled = false; this.ui('run');
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: W === 1080 ? 12e6 : 6e6, audioBitsPerSecond: 160000 } : undefined); }
    catch (e) { toast('הייצוא נכשל בדפדפן הזה'); this.ui('close'); return; }
    this.rec = rec; const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    Player.target = cv; await Player.seek(0);
    Player.out.gain.value = 0;
    Wake.on();
    const done = new Promise((res) => { rec.onstop = res; });
    Player.hooks = { pause: () => { try { rec.state === 'recording' && rec.pause(); } catch (_) {} }, resume: () => { try { rec.state === 'paused' && rec.resume(); } catch (_) {} } };
    Player.onFrame = () => {
      pctx.drawImage(cv, 0, 0, prev.width, prev.height);
      const p = clamp(Player.G() / R.total, 0, 1); this.progress(p);
    };
    Player.onEnd = () => { setTimeout(() => { try { rec.state !== 'inactive' && rec.stop(); } catch (_) {} }, 250); };
    rec.start(500);
    await Player.play();
    await done;
    Player.hooks = null; Player.onFrame = null; Player.onEnd = null; Player.target = null; Player.out.gain.value = 1; Wake.off();
    render(Player.G());
    if (this.cancelled) { this.ui('close'); return; }
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    this.blob = new Blob(chunks, { type });
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(this.blob);
    this.ext = type.includes('mp4') ? 'mp4' : 'webm';
    this.progress(1); this.ui('done');
  },
  progress(p) { $('#ex-pct').textContent = Math.round(p * 100) + '%'; $('#ex-arc').style.strokeDashoffset = 276.5 * (1 - p); },
  ui(state) {
    const wrap = $('#exporter');
    if (state === 'close') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const done = state === 'done';
    $('#ex-ring').hidden = done; $('#ex-result').hidden = !done; $('#ex-actions').hidden = !done;
    $('#ex-h').textContent = done ? 'הסרטון מוכן' : 'מייצא את הסרטון';
    $('#ex-sub').textContent = done ? (this.ext === 'mp4' ? 'MP4 אנכי, מוכן לטיקטוק, לרילס ולשורטס.' : 'הקובץ נשמר בפורמט WebM. אם האפליקציה לא מקבלת אותו, ייצאו מ־Chrome מעודכן.') : 'הסרטון מתנגן ונצרב עם הכתוביות. השאירו את המסך פתוח.';
    $('#ex-close').textContent = done ? 'סגירה' : 'ביטול';
    if (done) {
      const v = $('#ex-result'); v.src = this.url;
      const name = `mabat-${new Date().toISOString().slice(0, 10)}.${this.ext}`;
      const a = $('#ex-download'); a.href = this.url; a.download = name;
      const file = new File([this.blob], name, { type: this.blob.type });
      $('#ex-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
      $('#ex-share').onclick = () => navigator.share({ files: [file], title: 'מבט' }).catch(() => {});
    } else this.progress(0);
  },
  cancel() {
    if (this.rec && this.rec.state !== 'inactive') { this.cancelled = true; Player.pause(); try { this.rec.stop(); } catch (_) {} }
    else { $('#ex-result').pause(); this.ui('close'); }
  },
};
$('#rv-export').addEventListener('click', () => Exporter.run());
$('#ex-close').addEventListener('click', () => Exporter.cancel());

/* =========================================================
   ייבוא סרטון קיים
   ========================================================= */
const Import = {
  file: null, dur: 0,
  open(sid) {
    show('import');
    const pick = $('#imp-pick');
    pick.innerHTML = '<option value="">מתסריט שמור…</option>' + scripts.filter((s) => s.text.trim()).map((s) => `<option value="${s.id}">${esc(s.title || 'ללא שם')}</option>`).join('');
    if (sid) { $('#imp-text').value = scriptById(sid).text; }
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
    if (this.dur > 180) toast('סרטון ארוך מ־3 דקות. הניתוח והייצוא ייקחו יותר זמן.');
    this.check();
  },
  check() { $('#imp-go').disabled = !(this.file && parseScript($('#imp-text').value).length); },
};
$('#imp-file').addEventListener('change', (e) => Import.setFile(e.target.files[0]));
$('#imp-text').addEventListener('input', () => Import.check());
$('#imp-pick').addEventListener('change', (e) => { const s = scriptById(e.target.value); if (s) { $('#imp-text').value = s.text; Import.check(); } e.target.value = ''; });
$('#imp-go').addEventListener('click', () => Review.fromImport(Import.file, $('#imp-text').value, Import.dur));
const drop = $('#drop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); }));
drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('video')) Import.setFile(f); });

/* =========================================================
   הגדרות
   ========================================================= */
function openSettings() {
  $('#set-handle').value = settings.handle;
  $('#set-accent').innerHTML = ACCENTS.map((c) => `<button class="swatch${c === settings.accent ? ' on' : ''}" style="background:${c}" data-c="${c}" aria-label="צבע ${c}"></button>`).join('');
  $$('#set-quality button').forEach((b) => b.classList.toggle('on', +b.dataset.v === settings.quality));
  $('#set-wpm').value = settings.wpm; $('#set-wpm-l').textContent = settings.wpm + ' מ׳/דק׳';
  $('#settings').hidden = false;
}
$('#btn-settings').addEventListener('click', openSettings);
$('#set-handle').addEventListener('input', (e) => { settings.handle = e.target.value; saveSettings(); });
$('#set-accent').addEventListener('click', (e) => { const b = e.target.closest('.swatch'); if (!b) return; settings.accent = b.dataset.c; saveSettings(); $$('.swatch').forEach((x) => x.classList.toggle('on', x === b)); });
$('#set-quality').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; settings.quality = +b.dataset.v; saveSettings(); $$('#set-quality button').forEach((x) => x.classList.toggle('on', x === b)); });
$('#set-wpm').addEventListener('input', (e) => { settings.wpm = +e.target.value; $('#set-wpm-l').textContent = settings.wpm + ' מ׳/דק׳'; saveSettings(); });
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) $('#settings').hidden = true; });

/* =========================================================
   התחלה
   ========================================================= */
document.documentElement.style.setProperty('--accent', settings.accent);
Home.render();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
