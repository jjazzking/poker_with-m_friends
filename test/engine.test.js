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

const C = (s) => ({
  r: { T: 10, J: 11, Q: 12, K: 13, A: 14 }[s[0]] || (s.startsWith('10') ? 10 : Number(s[0])),
  s: s.slice(-1),
});
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
    allInPauseDelay: 0,
    allInRevealDelay: 0,
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

test('10 은 T 가 아니라 10 으로 표기된다', () => {
  assert.strictEqual(cardCode(C('10h')), '10h');
  assert.strictEqual(cardCode(C('Ah')), 'Ah');
  // 화면에서 랭크/무늬를 잘라 쓰는 방식이 두 글자 랭크에서도 맞아야 한다
  const code = cardCode(C('10s'));
  assert.strictEqual(code.slice(-1), 's');
  assert.strictEqual(code.slice(0, -1), '10');
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

console.log('\n실시간 내 패 표시');

test('프리플랍에는 홀카드 조합을 알려 준다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();
  const p = t.players.get('t1');

  p.cards = [C('As'), C('Ad')];
  assert.strictEqual(t.madeHandFor(p).name, '포켓 페어 (AA)');

  p.cards = [C('As'), C('Ks')];
  assert.strictEqual(t.madeHandFor(p).name, 'A 하이 (수티드)');

  p.cards = [C('As'), C('Kd')];
  assert.strictEqual(t.madeHandFor(p).name, 'A 하이 (오프숫)');
});

test('플랍 이후에는 완성된 족보와 사용된 5장을 알려 준다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();
  const p = t.players.get('t1');
  p.cards = [C('As'), C('Ks')];

  t.board = [C('Ah'), C('Kc'), C('7d')];
  const flop = t.madeHandFor(p);
  assert.strictEqual(flop.name, '투페어');
  assert.strictEqual(flop.cards.length, 5);
  assert.ok(flop.cards.includes('As') && flop.cards.includes('Ah'), '사용된 카드가 표시되어야 한다');

  t.board.push(C('Ac'));
  assert.strictEqual(t.madeHandFor(p).name, '풀하우스');
});

test('내 패는 나에게만 내려간다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();

  const mine = t.publicState('t1');
  assert.ok(mine.you.made, '본인 상태에는 완성된 패가 들어 있어야 한다');
  // 다른 사람 정보에는 카드도 족보도 없다
  const other = mine.players.find((x) => !x.isMe);
  assert.deepStrictEqual(other.cards, ['??', '??']);
  assert.strictEqual(other.handLabel, null);
});

