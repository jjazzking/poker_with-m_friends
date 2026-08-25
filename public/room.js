'use strict';

const $ = (s) => document.querySelector(s);
// 정적 호스팅(GitHub Pages)에서도 동작하도록 방 코드는 해시로 전달한다: room.html#ABC123
const ROOM_ID = decodeURIComponent((location.hash || '').replace(/^#\/?(room\/)?/, '')).toUpperCase();
const NAME_KEY = 'poker:name';
const TOKEN_KEY = `poker:token:${ROOM_ID}`;

const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET_LABEL = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' };

let state = null;
let unit = localStorage.getItem('poker:unit') || 'bb';
let betChips = 0; // 항상 "칩 기준 레이즈 목표 금액"으로 보관
let reconnectDelay = 500;
let offlineTimer = null;
let timerRAF = null;
const BASE_TITLE = document.title;
let titleTimer = null;
let titleFlipped = false;
let turnNotification = null;

/** 내 패를 이루는 카드(하이라이트용) */
let usedCards = new Set();

/**
 * 애니메이션은 "새로 나타난 카드"에만 걸어야 한다.
 * 상태가 올 때마다 화면을 다시 그리므로, 이미 보여 준 카드를 기억해 둔다.
 */
const anim = {
  handNo: null,
  boardShown: 0,
  dealt: new Set(),    // 홀카드를 이미 받은 플레이어
  revealed: new Set(), // 쇼다운에서 이미 공개된 플레이어
  actions: new Map(),  // 플레이어별 마지막 액션 문구
  pot: 0,
};

function resetAnim(handNo) {
  anim.handNo = handNo;
  anim.boardShown = 0;
  anim.dealt.clear();
  anim.revealed.clear();
  anim.actions.clear();
  anim.pot = 0;
}

/* ------------------------------------------------------------- 유틸 */

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR');

function toBB(chips) {
  const bb = state?.room?.bigBlind || 1;
  const v = chips / bb;
  return (Math.round(v * 10) / 10).toString();
}

function toast(message, isError) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

function getToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

function sendMsg(obj) {
  Net.send(obj);
}

/* ------------------------------------------------------------- 입장 */

async function boot() {
  if (!ROOM_ID) return fatal('방 코드가 없습니다', '초대 링크를 다시 확인해 주세요.');

  const info = await Net.roomInfo(ROOM_ID).catch(() => null);
  // 서버 모드에서는 방 정보를 미리 알 수 있고, P2P 참가자는 방장에게 붙어야 알 수 있다
  if (!info && Net.mode === 'server') {
    return fatal('방을 찾을 수 없습니다', '링크가 만료되었거나 잘못된 코드입니다.');
  }

  if (info) {
    $('#room-name').textContent = info.config.name;
    $('#blind-badge').textContent = `SB ${fmt(info.config.smallBlind)} / BB ${fmt(info.config.bigBlind)}`;
  }

  const name = localStorage.getItem(NAME_KEY);
  if (name) return connect(name);

  const modal = $('#name-modal');
  modal.hidden = false;
  $('#modal-info').textContent = info
    ? `${info.config.name} · SB ${fmt(info.config.smallBlind)} / BB ${fmt(info.config.bigBlind)} · 시작 스택 ${fmt(info.config.startingStack)}`
    : `방 코드 ${ROOM_ID} · 입장하면 방장이 정한 블라인드와 스택이 표시됩니다.`;
  $('#modal-name').focus();
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#modal-name').value.trim();
    if (!v) return;
    localStorage.setItem(NAME_KEY, v);
    modal.hidden = true;
    askNotifyPermission();
    connect(v);
  });
}

