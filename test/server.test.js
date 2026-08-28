'use strict';
/**
 * 중앙 서버 검증 테스트.
 *   node test/server.test.js
 *
 * 실제로 포트를 열고 HTTP·WebSocket 으로 붙어 본다.
 * 저장 경로는 임시 디렉터리로 돌려 두어 개발 환경을 건드리지 않는다.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ALLOWED_ORIGINS = 'https://allowed.example';
process.env.DISCONNECT_GRACE_SEC = '1'; // 테스트가 오래 걸리지 않도록 짧게

const WebSocket = require('ws');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push(name);
    console.error('  ✗ ' + name + '\n    ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  }
}

/** 조건이 만족될 때까지 기다린다 (기본 3초) */
function waitFor(predicate, message, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('시간 초과: ' + message));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

(async () => {
  const srv = require('../src/server');
  const port = await listen(srv.server);
  const base = `http://127.0.0.1:${port}`;

  console.log('\n중앙 서버');

  await test('헬스체크가 상태를 돌려준다', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.rooms, 'number');
  });

  let roomId = null;

  await test('방을 만들면 코드와 정규화된 설정이 돌아온다', async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 일부러 범위를 벗어난 값을 넣어 clamp 가 도는지 함께 본다
      body: JSON.stringify({ name: '테스트룸', bigBlind: 100, smallBlind: 999, maxPlayers: 99 }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.roomId, /^[A-Z2-9]{6}$/, '6자리 방 코드여야 한다');
    assert.strictEqual(body.config.smallBlind, 100, 'SB 는 BB 를 넘을 수 없다');
    assert.strictEqual(body.config.maxPlayers, 9, '최대 인원은 9명으로 제한된다');
    roomId = body.roomId;
  });

  await test('없는 방을 물으면 404 다', async () => {
    const res = await fetch(`${base}/api/rooms/ZZZZZZ`);
    assert.strictEqual(res.status, 404);
  });

  await test('허용된 출처에는 CORS 헤더가 붙는다', async () => {
    const res = await fetch(`${base}/api/rooms/${roomId}`, {
      headers: { Origin: 'https://allowed.example' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });

  await test('허용되지 않은 출처는 403 으로 막는다', async () => {
    const res = await fetch(`${base}/api/rooms/${roomId}`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.strictEqual(res.status, 403);
  });

  await test('프리플라이트(OPTIONS)에 204 로 답한다', async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://allowed.example');
  });

  await test('허용되지 않은 출처의 WebSocket 은 거절한다', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const outcome = await new Promise((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('rejected'));
      ws.on('unexpected-response', () => resolve('rejected'));
    });
    assert.strictEqual(outcome, 'rejected');
  });

  await test('두 명이 붙으면 서로의 상태를 받는다', async () => {
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const states = { a: [], b: [] };

    const connect = (who, token, name) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { origin: 'https://allowed.example' });
        ws.on('error', reject);
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'state') states[who].push(msg);
        });
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join', roomId, token, name }));
          resolve(ws);
        });
      });

    const a = await connect('a', 'token-a', '앨리스');
    await waitFor(() => states.a.length > 0, '앨리스가 첫 상태를 받아야 한다');

    const b = await connect('b', 'token-b', '밥');
    await waitFor(() => states.b.length > 0, '밥이 첫 상태를 받아야 한다');
    // 밥이 들어오면 앨리스에게도 갱신된 상태가 방송된다
    await waitFor(
      () => states.a[states.a.length - 1].players.length === 2,
      '앨리스 화면에 두 명이 보여야 한다'
    );

    const last = states.b[states.b.length - 1];
    assert.strictEqual(last.room.name, '테스트룸');
    const me = last.players.find((p) => p.isMe);
    assert.strictEqual(me.name, '밥');
    assert.strictEqual(me.isHost, false, '먼저 들어온 앨리스가 방장이다');
    assert.ok(last.players.find((p) => p.name === '앨리스').isHost, '앨리스가 방장이어야 한다');

    // 방장(먼저 들어온 앨리스)만 게임을 시작할 수 있다
    const errors = [];
    b.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error') errors.push(msg.message);
    });
    b.send(JSON.stringify({ type: 'start' }));
    await waitFor(() => errors.length > 0, '방장이 아니면 거절당해야 한다');
    assert.match(errors[0], /방장만/);

    a.close();
    b.close();
    await waitFor(
      () => a.readyState === WebSocket.CLOSED && b.readyState === WebSocket.CLOSED,
      '소켓이 닫혀야 한다'
    );
  });

  await test('연결이 끊기면 표시됐다가 유예 시간 뒤 자리비움 처리된다', async () => {
    const table = srv.rooms.get(roomId);
    assert.ok(table, '방이 살아 있어야 한다');
    assert.strictEqual(table.players.size, 2, '끊기자마자 사라지지는 않는다');

    // 서버가 close 를 처리할 때까지 잠깐 기다린다
    await waitFor(
      () => [...table.players.values()].every((p) => !p.connected),
      '끊긴 플레이어는 연결 해제로 표시된다'
    );
    assert.ok(
      [...table.players.values()].every((p) => p.dropAt > Date.now() - 1000),
      '자리비움 예정 시각이 잡혀야 한다'
    );

    await waitFor(
      () => [...table.players.values()].every((p) => p.sittingOut),
      '유예 시간이 지나면 자리비움 처리된다',
      6000
    );
    // 자리와 스택은 남겨 둬야 돌아왔을 때 이어서 칠 수 있다
    assert.strictEqual(table.players.size, 2, '자리에서 빼지는 않는다');
  });

  await test('돌아오면 자리를 지킨다', async () => {
    const create = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '복귀테스트' }),
    });
    const { roomId: rid } = await create.json();

    const connect = () =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://allowed.example' });
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join', roomId: rid, token: 'back', name: '다시온사람' }));
          resolve(ws);
        });
      });

    const first = await connect();
    const table = srv.rooms.get(rid);
    await waitFor(() => table.players.size === 1, '입장해야 한다');

    first.close(); // 새로고침을 흉내 낸다
    await waitFor(() => !table.players.get('back').connected, '끊김으로 표시된다');

    const second = await connect(); // 유예 시간 안에 복귀
    await waitFor(() => table.players.get('back').connected, '다시 연결되어야 한다');
    assert.strictEqual(table.players.get('back').dropAt, null, '자리비움 예약이 취소되어야 한다');

    await new Promise((r) => setTimeout(r, 1500)); // 원래 유예 시간이 지나도
    assert.ok(table.players.has('back'), '돌아온 사람을 쫓아내면 안 된다');

    second.close();
    table.dispose();
    srv.rooms.delete(rid);
    srv.sockets.delete(rid);
  });

  await test('방장이 내보내면 연결이 끊기고 다시 들어올 수 없다', async () => {
    const create = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '강퇴테스트' }),
    });
    const { roomId: rid } = await create.json();

    const inbox = { host: [], guest: [] };
    const connect = (who, token, name) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://allowed.example' });
        ws.on('error', reject);
        ws.on('message', (raw) => inbox[who].push(JSON.parse(raw.toString())));
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'join', roomId: rid, token, name }));
          resolve(ws);
        });
      });

    const host = await connect('host', 'kick-host', '방장');
    const guest = await connect('guest', 'kick-guest', '손님');
    const table = srv.rooms.get(rid);
    await waitFor(() => table.players.size === 2, '둘 다 입장해야 한다');

    const guestId = table.players.get('kick-guest').id;
    host.send(JSON.stringify({ type: 'kick', playerId: guestId }));

    await waitFor(() => inbox.guest.some((m) => m.type === 'fatal'), '내보낸 사람에게 이유가 전달된다');
    assert.match(inbox.guest.find((m) => m.type === 'fatal').message, /내보냈습니다/);
    await waitFor(() => guest.readyState === WebSocket.CLOSED, '연결이 끊겨야 한다');
    assert.ok(!table.players.has('kick-guest'), '자리에서 빠져야 한다');

    // 같은 토큰으로 다시 붙어도 입장이 막힌다
    inbox.guest.length = 0;
    const again = await connect('guest', 'kick-guest', '손님');
    await waitFor(() => inbox.guest.some((m) => m.type === 'fatal'), '재입장은 막힌다');
    assert.strictEqual(table.players.size, 1, '다시 앉지 못한다');

    again.close();
    host.close();
    table.dispose();
    srv.rooms.delete(rid);
    srv.sockets.delete(rid);
  });

  await test('저장한 방을 재시작 후 복원한다', async () => {
    // 앞선 테스트에 기대지 않도록 이 테스트만의 방을 새로 만든다
    const create = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '복원테스트' }),
    });
    const { roomId: rid } = await create.json();

    const table = srv.rooms.get(rid);
    table.addPlayer('keep-a', '앨리스');
    table.addPlayer('keep-b', '밥');
    table.setConnected('keep-a', true);
    table.setConnected('keep-b', true);

    srv.persist(true);
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rooms.json'), 'utf8'));
    assert.strictEqual(saved.version, 1);
    const entry = saved.rooms.find((r) => r.id === rid);
    assert.ok(entry, '만든 방이 저장본에 있어야 한다');
    assert.strictEqual(entry.snapshot.players.length, 2);

    // 프로세스가 죽었다 살아난 상황을 흉내 낸다
    const before = entry.snapshot.players.map((p) => `${p.name}:${p.stack}`).sort();
    table.dispose();
    srv.rooms.delete(rid);
    srv.sockets.delete(rid);

    srv.restoreRooms();

    const restored = srv.rooms.get(rid);
    assert.ok(restored, '방이 복원되어야 한다');
    const after = [...restored.players.values()].map((p) => `${p.name}:${p.stack}`).sort();
    assert.deepStrictEqual(after, before, '이름과 스택이 그대로여야 한다');
    assert.strictEqual(restored.config.name, '복원테스트');

    // 복원된 사람은 끊긴 상태다. 돌아오지 않으면 자리비움이 되지만
    // 자리와 스택은 남으므로, 돌아올 틈도 없이 테이블이 비어 버리지는 않는다.
    assert.ok(
      [...restored.players.values()].every((p) => !p.connected),
      '복원 직후에는 아직 아무도 붙어 있지 않다'
    );
  });

  for (const table of srv.rooms.values()) table.clearTimers();
  srv.server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(`\n${passed}개 테스트 통과${failures.length ? ` (실패: ${failures.join(', ')})` : ''}\n`);
  process.exit(process.exitCode || 0);
})();