test('폴드했거나 핸드에 없으면 표시하지 않는다', () => {
  const t = makeTable();
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.addPlayer('t3', 'C');
  t.startHand();
  const p = t.players.get('t1');
  p.folded = true;
  assert.strictEqual(t.madeHandFor(p), null);
  assert.strictEqual(t.publicState('t1').you.made, null);
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

testAsync('올인 콜: 보드를 깔기 전에 양쪽 카드를 먼저 공개한다', async () => {
  // 뜸을 실제로 들이는지 보려면 딜레이가 0이면 안 된다
  // 쇼다운이 곧바로 지나가 버리지 않도록 정산 뒤 여유를 준다
  const t = makeTable({ allInPauseDelay: 40, allInRevealDelay: 40, runoutDelay: 5, showdownDelay: 500 });
  t.autoNext = false;
  const a = t.addPlayer('t1', 'A');
  const b = t.addPlayer('t2', 'B');
  t.startHand();

  const actor = t.playerAtSeat(t.actorSeat);
  t.act(actor.token, 'allin');
  const caller = t.playerAtSeat(t.actorSeat);
  t.act(caller.token, 'allin');

  // 콜한 직후: 아직 아무것도 공개되지 않고 보드도 그대로다
  assert.strictEqual(t.allInRevealed, false, '콜 직후에는 아직 뜸을 들인다');
  assert.strictEqual(t.board.length, 0, '뜸 들이는 동안 보드가 열리면 안 된다');
  assert.deepStrictEqual(
    t.publicState('t1').players.find((p) => p.name === 'B').cards,
    ['??', '??'],
    '아직 상대 카드는 보이지 않는다'
  );

  // 뜸이 끝나면 보드보다 카드가 먼저 열린다
  for (let i = 0; i < 200 && !t.allInRevealed; i++) await tick();
  assert.strictEqual(t.allInRevealed, true);
  assert.strictEqual(t.board.length, 0, '카드가 보드보다 먼저 열려야 한다');
  const seen = t.publicState('t1').players.find((p) => p.name === 'B').cards;
  assert.strictEqual(seen.length, 2);
  assert.ok(!seen.includes('??'), '올인 상대의 카드가 공개되어야 한다');

  // 그 뒤 보드가 리버까지 흐르고 정산된다
  for (let i = 0; i < 400 && t.status !== 'showdown'; i++) await tick();
  assert.strictEqual(t.status, 'showdown');
  assert.strictEqual(t.board.length, 5);
  assert.strictEqual(a.stack + b.stack, 20000, '칩 총량이 보존되어야 한다');
});

testAsync('폴드로 끝난 핸드에서는 카드를 공개하지 않는다', async () => {
  const t = makeTable();
  t.autoNext = false;
  t.addPlayer('t1', 'A');
  t.addPlayer('t2', 'B');
  t.startHand();
  const actor = t.playerAtSeat(t.actorSeat);
  t.act(actor.token, 'fold');
  assert.strictEqual(t.allInRevealed, false);
  const winner = t.publicState(actor.token).players.find((p) => !p.isMe);
  assert.deepStrictEqual(winner.cards, ['??', '??'], '무경합 승리에서는 이긴 사람 카드도 덮여 있다');
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
  // 올인 공개 단계가 끼어 있으므로 핸드가 끝날 때까지 기다린다
  for (let i = 0; i < 200 && t.status === 'playing'; i++) await tick();
  assert.notStrictEqual(t.status, 'playing', '올인 공개를 거쳐 정산까지 진행되어야 한다');
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

/* ------------------------------------------------- 연결 끊김 자동 퇴장 */

testAsync('연결이 끊기면 유예 시간 뒤에 자리비움 처리된다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  const stack = t.players.get('b').stack;

  t.setConnected('b', false);
  assert.strictEqual(t.players.get('b').sittingOut, false, '유예 시간 동안에는 그대로 둔다');
  assert.ok(t.players.get('b').dropAt > Date.now(), '자리비움 예정 시각이 잡혀야 한다');

  await new Promise((r) => setTimeout(r, 140));
  const b = t.players.get('b');
  assert.ok(b, '자리에서 빼지는 않는다 — 스택을 지켜 준다');
  assert.strictEqual(b.sittingOut, true, '유예 시간이 지나면 자리비움이 되어야 한다');
  assert.strictEqual(b.autoSatOut, true, '자동으로 비워진 자리로 표시된다');
  assert.strictEqual(b.stack, stack, '스택은 그대로여야 한다');
  assert.ok(
    t.log.some((l) => l.text.includes('자리비움 처리')),
    '왜 비워졌는지 기록이 남아야 한다'
  );
  t.dispose();
});

testAsync('자동으로 비워진 자리는 재접속하면 다시 참가한다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');

  t.setConnected('b', false);
  await new Promise((r) => setTimeout(r, 140));
  assert.strictEqual(t.players.get('b').sittingOut, true, '먼저 자리비움이 되어야 한다');

  t.setConnected('b', true);
  const b = t.players.get('b');
  assert.strictEqual(b.sittingOut, false, '돌아왔으면 다시 참가시켜야 한다');
  assert.strictEqual(b.autoSatOut, false, '자동 표시도 지워야 한다');
  t.dispose();
});

testAsync('직접 고른 자리비움은 재접속해도 유지된다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');

  t.setSitOut('b', true); // 본인이 골랐다
  t.setConnected('b', false);
  await new Promise((r) => setTimeout(r, 140));
  t.setConnected('b', true);

  assert.strictEqual(t.players.get('b').sittingOut, true, '본인이 고른 자리비움을 뒤집으면 안 된다');
  t.dispose();
});

testAsync('진행 중인 핸드를 붙잡고 있으면 폴드 처리된다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.addPlayer('c', '캐럴');
  t.startHand();

  const actor = t.seatedPlayers().find((p) => p.seat === t.actorSeat);
  t.setConnected(actor.token, false);
  await new Promise((r) => setTimeout(r, 140));

  assert.strictEqual(actor.folded, true, '차례를 붙잡고 있으면 폴드시켜야 한다');
  assert.ok(t.actorSeat !== actor.seat, '다음 사람으로 넘어가야 한다');
  t.dispose();
});

testAsync('연결 끊김 폴드로 혼자 남으면 핸드가 끝난다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.autoNext = false;
  t.startHand();
  assert.strictEqual(t.status, 'playing', '핸드가 시작되어야 한다');

  for (const p of t.seatedPlayers()) t.setConnected(p.token, false);
  await new Promise((r) => setTimeout(r, 140));

  let guard = 0;
  while (t.status === 'playing') {
    await tick();
    if (++guard > 400) throw new Error('핸드가 끝나지 않는다');
  }
  assert.strictEqual(t.pot(), 0, '팟이 정산되어야 한다');
  t.dispose();
});