function fatal(title, detail) {
  document.body.innerHTML =
    `<div class="fatal"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    `<a class="primary big" href="${new URL('index.html' + location.search, location.href).href}">새 방 만들기</a></div>`;
}

function connect(name) {
  $('#connecting').hidden = false;
  Net.join({
    roomId: ROOM_ID,
    name,
    token: getToken(),
    handlers: {
      onState(msg) {
        $('#connecting').hidden = true;
        const prevActor = state ? state.actorSeat : undefined;
        state = msg;
        render();
        if (state.legal && prevActor !== state.actorSeat) notifyMyTurn();
      },
      onError(message) {
        toast(message, true);
      },
      onFatal(message) {
        toast(message, true);
        setTimeout(() => fatal('연결이 끊겼습니다', message), 1200);
      },
      onDisconnect() {
        toast('연결이 끊겼습니다. 다시 연결 중…', true);
      },
      onHostReady() {
        toast('방이 열렸습니다. 초대 링크를 친구에게 보내세요!');
      },
    },
  });
}

function notifyMyTurn() {
  if (document.hidden) {
    startTitleFlash();
    showTurnNotification();
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch (_) {
    /* 사운드 미지원 브라우저 */
  }
}

/* ------------------------------------------------------------- 렌더 */

function cardEl(code) {
  const el = document.createElement('div');
  if (!code || code === '??') {
    el.className = 'card back';
    return el;
  }
  const suit = code.slice(-1);
  const rank = code.slice(0, -1); // '10' 처럼 두 글자일 수 있다
  el.className =
    'card' +
    (suit === 'h' || suit === 'd' ? ' red' : '') +
    (rank.length > 1 ? ' wide-rank' : '') +
    (usedCards.has(code) ? ' used' : '');
  el.innerHTML = `<span class="r">${rank}</span><span class="s">${SUIT_SYMBOL[suit] || ''}</span>`;
  return el;
}

/** 카드가 딜러(테이블 중앙)에서 날아오는 방향을 CSS 변수로 넘겨 준다 */
function setDealOrigin(el, xPercent, yPercent, delayMs) {
  const felt = $('.felt');
  const w = felt ? felt.clientWidth : 600;
  const h = felt ? felt.clientHeight : 400;
  el.style.setProperty('--dx', ((50 - xPercent) / 100) * w + 'px');
  el.style.setProperty('--dy', ((46 - yPercent) / 100) * h + 'px');
  el.style.animationDelay = delayMs + 'ms';
  el.classList.add('dealing');
}

function render() {
  if (!state) return;

  if (anim.handNo !== state.handNo || (!state.board.length && anim.boardShown)) resetAnim(state.handNo);
  usedCards = new Set(state.you && state.you.made ? state.you.made.cards : []);

  $('#room-name').textContent = state.room.name;
  $('#blind-badge').textContent = `SB ${fmt(state.room.smallBlind)} / BB ${fmt(state.room.bigBlind)}`;
  $('#hand-badge').textContent = `#${state.handNo}`;
  // P2P 모드에서는 방장 탭이 곧 서버라서, 닫으면 방이 사라진다는 것을 알려 준다
  $('#host-badge').hidden = !(Net.mode === 'p2p' && Net.isHost);

  const potEl = $('#pot');
  potEl.textContent = fmt(state.pot);
  $('#pot-bb').textContent = state.pot ? `(${toBB(state.pot)} BB)` : '';
  if (state.pot > anim.pot) {
    potEl.classList.remove('bump');
    void potEl.offsetWidth; // 애니메이션 재시작
    potEl.classList.add('bump');
  }
  anim.pot = state.pot;
  $('#street').textContent = state.status === 'playing' ? STREET_LABEL[state.street] || '' : '';

  const board = $('#board');
  board.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (state.board[i]) {
      const el = cardEl(state.board[i]);
      // 이번에 새로 깔린 카드만 뒤집히는 연출
      if (i >= anim.boardShown) {
        el.classList.add('flipping');
        el.style.animationDelay = (i - anim.boardShown) * 160 + 'ms';
      }
      board.appendChild(el);
    } else {
      const ph = document.createElement('div');
      ph.className = 'card placeholder';
      board.appendChild(ph);
    }
  }
  anim.boardShown = state.board.length;

  renderSeats();
  renderResults();
  renderMadeHand();
  renderLog();
  renderActions();
  syncTurnSignals();
}

