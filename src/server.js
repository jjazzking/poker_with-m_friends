'use strict';
/**
 * 중앙 서버. 모든 방의 딜러 역할을 이 프로세스가 맡는다.
 *
 * 정적 배포(GitHub Pages)에서 붙을 수 있도록 CORS를 열어 두고,
 * 재시작에 대비해 방 상태를 주기적으로 디스크에 저장한다.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Table } = require('./table');
const { handleClientMessage } = require('./protocol');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_HOURS || 24) * 60 * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const ROOMS_PER_IP = Number(process.env.ROOMS_PER_IP || 20); // 10분 창 기준
const SAVE_INTERVAL_MS = 15000;

// 비워 두면 모든 출처를 허용한다. 배포 후에는 Pages 주소만 남기는 편이 안전하다.
//   ALLOWED_ORIGINS=https://jjazzking.github.io
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const app = express();
app.set('trust proxy', 1); // Render/Fly 등 프록시 뒤에서 실제 IP를 얻기 위해
app.use(express.json({ limit: '16kb' }));

/** roomId -> Table */
const rooms = new Map();
/** roomId -> Set<ws> */
const sockets = new Map();

let dirty = false;
const markDirty = () => {
  dirty = true;
};

/* ------------------------------------------------------------------ CORS */

function originAllowed(origin) {
  if (!origin) return true; // 같은 출처 요청이나 curl 등
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(String(origin).replace(/\/$/, ''));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!originAllowed(origin)) return res.status(403).json({ error: '허용되지 않은 출처입니다' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ------------------------------------------------------------------ 유틸 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(I,O,0,1) 제외
function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeConfig(body = {}) {
  const bigBlind = clampInt(body.bigBlind, 2, 1000000, 100);
  const smallBlind = clampInt(body.smallBlind, 1, bigBlind, Math.max(1, Math.floor(bigBlind / 2)));
  return {
    name: String(body.name || '친구들과 홀덤').slice(0, 24),
    bigBlind,
    smallBlind,
    startingStack: clampInt(body.startingStack, bigBlind, 100000000, bigBlind * 100),
    maxPlayers: clampInt(body.maxPlayers, 2, 9, 9),
    actionTime: clampInt(body.actionTime, 0, 600, 60),
  };
}

function createTable(id, config) {
  const table = new Table(id, config, () => {
    markDirty();
    broadcast(id);
  });
  rooms.set(id, table);
  sockets.set(id, new Set());
  return table;
}

function dropRoom(id, reason) {
  const table = rooms.get(id);
  if (table) table.clearTimers();
  rooms.delete(id);
  sockets.delete(id);
  markDirty();
  console.log(`[room] ${id} 정리됨 (${reason})`);
}

function broadcast(roomId) {
  const table = rooms.get(roomId);
  const set = sockets.get(roomId);
  if (!table || !set) return;
  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(JSON.stringify(table.publicState(ws.playerToken)));
    } catch (_) {
      /* 소켓이 이미 닫힘 */
    }
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

/* ------------------------------------------------------- 방 생성 남용 방지 */

const RATE_WINDOW_MS = 10 * 60 * 1000;
const createdByIp = new Map(); // ip -> { count, resetAt }

function tooManyRooms(ip) {
  const now = Date.now();
  const entry = createdByIp.get(ip);
  if (!entry || now > entry.resetAt) {
    createdByIp.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ROOMS_PER_IP;
}

/* ----------------------------------------------------------------- HTTP */

// 무료 호스팅의 슬립 방지 핑과 배포 헬스체크가 함께 쓴다
app.get(['/healthz', '/api/health'], (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, t) => n + t.players.size, 0),
    uptime: Math.floor(process.uptime()),
  });
});

app.post('/api/rooms', (req, res) => {
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: '서버가 붐빕니다. 잠시 후 다시 시도해 주세요.' });
  }
  if (tooManyRooms(req.ip)) {
    return res.status(429).json({ error: '방을 너무 많이 만들었습니다. 잠시 후 다시 시도해 주세요.' });
  }

  const id = makeRoomCode();
  const table = createTable(id, normalizeConfig(req.body));
  markDirty();
  console.log(`[room] ${id} 생성됨 (${table.config.name})`);

  res.json({ roomId: id, config: table.config, url: `/room/${id}` });
});

app.get('/api/rooms/:id', (req, res) => {
  const table = rooms.get(String(req.params.id).toUpperCase());
  if (!table) return res.status(404).json({ error: '방을 찾을 수 없습니다' });
  res.json({
    roomId: table.id,
    config: table.config,
    players: table.players.size,
    status: table.status,
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// P2P 모드(정적 배포와 동일한 구성)를 로컬에서도 그대로 테스트할 수 있도록 함께 서빙한다
app.use('/engine', express.static(__dirname));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'peerjs', 'dist')));

// 예전 링크(/room/CODE) 호환 — 실제 방 주소는 해시 기반이라 정적 호스팅에서도 동작한다
app.get('/room/:id', (req, res) => {
  res.redirect(302, `/room.html#${encodeURIComponent(String(req.params.id).toUpperCase())}`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }) => originAllowed(origin),
});