testAsync('유예 시간 안에 돌아오면 자리를 지킨다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');

  t.setConnected('b', false);
  await new Promise((r) => setTimeout(r, 30));
  t.setConnected('b', true); // 새로고침하고 돌아옴

  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(t.players.get('b').sittingOut, false, '돌아왔으면 아무 일도 없어야 한다');
  assert.strictEqual(t.players.get('b').dropAt, null, '자리비움 예약이 취소되어야 한다');
  t.dispose();
});

testAsync('핸드 중에 나가도 팟에 넣은 칩이 사라지지 않는다', async () => {
  const t = makeTable({ disconnectGrace: 0 }); // 자동 퇴장은 끄고 수동으로 확인
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.addPlayer('c', '캐럴');
  const total = [...t.players.values()].reduce((s, p) => s + p.stack, 0);

  t.startHand();
  // 누군가 칩을 넣은 상태에서 자리를 뜬다
  const actor = t.seatedPlayers().find((p) => p.seat === t.actorSeat);
  t.act(actor.token, 'call');
  const potBefore = t.pot();
  assert.ok(potBefore > 0, '팟에 칩이 들어가 있어야 한다');

  const victim = t.seatedPlayers().find((p) => p.inHand && !p.folded && p.totalBet > 0);
  t.removePlayer(victim.token);

  assert.ok(t.players.has(victim.token), '핸드 중에는 자리를 바로 지우지 않는다');
  assert.strictEqual(t.players.get(victim.token).leaving, true, '나가는 중으로 표시된다');
  assert.ok(t.pot() >= potBefore, `팟이 줄어들면 안 된다 (${potBefore} → ${t.pot()})`);

  // 핸드가 끝나면 실제로 자리에서 빠지고, 칩 총량은 그대로여야 한다
  // (actionTime 이 0이라 자동 폴드가 없으므로 남은 사람들을 직접 진행시킨다)
  t.autoNext = false;
  let guard = 0;
  while (t.status === 'playing' && t.actorSeat !== null) {
    const cur = t.seatedPlayers().find((p) => p.seat === t.actorSeat);
    t.act(cur.token, 'fold');
    if (++guard > 20) throw new Error('핸드가 진행되지 않는다');
  }
  guard = 0;
  while (t.status !== 'waiting') {
    await tick();
    if (++guard > 400) throw new Error('핸드가 끝나지 않는다');
  }
  assert.ok(!t.players.has(victim.token), '핸드가 끝나면 자리에서 빠져야 한다');

  const after = [...t.players.values()].reduce((s, p) => s + p.stack, 0);
  assert.strictEqual(after, total - victim.stack, `칩이 사라졌다 (${total} → ${after} + ${victim.stack})`);
  t.dispose();
});