function renderMadeHand() {
  const el = $('#made-hand');
  const made = state.you && state.you.made;
  if (!made || state.status === 'waiting') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $('#mh-name').textContent = made.name;
  $('#mh-cards').innerHTML = made.cards
    .map((c) => {
      const suit = c.slice(-1);
      const red = suit === 'h' || suit === 'd';
      return `<span class="mh-card${red ? ' red' : ''}">${escapeHtml(c.slice(0, -1))}${SUIT_SYMBOL[suit] || ''}</span>`;
    })
    .join('');
}

function renderSeats() {
  const wrap = $('#seats');
  const mySeat = state.you ? state.you.seat : (state.players[0] ? state.players[0].seat : 0);

  // 실제 착석한 인원만큼 테이블에 균등 배치하고, 내 자리를 아래 중앙으로 회전시킨다
  const ordered = [...state.players].sort(
    (a, b) => relSeat(a.seat, mySeat) - relSeat(b.seat, mySeat)
  );
  const n = ordered.length || 1;
  const narrow = window.innerWidth < 900;
  const rx = narrow ? 40 : 40;
  const ry = narrow ? 41 : 38;

  wrap.innerHTML = '';
  ordered.forEach((p, i) => {
    const angle = (Math.PI / 2) + (i / n) * Math.PI * 2;
    const x = 50 + Math.cos(angle) * rx;
    const y = 50 + Math.sin(angle) * ry;

    const seat = document.createElement('div');
    seat.className = 'seat';
    if (p.isMe) seat.classList.add('me');
    if (p.folded) seat.classList.add('folded');
    if (!p.connected) seat.classList.add('offline');
    if (p.sittingOut) seat.classList.add('sitout');
    if (p.seat === state.actorSeat) seat.classList.add('acting');
    if (p.won > 0 && state.status === 'showdown') seat.classList.add('winner');
    seat.style.left = x + '%';
    seat.style.top = y + '%';
    // 베팅 칩이 항상 테이블 중앙 쪽에 표시되도록
    seat.dataset.half = y < 50 ? 'top' : 'bottom';

    const cards = document.createElement('div');
    cards.className = 'seat-cards';

    const hasCards = p.cards.length > 0;
    const faceUp = hasCards && p.cards[0] !== '??';
    // 이번 핸드에서 처음 받는 카드인지 / 쇼다운에서 처음 공개되는 카드인지
    const isNewDeal = hasCards && !anim.dealt.has(p.id);
    const isNewReveal = faceUp && !p.isMe && !anim.revealed.has(p.id) && !isNewDeal;

    p.cards.forEach((c, ci) => {
      const el = cardEl(c);
      if (isNewDeal) setDealOrigin(el, x, y, i * 90 + ci * 110);
      else if (isNewReveal) {
        el.classList.add('flipping');
        el.style.animationDelay = ci * 120 + 'ms';
      }
      cards.appendChild(el);
    });

    if (isNewDeal) anim.dealt.add(p.id);
    if (faceUp && !p.isMe) anim.revealed.add(p.id);

    const info = document.createElement('div');
    info.className = 'seat-info';
    info.innerHTML = `
      <div class="seat-name">${p.seat === state.buttonSeat ? '<span class="dealer">D</span>' : ''}${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</div>
      <div class="seat-stack">${fmt(p.stack)} <span class="sbb">(${toBB(p.stack)}BB)</span></div>
      ${p.handLabel ? `<div class="seat-hand">${p.handLabel}</div>` : ''}
      ${seatTimerBar(p)}
      ${p.sittingOut ? '<div class="seat-tag">자리비움</div>' : ''}
      ${!p.connected ? `<div class="seat-tag off"${offlineUntil(p) ? ` data-until="${offlineUntil(p)}"` : ''}>연결끊김</div>` : ''}
    `;

    seat.appendChild(cards);
    seat.appendChild(info);

    if (p.lastAction) {
      const act = document.createElement('div');
      act.className = 'seat-action';
      // 방금 바뀐 액션만 살짝 튀어나오게
      if (anim.actions.get(p.id) !== p.lastAction) act.classList.add('pop');
      act.textContent = p.lastAction;
      seat.appendChild(act);
    }
    anim.actions.set(p.id, p.lastAction);
    if (p.bet > 0) {
      const bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.innerHTML = `<span class="chip"></span>${fmt(p.bet)}`;
      seat.appendChild(bet);
    }
    wrap.appendChild(seat);
  });

  syncOfflineTags();
}

