'use strict';
/**
 * 포커 엔진 검증 테스트.
 *   node test/engine.test.js
 */
const assert = require('assert');
const { Table } = require('../src/table');
const { evaluateBest, compareHands, newShuffledDeck, cardCode } = require('../src/poker');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
  }
}

const C = (s) => ({ r: { T: 10, J: 11, Q: 12, K: 13, A: 14 }[s[0]] || Number(s[0]), s: s[1] });
const hand = (...codes) => evaluateBest(codes.map(C));

function makeTable(overrides = {}) {
  return new Table('TEST01', {
    name: '테스트',
    smallBlind: 50,
    bigBlind: 100,
    startingStack: 10000,
    maxPlayers: 9,
    actionTime: 0,
    showdownDelay: 0,
    foldDelay: 0,
    runoutDelay: 0,
    ...overrides,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/* ------------------------------------------------------- 핸드 평가 */

console.log('\n핸드 평가');

test('로열 플러시 인식', () => {
  assert.strictEqual(hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2h', '3d').name, '로열 플러시');
});
test('휠 스트레이트(A-2-3-4-5)', () => {
  const h = hand('Ah', '2c', '3d', '4s', '5h', 'Kc', '9d');
  assert.strictEqual(h.name, '스트레이트');
  assert.strictEqual(h.tb[0], 5);
});
test('포카드 > 풀하우스', () => {
  const quads = hand('2h', '2d', '2c', '2s', '5d', '9c', 'Kc');
  const boat = hand('Ah', 'Ad', 'Kc', 'Kh', 'Ks', '9c', '2c');
  assert.ok(compareHands(quads, boat) > 0);
});
test('같은 페어는 키커로 결정', () => {
  const a = hand('Ah', 'Ad', 'Kc', '7h', '9s', '3c', '2d');
  const b = hand('As', 'Ac', 'Qc', '7h', '9s', '3c', '2d');
  assert.ok(compareHands(a, b) > 0);
});
test('완전히 동일한 핸드는 무승부', () => {
  const a = hand('Ah', 'Kd', 'Qc', 'Jh', 'Ts', '3c', '2d');
  const b = hand('As', 'Kc', 'Qd', 'Js', 'Th', '3c', '2d');
  assert.strictEqual(compareHands(a, b), 0);
});
test('플러시는 스트레이트보다 강하다', () => {
  const flush = hand('2s', '5s', '9s', 'Js', 'Ks', '3h', '4d');
  const straight = hand('5h', '6d', '7c', '8s', '9h', '2c', '3d');
  assert.ok(compareHands(flush, straight) > 0);
});

console.log('\n덱 / 셔플');

test('덱은 52장이며 중복이 없다', () => {
  const d = newShuffledDeck();
  assert.strictEqual(d.length, 52);
  assert.strictEqual(new Set(d.map(cardCode)).size, 52);
});
test('셔플이 매번 다른 순서를 만든다', () => {
  const a = newShuffledDeck().map(cardCode).join('');
  const b = newShuffledDeck().map(cardCode).join('');
  assert.notStrictEqual(a, b);
});
test('카드 분포가 한쪽으로 치우치지 않는다', () => {
  const counts = new Map();
  for (let i = 0; i < 4000; i++) {
    const top = cardCode(newShuffledDeck()[0]);
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  const values = [...counts.values()];
  // 기대값 ≈ 77회. 극단적 편향이 없는지만 확인한다.
  assert.ok(Math.max(...values) < 200, '특정 카드가 과도하게 자주 나옴');
  assert.ok(counts.size > 45, '나오는 카드 종류가 너무 적음');
});

console.log('\n블라인드 / 액션 순서');

test('3인 테이블: 버튼 다음이 SB, 그 다음이 BB, UTG가 선액션', () => {
  const t = makeTable();
  const a = t.addPlayer('t1', 'A');
  const b = t.addPlayer('t2', 'B');
  const c = t.addPlayer('t3', 'C');
  t.startHand();
  const btn = t.playerAtSeat(t.buttonSeat);
  const sb = t.playerAtSeat(t.sbSeat);
  const bb = t.playerAtSeat(t.bbSeat);
  assert.strictEqual(sb.totalBet, 50);
  assert.strictEqual(bb.totalBet, 100);
  assert.notStrictEqual(btn.id, sb.id);
  assert.strictEqual(t.actorSeat, btn.seat, '3인에서는 버튼이 프리플랍 선액션');
  assert.strictEqual(t.pot(), 150);
  [a, b, c].forEach((p) => assert.strictEqual(p.cards.length, 2));
});

test('헤즈업: 버튼이 SB이고 프리플랍 선액션', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();
  assert.strictEqual(t.sbSeat, t.buttonSeat, '헤즈업에서 버튼 = SB');
  assert.strictEqual(t.actorSeat, t.buttonSeat, '헤즈업 프리플랍은 버튼부터');
  assert.strictEqual(t.playerAtSeat(t.sbSeat).totalBet, 50);
  assert.strictEqual(t.playerAtSeat(t.bbSeat).totalBet, 100);
});

test('모든 카드가 서로 다르다 (보드 + 홀카드)', () => {
  const t = makeTable();
  ['t1', 't2', 't3', 't4'].forEach((tk, i) => t.addPlayer(tk, 'P' + i));
  t.startHand();
  t.dealBoard(3);
  t.dealBoard(1);
  t.dealBoard(1);
  const all = [...t.board];
  for (const p of t.players.values()) all.push(...p.cards);
  assert.strictEqual(new Set(all.map(cardCode)).size, all.length);
});

test('BB에게 프리플랍 옵션이 주어진다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.addPlayer('t3', 'C');
  t.startHand();
  const btn = t.playerAtSeat(t.buttonSeat);
  const sb = t.playerAtSeat(t.sbSeat);
  t.act(btn.token, 'call');
  t.act(sb.token, 'call');
  assert.strictEqual(t.actorSeat, t.bbSeat, '모두 콜하면 BB가 옵션을 갖는다');
  assert.strictEqual(t.street, 'preflop');
  t.act(t.playerAtSeat(t.bbSeat).token, 'check');
  assert.strictEqual(t.street, 'flop');
  assert.strictEqual(t.board.length, 3);
});

test('레이즈가 있으면 이미 액션한 플레이어에게 다시 차례가 온다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.addPlayer('t3', 'C');
  t.startHand();
  const btn = t.playerAtSeat(t.buttonSeat);
  const sb = t.playerAtSeat(t.sbSeat);
  const bb = t.playerAtSeat(t.bbSeat);
  t.act(btn.token, 'call');
  t.act(sb.token, 'raise', 400);
  assert.strictEqual(t.currentBet, 400);
  assert.strictEqual(t.minRaise, 300);
  t.act(bb.token, 'call');
  assert.strictEqual(t.actorSeat, btn.seat, '레이즈 후 버튼에게 액션이 다시 열려야 한다');
});

test('최소 레이즈 미만은 거부된다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();
  const actor = t.playerAtSeat(t.actorSeat);
  assert.throws(() => t.act(actor.token, 'raise', 150), /최소/);
});

test('차례가 아니면 액션할 수 없다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.addPlayer('t3', 'C');
  t.startHand();
  const notActor = t.seatedPlayers().find((p) => p.seat !== t.actorSeat);
  assert.throws(() => t.act(notActor.token, 'call'), /차례/);
});