testAsync('방장이 끊기면 자리는 지키되 방장은 넘어간다', async () => {
  const t = makeTable({ disconnectGrace: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  assert.strictEqual(t.hostToken, 'a', '먼저 들어온 사람이 방장이다');

  t.setConnected('a', false);
  await new Promise((r) => setTimeout(r, 140));
  assert.ok(t.players.has('a'), '방장이라고 자리에서 빼지는 않는다');
  assert.strictEqual(t.hostToken, 'b', '남은 사람이 게임을 이어갈 수 있어야 한다');
  t.dispose();
});

/* ------------------------------------------------------- 방장 기능 */

console.log('\n방장 기능');

test('블라인드 변경은 대기 중이면 즉시, 핸드 중이면 다음 핸드부터', () => {
  const t = makeTable();
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');

  t.setBlinds(100, 200);
  assert.strictEqual(t.config.smallBlind, 100);
  assert.strictEqual(t.config.bigBlind, 200);
  assert.strictEqual(t.pendingBlinds, null);

  t.startHand();
  t.setBlinds(200, 400);
  assert.strictEqual(t.config.bigBlind, 200, '진행 중인 핸드의 블라인드는 그대로여야 한다');
  assert.deepStrictEqual(t.pendingBlinds, { smallBlind: 200, bigBlind: 400 });

  // 다음 핸드가 시작될 때 적용된다
  t.status = 'waiting';
  t.startHand();
  assert.strictEqual(t.config.bigBlind, 400, '다음 핸드부터는 새 블라인드다');
  assert.strictEqual(t.pendingBlinds, null);
  t.dispose();
});

test('말이 안 되는 블라인드는 거절한다', () => {
  const t = makeTable();
  t.addPlayer('a', '앨리스');
  assert.throws(() => t.setBlinds(300, 200), /SB/, 'SB 가 BB 보다 클 수 없다');
  assert.throws(() => t.setBlinds(1, 1), /BB/, 'BB 는 2 이상이어야 한다');
  assert.throws(() => t.setBlinds(1, 'x'), /올바르지/);
  assert.strictEqual(t.config.bigBlind, 100, '거절된 값은 반영되지 않는다');
  t.dispose();
});

test('일시정지하면 제한시간이 멈추고 다음 핸드도 시작되지 않는다', () => {
  const t = makeTable({ actionTime: 60 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.startHand();
  assert.ok(t.deadline, '핸드 중에는 제한시간이 돈다');

  t.setPaused(true);
  assert.strictEqual(t.deadline, null, '일시정지 중에는 시계가 멈춘다');
  assert.ok(t.pausedRemainMs > 0, '남은 시간을 기억해 둔다');
  assert.throws(() => t.startHand(), /일시정지/);

  t.setPaused(false);
  assert.ok(t.deadline > Date.now(), '재개하면 남은 시간부터 다시 센다');
  assert.ok(t.deadline - Date.now() <= 60000);
  t.dispose();
});

testAsync('일시정지 중에는 자동으로 다음 핸드가 시작되지 않는다', async () => {
  const t = makeTable({ actionTime: 0 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.startHand();
  t.setPaused(true);

  // 한 명이 폴드해서 핸드를 끝낸다
  const actor = t.playerAtSeat(t.actorSeat);
  t.act(actor.token, 'fold');
  let guard = 0;
  while (t.status !== 'waiting') {
    await tick();
    if (++guard > 400) throw new Error('핸드가 끝나지 않는다');
  }
  await tick();
  assert.strictEqual(t.status, 'waiting', '일시정지 중이면 다음 핸드로 넘어가지 않는다');
  assert.strictEqual(t.handNo, 1);

  t.setPaused(false);
  assert.strictEqual(t.handNo, 2, '재개하면 다음 핸드가 시작된다');
  t.dispose();
});

test('강퇴된 사람은 자리에서 빠지고 같은 토큰으로 다시 못 들어온다', () => {
  const t = makeTable();
  t.addPlayer('a', '앨리스');
  const bob = t.addPlayer('b', '밥');

  assert.throws(() => t.kick('b', bob.id), /방장만/, '방장이 아니면 못 내보낸다');
  assert.throws(() => t.kick('a', 'P999'), /찾을 수 없습니다/);
  assert.throws(() => t.kick('a', t.players.get('a').id), /스스로/);

  assert.strictEqual(t.kick('a', bob.id), 'b');
  assert.ok(!t.players.has('b'), '자리에서 빠진다');
  assert.throws(() => t.addPlayer('b', '밥'), /내보냈습니다/, '같은 토큰으로는 다시 못 들어온다');

  t.clearBans();
  assert.ok(t.addPlayer('b', '밥'), '다시 입장을 허용하면 들어올 수 있다');
  t.dispose();
});

testAsync('핸드 도중 강퇴하면 폴드 처리하고 핸드가 끝난 뒤 자리를 뺀다', async () => {
  const t = makeTable({ actionTime: 0 });
  t.addPlayer('a', '앨리스');
  t.addPlayer('b', '밥');
  t.addPlayer('c', '찰리');
  t.autoNext = false; // 정산 결과를 확인할 수 있게 다음 핸드는 자동으로 시작하지 않는다
  t.startHand();
  const total = [...t.players.values()].reduce((s, p) => s + p.stack, 0) + t.pot();

  const victim = t.players.get('c');
  t.kick('a', victim.id);
  assert.ok(t.players.has('c'), '정산 전에는 자리를 지켜 둔다');
  assert.ok(victim.folded, '진행 중인 핸드에서는 폴드된다');

  let guard = 0;
  while (t.status === 'playing') {
    const actor = t.playerAtSeat(t.actorSeat);
    if (!actor) { await tick(); } else {
      const legal = t.legalActionsFor(actor);
      t.act(actor.token, legal.canCheck ? 'check' : 'call');
    }
    if (++guard > 40) throw new Error('핸드가 진행되지 않는다');
  }
  guard = 0;
  while (t.status !== 'waiting') {
    await tick();
    if (++guard > 400) throw new Error('핸드가 끝나지 않는다');
  }

  assert.ok(!t.players.has('c'), '핸드가 끝나면 자리에서 빠진다');
  const after = [...t.players.values()].reduce((s, p) => s + p.stack, 0);
  assert.strictEqual(
    after,
    total - victim.stack,
    `칩이 사라지거나 늘었다 (${total} → ${after} + ${victim.stack})`
  );
  t.dispose();
});

process.on('exit', () => {
  console.log(`\n${passed}개 테스트 통과${process.exitCode ? ' (실패 있음)' : ''}\n`);
});