/** 액션 중인 좌석 아래에 남은 시간 게이지를 깐다 (남의 차례에도 보인다) */
function seatTimerBar(p) {
  const live = state.status === 'playing' && state.deadline && state.room.actionTime;
  return live && p.seat === state.actorSeat ? '<div class="seat-timer"></div>' : '';
}

/** 연결이 끊긴 좌석이 자동 폴드되기까지 남은 시각(ms) */
function offlineUntil(p) {
  const grace = state && state.room ? state.room.disconnectGrace : 0;
  return p.disconnectedAt && grace ? p.disconnectedAt + grace : 0;
}

/** 좌석 태그의 남은 초를 1초마다 갱신한다 (끊긴 사람이 있을 때만 돈다) */
function syncOfflineTags() {
  const tags = document.querySelectorAll('.seat-tag.off[data-until]');
  if (!tags.length) {
    clearInterval(offlineTimer);
    offlineTimer = null;
    return;
  }
  for (const el of tags) {
    const left = Math.ceil((Number(el.dataset.until) - Date.now()) / 1000);
    el.textContent = left > 0 ? `연결끊김 ${left}초` : '연결끊김';
  }
  if (!offlineTimer) offlineTimer = setInterval(syncOfflineTags, 1000);
}

function relSeat(seat, mySeat) {
  const max = state.room.maxPlayers;
  return ((seat - mySeat) % max + max) % max;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderResults() {
  const el = $('#results');
  if (state.status !== 'showdown' || !state.results) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = state.results.pots
    .map((pot, i) => {
      const title = state.results.pots.length > 1 ? (i === 0 ? '메인 팟' : `사이드 팟 ${i}`) : '팟';
      const winners = pot.winners
        .map((w) => `<b>${escapeHtml(w.name)}</b>${w.hand ? ` <span class="muted">${w.hand}</span>` : ''} +${fmt(w.share)}`)
        .join(' · ');
      return `<div class="result-row"><span class="rt">${title} ${fmt(pot.amount)}</span> ${winners}</div>`;
    })
    .join('');
}

function renderLog() {
  const el = $('#log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = state.log.map((l) => `<div class="log-line">${escapeHtml(l.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------- 액션 */

function renderActions() {
  const legal = state.legal;
  const panel = $('#action-panel');
  const waiting = $('#waiting-bar');

  $('#sitout-btn').textContent = state.you && state.you.sittingOut ? '다시 참가' : '자리 비우기';

  if (!legal) {
    panel.hidden = true;
    waiting.hidden = false;
    const canStart = state.you && state.you.isHost && state.status === 'waiting';
    const seated = state.players.filter((p) => !p.sittingOut && p.stack > 0).length;
    $('#start-btn').hidden = !(canStart && seated >= 2);
    $('#waiting-text').textContent =
      state.status === 'playing'
        ? '다른 플레이어의 액션을 기다리는 중…'
        : state.status === 'showdown'
        ? '핸드 종료 — 잠시 후 다음 핸드가 시작됩니다.'
        : seated >= 2
        ? state.you && state.you.isHost
          ? '준비 완료! 게임을 시작하세요.'
          : '방장이 게임을 시작하기를 기다리는 중…'
        : '친구를 초대해 주세요. 2명 이상이면 시작할 수 있습니다.';
    return;
  }

  waiting.hidden = true;
  panel.hidden = false;

  // 콜 / 체크
  $('#btn-call').textContent = legal.canCheck
    ? '체크'
    : legal.callAmount >= legal.maxRaiseTo - legal.myBet
    ? `올인 콜 ${fmt(legal.callAmount)}`
    : `콜 ${fmt(legal.callAmount)}`;
  // 체크가 무료인 상황에서는 폴드를 막아 실수 폴드를 방지한다
  $('#btn-fold').textContent = '폴드';
  $('#btn-fold').disabled = legal.canCheck;
  $('#btn-fold').title = legal.canCheck ? '체크가 가능하므로 폴드할 필요가 없습니다' : '';

  // 레이즈 가능 범위
  const canRaise = legal.canRaise && legal.maxRaiseTo > legal.minRaiseTo - 1;
  $('#btn-raise').disabled = !canRaise;
  document.querySelectorAll('#quick-row button, #bet-input, #bet-slider, .step').forEach((b) => (b.disabled = !canRaise));

  const slider = $('#bet-slider');
  slider.min = legal.minRaiseTo;
  slider.max = legal.maxRaiseTo;
  slider.step = 1;

  if (!betChips || betChips < legal.minRaiseTo || betChips > legal.maxRaiseTo) {
    betChips = legal.minRaiseTo;
  }
  syncBetUI();
}

function clampBet(v) {
  const legal = state && state.legal;
  if (!legal) return v;
  return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(v)));
}

function syncBetUI() {
  const legal = state && state.legal;
  if (!legal) return;
  betChips = clampBet(betChips);

  const bb = state.room.bigBlind;
  const input = $('#bet-input');
  if (unit === 'bb') {
    input.step = '0.5';
    input.value = Math.round((betChips / bb) * 10) / 10;
    $('#unit-label').textContent = 'BB';
    $('#bet-convert').textContent = `= ${fmt(betChips)} 칩`;
  } else {
    input.step = String(Math.max(1, Math.floor(bb / 10)));
    input.value = betChips;
    $('#unit-label').textContent = '칩';
    $('#bet-convert').textContent = `= ${toBB(betChips)} BB`;
  }
  $('#bet-slider').value = betChips;

  const isAllIn = betChips >= legal.maxRaiseTo;
  const verb = legal.currentBet > 0 ? '레이즈' : '벳';
  $('#btn-raise').textContent = isAllIn ? `올인 ${fmt(betChips)}` : `${verb} ${fmt(betChips)}`;
}

function setUnit(next) {
  unit = next;
  localStorage.setItem('poker:unit', unit);
  document.querySelectorAll('.unit-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.unit === unit));
  syncBetUI();
}

function quickAmount(kind) {
  const legal = state.legal;
  const bb = state.room.bigBlind;
  const potAfterCall = legal.pot + legal.callAmount;
  switch (kind) {
    case 'min': return legal.minRaiseTo;
    case '2bb': return 2 * bb;
    case '3bb': return 3 * bb;
    case 'half': return legal.currentBet + Math.round(potAfterCall * 0.5);
    case 'pot': return legal.currentBet + potAfterCall;
    case 'max': return legal.maxRaiseTo;
    default: return legal.minRaiseTo;
  }
}

/* -------------------------------------------------- 내 차례 신호 + 타이머 */

const HURRY_MS = 10000; // 이 아래로 남으면 붉게 재촉한다

/** 내 차례 여부에 따라 화면 가장자리 글로우 · 카운트다운 · 탭 제목을 맞춘다 */
function syncTurnSignals() {
  const myTurn = !!(state && state.legal);
  document.body.classList.toggle('my-turn', myTurn);
  $('#turn-head').hidden = !myTurn;
  if (!myTurn) {
    document.body.classList.remove('turn-hurry');
    stopTitleFlash();
    closeTurnNotification();
  } else if (document.hidden) {
    startTitleFlash();
  }
  startTimer();
}

function timeLeft() {
  return state && state.deadline ? Math.max(0, state.deadline - Date.now()) : 0;
}

function startTimer() {
  stopTimer();
  const bar = $('#timer');
  if (!state || state.status !== 'playing' || !state.deadline || !state.room.actionTime) {
    bar.style.width = '0%';
    $('#turn-count').textContent = '';
    document.body.classList.remove('turn-hurry');
    return;
  }
  const total = state.room.actionTime * 1000;
  const myTurn = !!state.legal;
  const count = $('#turn-count');

  const tick = () => {
    const left = timeLeft();
    const pct = (left / total) * 100;
    const hurry = left <= HURRY_MS;

    bar.style.width = pct + '%';
    bar.classList.toggle('danger', hurry);

    // 액션 중인 좌석은 매 렌더마다 새로 그려지므로 그때그때 찾는다
    const seatBar = document.querySelector('.seat.acting .seat-timer');
    if (seatBar) {
      seatBar.style.width = pct + '%';
      seatBar.classList.toggle('hurry', hurry);
    }

    if (myTurn) {
      const label = Math.ceil(left / 1000) + '초';
      if (count.textContent !== label) count.textContent = label;
      count.classList.toggle('hurry', hurry);
      document.body.classList.toggle('turn-hurry', hurry);
    }
    if (left > 0) timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  timerRAF = null;
  const bar = $('#timer');
  if (bar) bar.style.width = '0%';
}

/* ---------------------------------------------- 탭이 백그라운드일 때 (E) */

/** 다른 탭을 보고 있어도 알아챌 수 있도록 제목을 깜빡인다 */
function startTitleFlash() {
  if (titleTimer) return;
  const swap = () => {
    titleFlipped = !titleFlipped;
    const secs = Math.ceil(timeLeft() / 1000);
    document.title = titleFlipped ? `⏰ 내 차례!${secs > 0 ? ` (${secs}초)` : ''}` : BASE_TITLE;
  };
  swap();
  titleTimer = setInterval(swap, 900);
}

function stopTitleFlash() {
  if (titleTimer) clearInterval(titleTimer);
  titleTimer = null;
  titleFlipped = false;
  document.title = BASE_TITLE;
}

/** 액션 버튼을 처음 누를 때(= 확실한 사용자 조작) 알림 권한을 물어본다 */
function askNotifyPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  try {
    const r = Notification.requestPermission();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) {
    /* 권한 요청을 막는 브라우저 */
  }
}

function showTurnNotification() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  closeTurnNotification();
  try {
    turnNotification = new Notification('♠ 내 차례입니다', {
      body: `${state.room.name} — 지금 액션할 차례예요.`,
      tag: 'poker-my-turn',
    });
    turnNotification.onclick = () => {
      window.focus();
      closeTurnNotification();
    };
  } catch (_) {
    /* 알림을 지원하지 않는 환경 */
  }
}

function closeTurnNotification() {
  if (!turnNotification) return;
  try {
    turnNotification.close();
  } catch (_) {
    /* 이미 닫힘 */
  }
  turnNotification = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (state && state.legal) startTitleFlash();
    return;
  }
  stopTitleFlash();
  closeTurnNotification();
});