console.log('\n팟 정산');

testAsync('모두 폴드하면 남은 한 명이 팟을 가져간다', async () => {
  const t = makeTable();
  t.autoNext = false;
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.addPlayer('t3', 'C');
  t.startHand();
  const bb = t.playerAtSeat(t.bbSeat);
  const btn = t.playerAtSeat(t.buttonSeat);
  const sb = t.playerAtSeat(t.sbSeat);
  t.act(btn.token, 'fold');
  t.act(sb.token, 'fold');
  assert.strictEqual(t.status, 'showdown');
  assert.strictEqual(bb.stack, 10000 + 50, 'BB는 SB의 블라인드만큼 이득');
  await tick();
});

testAsync('사이드 팟: 숏스택은 메인 팟까지만 가져간다', async () => {
  const t = makeTable({ startingStack: 10000 });
  t.autoNext = false;
  const a = t.addPlayer('t1', 'A');
  const b = t.addPlayer('t2', 'B');
  const c = t.addPlayer('t3', 'C');
  a.stack = 1000;
  b.stack = 5000;
  c.stack = 9000;
  t.startHand();

  // 전원 올인
  while (t.status === 'playing' && t.actorSeat !== null) {
    const actor = t.playerAtSeat(t.actorSeat);
    t.act(actor.token, 'allin');
    await tick();
  }
  await tick();
  const total = [...t.players.values()].reduce((s, p) => s + p.stack, 0);
  assert.strictEqual(total, 15000, '칩 총량이 보존되어야 한다');
  assert.ok(a.stack <= 3000, '숏스택은 자기 기여분의 3배(메인팟)를 넘게 딸 수 없다');
});

