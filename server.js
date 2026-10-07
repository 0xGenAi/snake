// Tweet Snake — one shared world for everyone who opens the embed.
// Authoritative server: clients send only direction + name, server simulates everything.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://snake.example.com

const W = 72, H = 72;            // world size in cells
const TICK_MS = 110;             // simulation speed
const START_LEN = 4;
const MIN_SNAKES = 4;            // bots fill the world up to this many snakes
const MAX_NAME = 14;

const COLORS = ['#7CFFB2', '#FFD166', '#FF6B9A', '#6BD3FF', '#C59BFF', '#FF9F5A', '#B6F36B', '#5AF0E0', '#FF7A7A', '#F2F2F2'];
const BOT_NAMES = ['noodle', 'byte', 'hiss', 'sssam', 'pixel', 'monty', 'kaa', 'slinky', 'zigzag', 'nagini_jr'];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

let nextId = 1;
const snakes = new Map();   // id -> snake
const food = new Map();     // "x,y" -> value
let events = [];            // kill feed for this tick
let tickNo = 0;

const key = (x, y) => x + ',' + y;
const rnd = (n) => Math.floor(Math.random() * n);

function occupied() {
  const s = new Set();
  for (const sn of snakes.values()) if (sn.alive) for (const c of sn.body) s.add(key(c.x, c.y));
  return s;
}

function freeCell(occ, margin = 0) {
  for (let i = 0; i < 500; i++) {
    const x = margin + rnd(W - margin * 2), y = margin + rnd(H - margin * 2);
    if (!occ.has(key(x, y)) && !food.has(key(x, y))) return { x, y };
  }
  return null;
}

function spawnSpot() {
  const occ = occupied();
  const heads = [...snakes.values()].filter(s => s.alive).map(s => s.body[0]);
  let best = null, bestD = -1;
  for (let i = 0; i < 40; i++) {
    const c = freeCell(occ, 8);
    if (!c) continue;
    const d = heads.length ? Math.min(...heads.map(h => Math.abs(h.x - c.x) + Math.abs(h.y - c.y))) : 99;
    if (d > bestD) { bestD = d; best = c; }
  }
  return best || { x: rnd(W), y: rnd(H) };
}

function makeSnake({ name, bot = false, ws = null }) {
  const id = nextId++;
  const sn = {
    id, name, bot, ws,
    color: COLORS[(id * 7) % COLORS.length],
    body: [], dir: 'right', queue: [], grow: 0,
    alive: false, score: 0, best: 0, kills: 0, deadAt: 0,
  };
  snakes.set(id, sn);
  return sn;
}

function spawn(sn) {
  const p = spawnSpot();
  const dirs = Object.keys(DIRS);
  // face toward the center so you don't spawn into a wall
  sn.dir = Math.abs(p.x - W / 2) > Math.abs(p.y - H / 2) ? (p.x > W / 2 ? 'left' : 'right') : (p.y > H / 2 ? 'up' : 'down');
  const [dx, dy] = DIRS[sn.dir];
  sn.body = [];
  for (let i = 0; i < START_LEN; i++) sn.body.push({ x: p.x - dx * i, y: p.y - dy * i });
  sn.body = sn.body.map(c => ({ x: Math.max(0, Math.min(W - 1, c.x)), y: Math.max(0, Math.min(H - 1, c.y)) }));
  sn.queue = []; sn.grow = 0; sn.score = 0; sn.kills = 0; sn.alive = true;
  void dirs;
}

function kill(sn, killer, reason) {
  if (!sn.alive) return;
  sn.alive = false;
  sn.deadAt = Date.now();
  sn.best = Math.max(sn.best, sn.score);
  // body turns into food
  sn.body.forEach((c, i) => {
    if (i % 2 === 0 && c.x >= 0 && c.y >= 0 && c.x < W && c.y < H) food.set(key(c.x, c.y), 2);
  });
  if (killer && killer !== sn) { killer.kills++; events.push({ t: 'kill', a: killer.name, b: sn.name, ac: killer.color, bc: sn.color }); }
  else events.push({ t: 'die', b: sn.name, bc: sn.color, r: reason });
  if (sn.ws) send(sn.ws, { type: 'dead', score: sn.score, best: sn.best, by: killer && killer !== sn ? killer.name : null, reason });
}