/* ------------------------------------------------------------- 이벤트 */

$('#btn-fold').addEventListener('click', () => {
  if (!state || !state.legal || state.legal.canCheck) return;
  askNotifyPermission();
  sendMsg({ type: 'action', action: 'fold' });
});
$('#btn-call').addEventListener('click', () => {
  if (!state || !state.legal) return;
  askNotifyPermission();
  sendMsg({ type: 'action', action: state.legal.canCheck ? 'check' : 'call' });
});
$('#btn-raise').addEventListener('click', () => {
  if (!state || !state.legal) return;
  askNotifyPermission();
  const amount = clampBet(betChips);
  sendMsg({ type: 'action', action: amount >= state.legal.maxRaiseTo ? 'allin' : 'raise', amount });
});

$('#bet-slider').addEventListener('input', (e) => {
  if (!state || !state.legal) return;
  betChips = Number(e.target.value);
  syncBetUI();
});

$('#bet-input').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || !state || !state.legal) return;
  betChips = unit === 'bb' ? Math.round(v * state.room.bigBlind) : Math.round(v);
  const legal = state.legal;
  if (legal) $('#bet-slider').value = clampBet(betChips);
  $('#bet-convert').textContent = unit === 'bb' ? `= ${fmt(clampBet(betChips))} 칩` : `= ${toBB(clampBet(betChips))} BB`;
  const isAllIn = legal && clampBet(betChips) >= legal.maxRaiseTo;
  $('#btn-raise').textContent = isAllIn
    ? `올인 ${fmt(clampBet(betChips))}`
    : `${legal && legal.currentBet > 0 ? '레이즈' : '벳'} ${fmt(clampBet(betChips))}`;
});
$('#bet-input').addEventListener('blur', syncBetUI);