testAsync('무승부(칩 스플릿) 시 팟이 균등 분배된다', async () => {
  const t = makeTable();
  t.autoNext = false;
  const a = t.addPlayer('t1', 'A');
  const b = t.addPlayer('t2', 'B');
  t.startHand();
  // 보드가 로열 플러시가 되도록 강제 → 두 플레이어 모두 보드 플레이
  t.board = ['As', 'Ks', 'Qs', 'Js', 'Ts'].map(C);
  a.cards = ['2h', '3d'].map(C);
  b.cards = ['4c', '5h'].map(C);
  t.street = 'river';
  t.showdown();
  await tick();
  assert.strictEqual(a.stack, 10000);
  assert.strictEqual(b.stack, 10000);
});

console.log('\n랜덤 시뮬레이션');

testAsync('랜덤 봇 300핸드: 칩 총량 보존 + 규칙 위반 없음', async () => {
  const STACK = 10000;
  const t = makeTable({ actionTime: 0, startingStack: STACK });
  t.autoNext = false;
  const tokens = ['b1', 'b2', 'b3', 'b4', 'b5'];
  tokens.forEach((tk, i) => t.addPlayer(tk, 'Bot' + i));

  let injected = STACK * tokens.length; // 리바이로 투입된 칩 총량
  let hands = 0;

  for (let h = 0; h < 300; h++) {
    // 파산한 봇은 리바이해서 계속 진행 (칩 총량은 별도로 추적)
    for (const p of t.players.values()) {
      if (p.stack <= 0) {
        p.stack = STACK;
        p.sittingOut = false;
        injected += STACK;
      }
    }
    if (t.eligiblePlayers().length < 2) break;

    t.startHand();
    hands++;

    let guard = 0;
    while (t.status === 'playing') {
      if (t.actorSeat === null) {
        await tick();
        if (++guard > 500) throw new Error('진행이 멈췄습니다 (actorSeat null)');
        continue;
      }
      const p = t.playerAtSeat(t.actorSeat);
      const legal = t.legalActionsFor(p);
      assert.ok(legal, '현재 액터의 합법 액션이 있어야 한다');
      assert.ok(legal.minRaiseTo <= legal.maxRaiseTo, '최소 레이즈가 최대보다 클 수 없다');
      assert.ok(legal.callAmount >= 0, '콜 금액은 음수가 될 수 없다');

      const roll = Math.random();
      try {
        if (roll < 0.12) t.act(p.token, 'fold');
        else if (roll < 0.7) t.act(p.token, legal.canCheck ? 'check' : 'call');
        else if (roll < 0.95 && legal.canRaise) {
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          t.act(p.token, 'raise', legal.minRaiseTo + Math.floor(Math.random() * (span + 1)));
        } else t.act(p.token, 'allin');
      } catch (err) {
        throw new Error('합법적인 액션이 거부됨: ' + err.message);
      }

      if (++guard > 2000) throw new Error('핸드가 끝나지 않습니다');
    }

    let waitGuard = 0;
    while (t.status !== 'waiting') {
      await tick();
      if (++waitGuard > 200) throw new Error('핸드 종료 처리가 끝나지 않습니다');
    }

    const sum = [...t.players.values()].reduce((s, p) => s + p.stack, 0);
    assert.strictEqual(sum, injected, `핸드 #${h + 1} 이후 칩 총량 불일치 (${sum} != ${injected})`);
    for (const p of t.players.values()) assert.ok(p.stack >= 0, '스택이 음수가 될 수 없다');
    assert.strictEqual(t.pot(), 0, '핸드 종료 후 팟이 남아 있으면 안 된다');
  }

  assert.strictEqual(hands, 300, `300핸드가 모두 진행되어야 한다 (진행: ${hands})`);
  console.log(`    → ${hands}핸드 진행, 칩 총량 검증 통과`);
  t.clearTimers();
});

process.on('exit', () => {
  console.log(`\n${passed}개 테스트 통과${process.exitCode ? ' (실패 있음)' : ''}\n`);
});