function topUpFood() {
  const alive = [...snakes.values()].filter(s => s.alive).length;
  const target = 90 + alive * 6;
  if (food.size >= target) return;
  const occ = occupied();
  for (let i = food.size; i < target; i++) {
    const c = freeCell(occ);
    if (c) food.set(key(c.x, c.y), Math.random() < 0.08 ? 3 : 1);
  }
}

// --- bots: greedy toward nearest food, never step into an obvious death ---
function botThink(sn, occ) {
  const h = sn.body[0];
  const safe = (d) => {
    const [dx, dy] = DIRS[d];
    const x = h.x + dx, y = h.y + dy;
    return x >= 0 && y >= 0 && x < W && y < H && !occ.has(key(x, y));
  };
  const room = (d) => { // tiny flood fill so bots don't trap themselves
    const [dx, dy] = DIRS[d];
    const start = { x: h.x + dx, y: h.y + dy };
    const seen = new Set([key(start.x, start.y)]); const st = [start]; let n = 0;
    while (st.length && n < 40) {
      const c = st.pop(); n++;
      for (const [ax, ay] of Object.values(DIRS)) {
        const x = c.x + ax, y = c.y + ay, k = key(x, y);
        if (x < 0 || y < 0 || x >= W || y >= H || occ.has(k) || seen.has(k)) continue;
        seen.add(k); st.push({ x, y });
      }
    }
    return n;
  };
  let target = null, bd = 1e9;
  for (const k of food.keys()) {
    const [x, y] = k.split(',').map(Number);
    const d = Math.abs(x - h.x) + Math.abs(y - h.y);
    if (d < bd) { bd = d; target = { x, y }; }
  }
  const options = Object.keys(DIRS).filter(d => d !== OPP[sn.dir] && safe(d));
  if (!options.length) return;
  options.sort((a, b) => {
    const ra = room(a), rb = room(b);
    if ((ra < 20) !== (rb < 20)) return ra < 20 ? 1 : -1;
    if (!target) return 0;
    const da = Math.abs(h.x + DIRS[a][0] - target.x) + Math.abs(h.y + DIRS[a][1] - target.y);
    const db = Math.abs(h.x + DIRS[b][0] - target.x) + Math.abs(h.y + DIRS[b][1] - target.y);
    return da - db;
  });
  if (Math.random() < 0.03 && options.length > 1) options.reverse(); // a little chaos
  sn.queue = [options[0]];
}

function balanceBots() {
  const humans = [...snakes.values()].filter(s => !s.bot);
  const bots = [...snakes.values()].filter(s => s.bot);
  const wanted = Math.max(0, MIN_SNAKES - humans.filter(h => h.alive).length);
  while (bots.length < wanted) {
    const used = new Set([...snakes.values()].map(x => x.name));
    const free = BOT_NAMES.map(n => n + ' 🤖').filter(n => !used.has(n));
    const b = makeSnake({ name: free.length ? free[rnd(free.length)] : 'bot ' + nextId, bot: true });
    spawn(b); bots.push(b);
  }
  while (bots.length > wanted) { const b = bots.pop(); snakes.delete(b.id); }
  for (const b of bots) if (!b.alive && Date.now() - b.deadAt > 2500) spawn(b);
}

