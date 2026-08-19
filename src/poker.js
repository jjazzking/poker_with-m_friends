'use strict';
/**
 * 덱 · 셔플 · 핸드 평가.
 * Node(서버 모드)와 브라우저(GitHub Pages P2P 모드) 양쪽에서 그대로 쓰인다.
 */
const nodeCrypto = typeof require === 'function' ? require('crypto') : null;

/** 0 이상 max 미만의 편향 없는 난수 (Node: crypto, 브라우저: WebCrypto) */
function randomInt(max) {
  if (nodeCrypto) return nodeCrypto.randomInt(max);
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  let v;
  do {
    globalThis.crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % max;
}

const SUITS = ['s', 'h', 'd', 'c'];
const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8',
  9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const CATEGORY_NAMES = [
  '하이카드', '원페어', '투페어', '트리플', '스트레이트',
  '플러시', '풀하우스', '포카드', '스트레이트 플러시',
];

/** 52장 덱 생성 */
function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s });
  }
  return deck;
}

/**
 * 암호학적 난수(crypto.randomInt)를 쓰는 Fisher-Yates 셔플.
 * Math.random 과 달리 예측이 불가능하고 편향이 없다.
 */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function newShuffledDeck() {
  return shuffle(makeDeck());
}

function cardCode(card) {
  return RANK_LABEL[card.r] + card.s;
}

/** 정확히 5장을 평가한다. { cat, tb } 가 클수록 강한 핸드. */
function evaluate5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5 (휠)
  }

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()]
    .map(([r, c]) => ({ r, c }))
    .sort((a, b) => b.c - a.c || b.r - a.r);
  const g = groups.map((x) => x.r);

  if (isFlush && straightHigh) return { cat: 8, tb: [straightHigh] };
  if (groups[0].c === 4) return { cat: 7, tb: [g[0], g[1]] };
  if (groups[0].c === 3 && groups[1].c === 2) return { cat: 6, tb: [g[0], g[1]] };
  if (isFlush) return { cat: 5, tb: ranks };
  if (straightHigh) return { cat: 4, tb: [straightHigh] };
  if (groups[0].c === 3) return { cat: 3, tb: [g[0], g[1], g[2]] };
  if (groups[0].c === 2 && groups[1].c === 2) return { cat: 2, tb: [g[0], g[1], g[2]] };
  if (groups[0].c === 2) return { cat: 1, tb: [g[0], g[1], g[2], g[3]] };
  return { cat: 0, tb: ranks };
}

/** 두 평가 결과 비교. a가 강하면 양수, 같으면 0 */
function compareHands(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.tb.length, b.tb.length);
  for (let i = 0; i < n; i++) {
    const x = a.tb[i] || 0;
    const y = b.tb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const COMBOS5 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

/** 5~7장 중 최고의 5장을 찾는다. */
function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('카드가 부족합니다');
  let best = null;
  if (cards.length === 5) {
    best = { ...evaluate5(cards), cards: cards.slice() };
  } else if (cards.length === 7) {
    for (const combo of COMBOS5) {
      const picked = combo.map((i) => cards[i]);
      const score = evaluate5(picked);
      if (!best || compareHands(score, best) > 0) best = { ...score, cards: picked };
    }
  } else {
    // 6장 등 일반 케이스
    const idx = cards.map((_, i) => i);
    const pick = (start, acc) => {
      if (acc.length === 5) {
        const picked = acc.map((i) => cards[i]);
        const score = evaluate5(picked);
        if (!best || compareHands(score, best) > 0) best = { ...score, cards: picked };
        return;
      }
      for (let i = start; i < idx.length; i++) pick(i + 1, [...acc, i]);
    };
    pick(0, []);
  }
  best.name = handName(best);
  return best;
}

function handName(score) {
  if (score.cat === 8 && score.tb[0] === 14) return '로열 플러시';
  return CATEGORY_NAMES[score.cat];
}

const API = {
  randomInt,
  SUITS,
  RANK_LABEL,
  CATEGORY_NAMES,
  makeDeck,
  shuffle,
  newShuffledDeck,
  cardCode,
  evaluate5,
  evaluateBest,
  compareHands,
  handName,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else globalThis.Poker = API;
