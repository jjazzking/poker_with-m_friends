'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Table } = require('./table');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6시간 동안 활동이 없으면 방 정리

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

app.get('/room/:id', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'room.html'));
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
  const me = table.players.get(ws.playerToken);
  if (!me) throw new Error('플레이어 정보를 찾을 수 없습니다');

  switch (msg.type) {
    case 'action':
      table.act(ws.playerToken, msg.action, msg.amount);
      break;

    case 'start':
      if (table.hostToken !== ws.playerToken) throw new Error('방장만 게임을 시작할 수 있습니다');
      if (table.status !== 'waiting') throw new Error('이미 게임이 진행 중입니다');
      table.startHand();
      break;

    case 'sitout':
      table.setSitOut(ws.playerToken, msg.value);
      break;

    case 'addChips':
      if (table.hostToken !== ws.playerToken && msg.target && msg.target !== ws.playerToken) {
        throw new Error('권한이 없습니다');
      }
      table.addChips(ws.playerToken, msg.amount);
      break;

    case 'autoNext':
      if (table.hostToken !== ws.playerToken) throw new Error('방장만 변경할 수 있습니다');
      table.autoNext = !!msg.value;
      table.pushLog(`자동 다음 핸드: ${table.autoNext ? '켜짐' : '꺼짐'}`);
      table.touch();
      break;

    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 120);
      if (!text) break;
      table.pushLog(`💬 ${me.name}: ${text}`);
      table.touch();
      break;
    }

    case 'leave':
      table.removePlayer(ws.playerToken);
      sockets.get(ws.roomId).delete(ws);
      ws.playerToken = null;
      broadcast(table.id);
      break;

    case 'ping':
      send(ws, { type: 'pong' });
      break;

    default:
      throw new Error('알 수 없는 요청입니다');
  }
}

/* 죽은 소켓 정리 + 빈 방 청소 */
setInterval(() => {
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
    if (empty && now - table.lastActivity > ROOM_TTL_MS) {
      table.clearTimers();
      rooms.delete(id);
      sockets.delete(id);
      console.log(`[room] ${id} 정리됨`);
    }
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`♠ 포커 서버 실행 중 → http://localhost:${PORT}`);
});

module.exports = { app, server, rooms };