$('#bet-plus').addEventListener('click', () => {
  if (!state || !state.legal) return;
  betChips = clampBet(betChips + (unit === 'bb' ? state.room.bigBlind : Math.max(1, Math.round(state.room.bigBlind / 2))));
  syncBetUI();
});
$('#bet-minus').addEventListener('click', () => {
  if (!state || !state.legal) return;
  betChips = clampBet(betChips - (unit === 'bb' ? state.room.bigBlind : Math.max(1, Math.round(state.room.bigBlind / 2))));
  syncBetUI();
});

document.querySelectorAll('.unit-toggle button').forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));
document.querySelectorAll('#quick-row button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!state || !state.legal) return;
    betChips = clampBet(quickAmount(b.dataset.quick));
    syncBetUI();
  })
);

$('#start-btn').addEventListener('click', () => sendMsg({ type: 'start' }));
$('#sitout-btn').addEventListener('click', () => sendMsg({ type: 'sitout', value: !(state?.you?.sittingOut) }));
$('#auto-next').addEventListener('change', (e) => sendMsg({ type: 'autoNext', value: e.target.checked }));
$('#rebuy-btn').addEventListener('click', () => {
  if (!state) return;
  const suggested = state.room.startingStack;
  const input = prompt(`추가할 칩 금액을 입력하세요 (BB ${fmt(state.room.bigBlind)})`, String(suggested));
  if (input === null) return;
  const amount = Math.floor(Number(input));
  if (!Number.isFinite(amount) || amount <= 0) return toast('올바른 금액을 입력해 주세요', true);
  sendMsg({ type: 'addChips', amount });
});