function tick() {
  tickNo++;
  events = [];
  balanceBots();

  const live = [...snakes.values()].filter(s => s.alive);
  const occBefore = occupied();
  for (const sn of live) if (sn.bot) botThink(sn, occBefore);

  // 1. move heads
  for (const sn of live) {
    while (sn.queue.length) {
      const d = sn.queue.shift();
      if (d !== OPP[sn.dir] && d !== sn.dir) { sn.dir = d; break; }
    }
    const [dx, dy] = DIRS[sn.dir];
    const h = sn.body[0];
    sn.body.unshift({ x: h.x + dx, y: h.y + dy });
    const fk = key(sn.body[0].x, sn.body[0].y);
    if (food.has(fk)) { const v = food.get(fk); sn.grow += v; sn.score += v; food.delete(fk); }
    if (sn.grow > 0) sn.grow--; else sn.body.pop();
  }

  // 2. collisions (against the post-move world)
  const cells = new Map(); // key -> [{sn, i}]
  for (const sn of live) sn.body.forEach((c, i) => {
    const k = key(c.x, c.y);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push({ sn, i });
  });
  const deaths = [];
  for (const sn of live) {
    const h = sn.body[0];
    if (h.x < 0 || h.y < 0 || h.x >= W || h.y >= H) { deaths.push([sn, null, 'wall']); continue; }
    const here = cells.get(key(h.x, h.y)).filter(o => !(o.sn === sn && o.i === 0));
    if (!here.length) continue;
    const other = here[0];
    if (other.sn === sn) deaths.push([sn, null, 'self']);
    else if (other.i === 0) deaths.push([sn, other.sn.body.length > sn.body.length ? other.sn : null, 'head']);
    else deaths.push([sn, other.sn, 'body']);
  }
  for (const [sn, by, r] of deaths) kill(sn, by, r);

  topUpFood();
  for (const sn of snakes.values()) if (sn.alive) sn.best = Math.max(sn.best, sn.score);
  broadcast();
}

// --- networking ---
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function snapshot() {
  const s = [];
  for (const sn of snakes.values()) {
    if (!sn.alive) continue;
    const flat = new Array(sn.body.length * 2);
    sn.body.forEach((c, i) => { flat[i * 2] = c.x; flat[i * 2 + 1] = c.y; });
    s.push({ id: sn.id, n: sn.name, c: sn.color, b: flat, d: sn.dir, sc: sn.score, bot: sn.bot ? 1 : 0 });
  }
  const f = [];
  for (const [k, v] of food) { const [x, y] = k.split(','); f.push(+x, +y, v); }
  const board = [...snakes.values()].filter(x => x.alive).sort((a, b) => b.score - a.score).slice(0, 5)
    .map(x => ({ n: x.name, sc: x.score, c: x.color }));
  const humans = [...snakes.values()].filter(x => !x.bot).length;
  return { type: 'state', t: tickNo, W, H, s, f, board, online: humans, ev: events };
}

function broadcast() {
  const msg = JSON.stringify(snapshot());
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// --- http: static files + X player-card meta injected with absolute URLs ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return proto + '://' + req.headers.host;
}

const indexTpl = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  if (p === '/health') { res.writeHead(200); return res.end('ok'); }
  if (p === '/' || p === '/play' || p === '/embed') {
    const base = baseUrl(req);
    const html = indexTpl.replaceAll('__BASE__', base);
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      // must be framable by X, otherwise the player card stays blank
      'Content-Security-Policy': "frame-ancestors *",
      'Cache-Control': 'no-cache',
    });
    return res.end(html);
  }
  const file = path.normalize(path.join(__dirname, 'public', p));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws) => {
  let me = null;
  let msgs = 0; const rate = setInterval(() => { msgs = 0; }, 1000);
  send(ws, { type: 'hello', W, H, tick: TICK_MS });
  ws.send(JSON.stringify(snapshot()));

  ws.on('message', (raw) => {
    if (++msgs > 40) return; // flood guard
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const name = String(m.name || '').replace(/[^\p{L}\p{N}_ .\-]/gu, '').trim().slice(0, MAX_NAME) || 'anon';
      if (!me) me = makeSnake({ name, ws });
      me.name = name;
      if (!me.alive) spawn(me);
      send(ws, { type: 'you', id: me.id, color: me.color });
    } else if (m.type === 'dir' && me && me.alive && DIRS[m.d]) {
      if (me.queue.length < 3) me.queue.push(m.d);
    }
  });
  ws.on('close', () => {
    clearInterval(rate);
    if (me) { if (me.alive) kill(me, null, 'left'); snakes.delete(me.id); }
  });
});

setInterval(tick, TICK_MS);
server.listen(PORT, () => console.log(`Tweet Snake on :${PORT}  (world ${W}x${H}, tick ${TICK_MS}ms)`));
