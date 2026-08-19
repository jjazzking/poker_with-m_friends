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
let timerRAF = null;

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
  const rank = code.slice(0, -1);
  el.className = 'card' + (suit === 'h' || suit === 'd' ? ' red' : '');
  el.innerHTML = `<span class="r">${rank}</span><span class="s">${SUIT_SYMBOL[suit] || ''}</span>`;
  return el;
}

function render() {
  if (!state) return;

  $('#room-name').textContent = state.room.name;
  $('#blind-badge').textContent = `SB ${fmt(state.room.smallBlind)} / BB ${fmt(state.room.bigBlind)}`;
  $('#hand-badge').textContent = `#${state.handNo}`;
  // P2P 모드에서는 방장 탭이 곧 서버라서, 닫으면 방이 사라진다는 것을 알려 준다
  $('#host-badge').hidden = !(Net.mode === 'p2p' && Net.isHost);

  $('#pot').textContent = fmt(state.pot);
  $('#pot-bb').textContent = state.pot ? `(${toBB(state.pot)} BB)` : '';
  $('#street').textContent = state.status === 'playing' ? STREET_LABEL[state.street] || '' : '';

  const board = $('#board');
  board.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (state.board[i]) board.appendChild(cardEl(state.board[i]));
    else {
      const ph = document.createElement('div');
      ph.className = 'card placeholder';
      board.appendChild(ph);
    }
  }

  renderSeats();
  renderResults();
  renderLog();
  renderActions();
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
    (p.cards.length ? p.cards : []).forEach((c) => cards.appendChild(cardEl(c)));

    const info = document.createElement('div');
    info.className = 'seat-info';
    info.innerHTML = `
      <div class="seat-name">${p.seat === state.buttonSeat ? '<span class="dealer">D</span>' : ''}${escapeHtml(p.name)}${p.isHost ? ' 👑' : ''}</div>
      <div class="seat-stack">${fmt(p.stack)} <span class="sbb">(${toBB(p.stack)}BB)</span></div>
      ${p.handLabel ? `<div class="seat-hand">${p.handLabel}</div>` : ''}
      ${p.sittingOut ? '<div class="seat-tag">자리비움</div>' : ''}
      ${!p.connected ? '<div class="seat-tag off">연결끊김</div>' : ''}
    `;

    seat.appendChild(cards);
    seat.appendChild(info);

    if (p.lastAction) {
      const act = document.createElement('div');
      act.className = 'seat-action';
      act.textContent = p.lastAction;
      seat.appendChild(act);
    }
    if (p.bet > 0) {
      const bet = document.createElement('div');
      bet.className = 'seat-bet';
      bet.innerHTML = `<span class="chip"></span>${fmt(p.bet)}`;
      seat.appendChild(bet);
    }
    wrap.appendChild(seat);
  });
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
    stopTimer();
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
  startTimer();
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

/* 타이머 */
function startTimer() {
  stopTimer();
  const bar = $('#timer');
  if (!state.deadline || !state.room.actionTime) {
    bar.style.width = '0%';
    return;
  }
  const total = state.room.actionTime * 1000;
  const end = state.deadline;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    const pct = (left / total) * 100;
    bar.style.width = pct + '%';
    bar.classList.toggle('danger', pct < 25);
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

/* ------------------------------------------------------------- 이벤트 */

$('#btn-fold').addEventListener('click', () => {
  if (!state || !state.legal || state.legal.canCheck) return;
  sendMsg({ type: 'action', action: 'fold' });
});
$('#btn-call').addEventListener('click', () => {
  if (!state || !state.legal) return;
  sendMsg({ type: 'action', action: state.legal.canCheck ? 'check' : 'call' });
});
$('#btn-raise').addEventListener('click', () => {
  if (!state || !state.legal) return;
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