/* ------------------------------------------------------------ WebSocket */

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;
  ws.playerToken = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    try {
      handleMessage(ws, msg);
    } catch (err) {
      send(ws, { type: 'error', message: err.message || '알 수 없는 오류' });
    }
  });

  ws.on('error', () => {
    /* 소켓 오류는 close 로 이어지므로 여기서는 크래시만 막는다 */
  });

  ws.on('close', () => {
    const table = rooms.get(ws.roomId);
    const set = sockets.get(ws.roomId);
    if (set) set.delete(ws);
    if (!table || !ws.playerToken) return;

    // 같은 토큰으로 다른 탭이 아직 붙어 있으면 연결 유지로 본다
    const stillHere = set && [...set].some((s) => s.playerToken === ws.playerToken);
    if (!stillHere) {
      table.setConnected(ws.playerToken, false);
      markDirty();
      broadcast(ws.roomId);
    }
  });
});

function handleMessage(ws, msg) {
  if (msg.type === 'join') {
    const roomId = String(msg.roomId || '').toUpperCase();
    const table = rooms.get(roomId);
    if (!table) {
      send(ws, { type: 'fatal', message: '방을 찾을 수 없습니다. 링크를 다시 확인해 주세요.' });
      return;
    }
    const token = String(msg.token || '').slice(0, 64) || crypto.randomUUID();
    const name = String(msg.name || '').trim().slice(0, 14) || '플레이어';

    const player = table.addPlayer(token, name);
    ws.roomId = roomId;
    ws.playerToken = token;
    sockets.get(roomId).add(ws);
    table.setConnected(token, true);

    send(ws, { type: 'joined', token, playerId: player.id, roomId });
    markDirty();
    broadcast(roomId);
    return;
  }

  const table = rooms.get(ws.roomId);
  if (!table || !ws.playerToken) throw new Error('먼저 방에 입장해 주세요');

  const result = handleClientMessage({
    table,
    token: ws.playerToken,
    msg,
    reply: (payload) => send(ws, payload),
  });

  markDirty();

  if (result.left) {
    const set = sockets.get(ws.roomId);
    if (set) set.delete(ws);
    ws.playerToken = null;
    broadcast(table.id);
  }
}

/* -------------------------------------------------------------- 영속화 */

function persist(force) {
  if (!dirty && !force) return;
  dirty = false;
  const payload = [...rooms.values()].map((table) => ({
    id: table.id,
    config: table.config,
    snapshot: table.snapshot(),
    lastActivity: table.lastActivity,
  }));
  store.save(payload);
}

function restoreRooms() {
  const saved = store.load();
  const now = Date.now();
  let restored = 0;

  for (const entry of saved) {
    const id = String(entry.id).toUpperCase();
    if (rooms.has(id) || rooms.size >= MAX_ROOMS) continue;
    if (now - (entry.lastActivity || 0) > ROOM_TTL_MS) continue; // 이미 만료된 방
    if (!Array.isArray(entry.snapshot.players) || entry.snapshot.players.length === 0) continue;

    try {
      const table = createTable(id, normalizeConfig(entry.config));
      table.restore(entry.snapshot);
      table.lastActivity = entry.lastActivity || now;
      restored += 1;
    } catch (err) {
      console.warn(`[store] ${id} 복원 실패:`, err.message);
      dropRoom(id, '복원 실패');
    }
  }

  if (restored) console.log(`[store] 방 ${restored}개 복원됨 (${store.FILE})`);
}

/* 죽은 소켓 정리 + 빈 방 청소 + 저장 */
const janitor = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();
  for (const [id, table] of rooms) {
    const set = sockets.get(id);
    const empty = !set || set.size === 0;
    if (empty && now - table.lastActivity > ROOM_TTL_MS) dropRoom(id, 'TTL 만료');
  }

  for (const [ip, entry] of createdByIp) {
    if (now > entry.resetAt) createdByIp.delete(ip);
  }
}, 30000);
janitor.unref();

const saver = setInterval(() => persist(false), SAVE_INTERVAL_MS);
saver.unref();

/* ---------------------------------------------------------- 종료 처리 */

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} 수신 — 상태를 저장하고 종료합니다`);

  clearInterval(janitor);
  clearInterval(saver);
  persist(true);

  for (const table of rooms.values()) table.clearTimers();
  for (const ws of wss.clients) {
    try {
      send(ws, { type: 'error', message: '서버가 재시작 중입니다. 곧 다시 연결됩니다…' });
      ws.close(1012, 'server restarting'); // 1012 = Service Restart
    } catch (_) {
      /* 이미 닫힘 */
    }
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ------------------------------------------------------------- 시작 */

if (require.main === module) {
  restoreRooms();
  server.listen(PORT, () => {
    console.log(`♠ 포커 서버 실행 중 → http://localhost:${PORT}`);
    console.log(`  상태 저장 위치: ${store.FILE}`);
    console.log(`  허용 출처: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(전체)'}`);
  });
}

module.exports = { app, server, rooms, sockets, createTable, restoreRooms, persist, normalizeConfig };