$('#leave-btn').addEventListener('click', () => {
  const warning = Net.isHost
    ? '방장이 나가면 방이 닫히고 모두의 게임이 종료됩니다. 나가시겠습니까?'
    : '테이블에서 나가시겠습니까?';
  if (!confirm(warning)) return;
  sendMsg({ type: 'leave' });
  setTimeout(() => (location.href = new URL('index.html' + location.search, location.href).href), 200);
});

$('#copy-link').addEventListener('click', async () => {
  const url = location.href.split('#')[0] + '#' + ROOM_ID;
  try {
    await navigator.clipboard.writeText(url);
    toast('초대 링크를 복사했습니다: ' + url);
  } catch (_) {
    prompt('아래 링크를 복사해서 친구에게 보내세요', url);
  }
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendMsg({ type: 'chat', text });
  input.value = '';
});

// 키보드 단축키: F 폴드 / C 콜·체크 / R 레이즈
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (!state?.legal) return;
  const k = e.key.toLowerCase();
  if (k === 'f') $('#btn-fold').click();
  else if (k === 'c') $('#btn-call').click();
  else if (k === 'r') $('#btn-raise').click();
});

// 화면 크기가 바뀌면 좌석 반지름을 다시 계산한다
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state && renderSeats(), 150);
});

setInterval(() => sendMsg({ type: 'ping' }), 25000);
setUnit(unit);
boot();
