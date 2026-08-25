'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Table } = require('./table');
const { handleClientMessage } = require('./protocol');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6시간 동안 활동이 없으면 방 정리
const DISCONNECT_TIMEOUT_MS = 30000; // 응답 없는 소켓을 끊긴 것으로 판단하기까지의 시간
const HEARTBEAT_MS = DISCONNECT_TIMEOUT_MS / 2; // 핑 → 폰 대기 → 다음 핑에서 정리
const ROOM_SWEEP_MS = 30000; // 빈 방 청소 주기

const app = express();
app.use(express.json());

/** roomId -> Table */
const rooms = new Map();
/** roomId -> Set<ws> */
const sockets = new Map();

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

/* ----------------------------------------------------------------- HTTP */

app.post('/api/rooms', (req, res) => {
  const body = req.body || {};
  const bigBlind = clampInt(body.bigBlind, 2, 1000000, 100);
  const smallBlind = clampInt(body.smallBlind, 1, bigBlind, Math.max(1, Math.floor(bigBlind / 2)));
  const startingStack = clampInt(body.startingStack, bigBlind, 100000000, bigBlind * 100);
  const maxPlayers = clampInt(body.maxPlayers, 2, 9, 9);
  const actionTime = clampInt(body.actionTime, 0, 600, 60);
  const name = String(body.name || '친구들과 홀덤').slice(0, 24);

  const id = makeRoomCode();
  const table = new Table(
    id,
    { name, smallBlind, bigBlind, startingStack, maxPlayers, actionTime },
    () => broadcast(id)
  );
  rooms.set(id, table);
  sockets.set(id, new Set());

  res.json({
    roomId: id,
    config: table.config,
    url: `/room/${id}`,
  });
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
const wss = new WebSocketServer({ server, path: '/ws' });

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

  ws.on('close', () => {
    const table = rooms.get(ws.roomId);
    const set = sockets.get(ws.roomId);
    if (set) set.delete(ws);
    if (!table || !ws.playerToken) return;

    // 같은 토큰으로 다른 탭이 아직 붙어 있으면 연결 유지로 본다
    const stillHere = set && [...set].some((s) => s.playerToken === ws.playerToken);
    if (!stillHere) {
      table.setConnected(ws.playerToken, false);
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

  if (result.left) {
    const set = sockets.get(ws.roomId);
    if (set) set.delete(ws);
    ws.playerToken = null;
    broadcast(table.id);
  }
}

/* 죽은 소켓 정리 — 폰이 한 번 빠지면 정리하므로 최대 DISCONNECT_TIMEOUT_MS 안에 감지된다 */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS).unref();

/* 빈 방 청소 */
setInterval(() => {
  const now = Date.now();
  for (const [id, table] of rooms) {
    const set = sockets.get(id);
    const empty = !set || set.size === 0;
    if (empty && now - table.lastActivity > ROOM_TTL_MS) {
      table.dispose();
      rooms.delete(id);
      sockets.delete(id);
      console.log(`[room] ${id} 정리됨`);
    }
  }
}, ROOM_SWEEP_MS).unref();

server.listen(PORT, () => {
  console.log(`♠ 포커 서버 실행 중 → http://localhost:${PORT}`);
});

module.exports = { app, server, rooms };
