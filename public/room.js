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

  // 방을 묻기 전에 서버를 먼저 깨운다.
  // 이 순서를 지키지 않으면 잠들어 있는 서버를 "방이 없다"고 오진한다.
  $('#connecting').hidden = false;
  connectingText('테이블에 연결하는 중…');
  await Net.warmUp({
    onStatus: (state, message) => message && connectingText(message),
  });

  const result = await Net.roomInfo(ROOM_ID);

  // 서버가 명확히 "그런 방 없다"고 답했을 때만 포기한다.
  // 닿지 못한 경우(unknown)는 그대로 접속을 시도하고, 판단은 WebSocket 에 맡긴다.
  if (result.status === 'missing') {
    return fatal(
      '방을 찾을 수 없습니다',
      '링크가 만료되었거나 잘못된 코드입니다. 서버가 재시작되면 방이 사라질 수 있으니, 새로 만들어 주세요.'
    );
  }

  const info = result.info || null;

  if (info) {
    $('#room-name').textContent = info.config.name;
    $('#blind-badge').textContent = `SB ${fmt(info.config.smallBlind)} / BB ${fmt(info.config.bigBlind)}`;
  }

  const name = localStorage.getItem(NAME_KEY);
  if (name) return connect(name);

  const modal = $('#name-modal');
  $('#connecting').hidden = true; // 모달 뒤에서 스피너가 돌 필요는 없다
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

/** 치명적 오류 화면으로 갈아탄 뒤에는 테이블 화면의 코드가 돌면 안 된다 */
let torndown = false;
let roomObserver = null; // 액션 바 높이 변화를 지켜보는 관찰자 (아래에서 붙인다)

function fatal(title, detail) {
  torndown = true;
  stopTimer();
  stopTitleFlash();
  if (roomObserver) roomObserver.disconnect();
  document.body.innerHTML =
    `<div class="fatal"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    `<a class="primary big" href="${new URL('index.html' + location.search, location.href).href}">새 방 만들기</a></div>`;
}

/** 연결이 될 때까지 스피너 아래 문구로 진행 상황을 알려 준다 */
function connectingText(text) {
  const el = $('#connecting-text');
  if (el) el.textContent = text;
}

function connect(name) {
  $('#connecting').hidden = false;
  connectingText('테이블에 연결하는 중…');
  const joining = Net.join({
    roomId: ROOM_ID,
    name,
    token: getToken(),
    handlers: {
      onState(msg) {
        if (torndown) return;
        $('#connecting').hidden = true;
        const prevActor = state ? state.actorSeat : undefined;
        state = msg;
        render();
        if (state.legal && prevActor !== state.actorSeat) notifyMyTurn();
      },
      onError(message) {
        // 아직 한 번도 상태를 못 받았다면 사라지는 토스트 대신 스피너에 이유를 남긴다
        if (!state) connectingText(message);
        else toast(message, true);
      },
      onFatal(message, title) {
        toast(message, true);
        setTimeout(() => fatal(title || '연결이 끊겼습니다', message), 1200);
      },
      onDisconnect() {
        if (!state) connectingText('연결이 끊겼습니다. 다시 연결 중…');
        else toast('연결이 끊겼습니다. 다시 연결 중…', true);
      },
      onHostReady() {
        toast('방이 열렸습니다. 초대 링크를 친구에게 보내세요!');
      },
    },
  });

  // 전송 계층 초기화 자체가 실패하면(스크립트 로드 실패 등) 조용히 멈추지 않게 한다
  Promise.resolve(joining).catch((err) => {
    fatal('연결에 실패했습니다', err && err.message ? err.message : '잠시 후 다시 시도해 주세요.');
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

/** 연결이 끊긴 자리에 남은 시간을 함께 보여 준다 */
function offlineLabel(p) {
  if (p.leaving) return '나가는 중';
  if (!p.dropAt) return '연결끊김';
  const left = Math.ceil((p.dropAt - Date.now()) / 1000);
  return left > 0 ? `연결끊김 ${left}초` : '연결끊김';
}

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
  const pending = state.pendingBlinds;
  $('#blind-badge').textContent =
    `SB ${fmt(state.room.smallBlind)} / BB ${fmt(state.room.bigBlind)}` +
    (pending ? ` → ${fmt(pending.smallBlind)}/${fmt(pending.bigBlind)}` : '');
  $('#blind-badge').title = pending ? '다음 핸드부터 바뀝니다' : '';
  $('#hand-badge').textContent = `#${state.handNo}`;
  // P2P 모드에서는 방장 탭이 곧 서버라서, 닫으면 방이 사라진다는 것을 알려 준다
  $('#host-badge').hidden = !(Net.mode === 'p2p' && Net.isHost);
  $('#pause-badge').hidden = !state.paused;

  const iAmHost = !!(state.you && state.you.isHost);
  $('#host-btn').hidden = !iAmHost;
  if (!iAmHost) $('#host-modal').hidden = true; // 방장을 넘겼으면 설정 창도 닫는다
  else if (!$('#host-modal').hidden) renderHostModal();

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
  renderWinOverlay();
  renderLog();
  renderActions();
  syncTurnSignals();
}

/** '내 패'와 남은 시간 중 하나라도 있을 때만 그 줄을 띄운다 */
function syncAbStrip() {
  $('#ab-strip').hidden = $('#made-hand').hidden && $('#turn-head').hidden;
}

function renderMadeHand() {
  const el = $('#made-hand');
  const made = state.you && state.you.made;
  if (!made || state.status === 'waiting') {
    el.hidden = true;
    syncAbStrip();
    return;
  }
  el.hidden = false;
  syncAbStrip();
  $('#mh-name').textContent = made.name;
  // 보드/홀카드와 같은 카드 모양으로 크게 보여 준다.
  // 여기 있는 카드는 전부 '내 패를 이루는 카드'라, 초록 테두리는 오히려 산만해서 뺀다.
  const cards = $('#mh-cards');
  cards.innerHTML = '';
  for (const c of made.cards) {
    const card = cardEl(c);
    card.classList.remove('used');
    cards.appendChild(card);
  }
}

/* ------------------------------------------------- 핸드 결과(승리) 화면 */

let winShownKey = null;   // 이미 띄운 결과 (같은 핸드에서 다시 띄우지 않도록)
let winHideTimer = null;

/** 이번 핸드의 결과를 한 덩어리로 요약한다 (팟이 여러 개면 사람별로 합친다) */
function winSummary() {
  if (!state || state.status !== 'showdown' || !state.results) return null;
  const pots = state.results.pots || [];
  if (!pots.length) return null;

  const byId = new Map();
  for (const pot of pots) {
    for (const w of pot.winners) {
      const cur = byId.get(w.id) || { id: w.id, name: w.name, hand: null, share: 0 };
      cur.share += w.share;
      if (w.hand) cur.hand = w.hand;
      byId.set(w.id, cur);
    }
  }

  const winners = [...byId.values()].sort((a, b) => b.share - a.share);
  const mine = state.you ? byId.get(state.you.id) : null;
  return {
    key: `${state.handNo}|${winners.map((w) => `${w.id}:${w.share}`).join(',')}`,
    winners,
    iWon: !!mine,
    myShare: mine ? mine.share : 0,
    total: pots.reduce((sum, pot) => sum + pot.amount, 0),
    showdown: !!state.results.showdown,
  };
}

function renderWinOverlay() {
  const sum = winSummary();
  if (!sum) {
    if (winShownKey) {
      winShownKey = null;
      hideWinOverlay();
    }
    return;
  }
  if (sum.key === winShownKey) return; // 같은 결과가 상태 갱신마다 다시 튀지 않게
  showWinOverlay(sum);
}

function showWinOverlay(sum) {
  winShownKey = sum.key;
  clearTimeout(winHideTimer);
  winHideTimer = null;

  const overlay = $('#win-overlay');
  const card = $('#win-card');
  const many = sum.winners.length > 1;

  const heading = sum.iWon
    ? many ? '분할 승리!' : '승리!'
    : many ? '팟 분할' : `${sum.winners[0].name} 승리`;

  const rows = sum.winners
    .map((w) => {
      const p = state.players.find((x) => x.id === w.id);
      const shown = p && p.cards.length && p.cards[0] !== '??' ? p.cards : [];
      return `
        <div class="win-row${state.you && w.id === state.you.id ? ' me' : ''}">
          <span class="wr-name">${escapeHtml(w.name)}</span>
          ${w.hand ? `<span class="wr-hand">${escapeHtml(w.hand)}</span>` : ''}
          <span class="wr-cards">${shown.map(miniCardHtml).join('')}</span>
          <span class="wr-share">+${fmt(w.share)}</span>
        </div>`;
    })
    .join('');

  card.className = 'win-card' + (sum.iWon ? ' mine' : '');
  card.innerHTML = `
    <div class="win-badge">${sum.iWon ? '🏆' : '♠'}</div>
    <div class="win-title">${escapeHtml(heading)}</div>
    <div class="win-amount">${sum.iWon ? '+' : ''}${fmt(sum.iWon ? sum.myShare : sum.total)}<span class="win-unit">칩</span></div>
    <div class="win-rows">${rows}</div>
    <div class="win-foot">${sum.showdown ? `팟 ${fmt(sum.total)}` : '모두 폴드'} · 누르면 닫힙니다</div>
  `;

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));

  // 쇼다운이 끝나기 전에 스스로 비켜 줘서, 공개된 카드를 볼 시간이 남게 한다
  winHideTimer = setTimeout(hideWinOverlay, sum.showdown ? 3400 : 1800);
}

function hideWinOverlay() {
  clearTimeout(winHideTimer);
  winHideTimer = null;
  const overlay = $('#win-overlay');
  if (overlay.hidden) return;
  overlay.classList.remove('show');
  winHideTimer = setTimeout(() => {
    overlay.hidden = true;
    winHideTimer = null;
  }, 220);
}

/** 결과 화면에 넣는 작은 카드 (문자열이라 innerHTML 로 붙일 수 있다) */
function miniCardHtml(code) {
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  const cls =
    'card mini' +
    (suit === 'h' || suit === 'd' ? ' red' : '') +
    (rank.length > 1 ? ' wide-rank' : '');
  return `<span class="${cls}"><span class="r">${escapeHtml(rank)}</span><span class="s">${SUIT_SYMBOL[suit] || ''}</span></span>`;
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
      ${!p.connected ? `<div class="seat-tag off"${p.dropAt ? ` data-until="${p.dropAt}"` : ''}>${escapeHtml(offlineLabel(p))}</div>` : ''}
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

/** 좌석의 '연결끊김' 태그에 남은 초를 1초마다 갱신한다 (끊긴 사람이 있을 때만 돈다) */
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

let lastLogCount = 0;

function renderLog() {
  const el = $('#log');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.innerHTML = state.log.map((l) => `<div class="log-line">${escapeHtml(l.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;

  // 접어 둔 상태에서 새 소식이 오면 버튼에 표시를 남긴다
  if (state.log.length > lastLogCount && sideEl.classList.contains('collapsed')) {
    sideEl.classList.add('has-new');
  }
  lastLogCount = state.log.length;
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
    const canStart = state.you && state.you.isHost && state.status === 'waiting' && !state.paused;
    const seated = state.players.filter((p) => !p.sittingOut && p.stack > 0).length;
    $('#start-btn').hidden = !(canStart && seated >= 2);

    if (state.paused && state.status !== 'playing') {
      $('#waiting-text').textContent = state.you && state.you.isHost
        ? '⏸ 일시정지됨 — 방장 설정에서 다시 시작할 수 있습니다.'
        : '⏸ 방장이 게임을 일시정지했습니다.';
      return;
    }

    // 올인으로 액션이 끝나면 아무도 기다릴 사람이 없다 (공개 → 보드 러너)
    const runout = state.status === 'playing' && state.actorSeat === null;
    $('#waiting-text').textContent =
      runout
        ? '올인 — 남은 보드를 봅니다…'
        : state.status === 'playing'
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
  syncAbStrip();
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
    // 일시정지 중에는 시계가 멈춰 있다는 것을 차례인 사람에게 알려 준다
    $('#turn-count').textContent = state && state.paused && state.legal ? '⏸ 일시정지' : '';
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

/* ------------------------------------------------------- 방장 설정 창 */

function openHostModal() {
  if (!state || !state.you || !state.you.isHost) return;
  $('#host-modal').hidden = false;
  // 열 때마다 지금 블라인드를 채워 둔다 (가장 흔한 조작이 '두 배')
  $('#blind-sb').value = state.pendingBlinds ? state.pendingBlinds.smallBlind : state.room.smallBlind;
  $('#blind-bb').value = state.pendingBlinds ? state.pendingBlinds.bigBlind : state.room.bigBlind;
  renderHostModal();
}

function renderHostModal() {
  if (!state) return;

  $('#pause-btn').textContent = state.paused ? '▶ 다시 시작' : '⏸ 일시정지';
  $('#pause-btn').classList.toggle('resume', state.paused);

  $('#blind-note').textContent =
    `현재 SB ${fmt(state.room.smallBlind)} / BB ${fmt(state.room.bigBlind)}` +
    (state.pendingBlinds
      ? ` · 다음 핸드부터 SB ${fmt(state.pendingBlinds.smallBlind)} / BB ${fmt(state.pendingBlinds.bigBlind)}`
      : state.status === 'playing'
      ? ' · 핸드 진행 중이라 다음 핸드부터 적용됩니다'
      : '');

  const wrap = $('#host-players');
  wrap.innerHTML = '';
  for (const p of state.players) {
    const row = document.createElement('div');
    row.className = 'host-player' + (p.isMe ? ' me' : '');

    const info = document.createElement('span');
    info.className = 'hp-info';
    const tags = [
      p.isHost ? '방장' : '',
      p.leaving ? '나가는 중' : '',
      !p.connected ? '연결끊김' : '',
      p.sittingOut ? '자리비움' : '',
    ].filter(Boolean);
    info.innerHTML =
      `<b>${escapeHtml(p.name)}</b> <span class="hp-stack">${fmt(p.stack)}</span>` +
      (tags.length ? ` <span class="hp-tag">${tags.join(' · ')}</span>` : '');
    row.appendChild(info);

    if (!p.isMe && !p.leaving) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost sm danger';
      btn.textContent = '내보내기';
      btn.addEventListener('click', () => {
        if (!confirm(`${p.name} 님을 테이블에서 내보낼까요?\n(같은 링크로는 다시 들어올 수 없습니다)`)) return;
        sendMsg({ type: 'kick', playerId: p.id });
      });
      row.appendChild(btn);
    }
    wrap.appendChild(row);
  }

  const banned = state.bannedCount || 0;
  const unban = $('#unban-btn');
  unban.hidden = banned === 0;
  unban.textContent = `내보낸 ${banned}명 다시 입장 허용`;
}

$('#host-btn').addEventListener('click', openHostModal);
$('#host-close').addEventListener('click', () => ($('#host-modal').hidden = true));
$('#host-modal').addEventListener('click', (e) => {
  if (e.target === $('#host-modal')) $('#host-modal').hidden = true; // 바깥을 누르면 닫기
});

$('#pause-btn').addEventListener('click', () => sendMsg({ type: 'pause', value: !state.paused }));
$('#unban-btn').addEventListener('click', () => sendMsg({ type: 'unban' }));

$('#blind-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const sb = Math.floor(Number($('#blind-sb').value));
  const bb = Math.floor(Number($('#blind-bb').value));
  if (!Number.isFinite(sb) || !Number.isFinite(bb) || sb < 1 || bb < 2 || sb > bb) {
    return toast('SB 는 1 이상, BB 는 2 이상이고 SB 보다 커야 합니다', true);
  }
  sendMsg({ type: 'setBlinds', smallBlind: sb, bigBlind: bb });
  toast(state.status === 'playing' ? '다음 핸드부터 적용됩니다' : '블라인드를 바꿨습니다');
});

// 프리셋은 입력칸만 채운다 — 실제 적용은 '적용' 을 눌러야 한다
document.querySelectorAll('#blind-presets button').forEach((b) =>
  b.addEventListener('click', () => {
    const mul = Number(b.dataset.mul);
    const bb = Math.max(2, Math.round(state.room.bigBlind * mul));
    $('#blind-bb').value = bb;
    $('#blind-sb').value = Math.max(1, Math.round(bb / 2));
  })
);

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendMsg({ type: 'chat', text });
  input.value = '';
});

// 결과 화면은 눌러서 바로 치울 수 있다 (다음 핸드를 기다리지 않아도 되도록)
$('#win-overlay').addEventListener('click', hideWinOverlay);

// 키보드 단축키: F 폴드 / C 콜·체크 / R 레이즈
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    $('#host-modal').hidden = true;
    return hideWinOverlay();
  }
  if (!state?.legal) return;
  const k = e.key.toLowerCase();
  if (k === 'f') $('#btn-fold').click();
  else if (k === 'c') $('#btn-call').click();
  else if (k === 'r') $('#btn-raise').click();
});

// 화면 크기가 바뀌면 좌석 반지름을 다시 계산한다
let resizeTimer = null;
window.addEventListener('resize', () => {
  applySideSize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state && renderSeats(), 150);
});

/* ----------------------------------------- 채팅창(사이드 패널) 크기 조절 */

const SIDE_W_KEY = 'poker:sideW';
const SIDE_H_KEY = 'poker:sideH';
const SIDE_COLLAPSED_KEY = 'poker:sideCollapsed';

const SIDE_DEFAULT_W = 300;   // 넓은 화면 기본 너비
const SIDE_MIN_W = 200;
const SIDE_MIN_H = 150;       // 최소한 로그 두어 줄 + 입력창은 보이도록
                              // (더 줄이고 싶으면 접기 버튼을 쓴다)
const TABLE_MIN_W = 300;      // 테이블에 남겨 두는 최소 공간
const TABLE_MIN_H = 200;

const sideEl = $('#side');
const sideResizer = $('#side-resizer');
const sideToggle = $('#side-toggle');

/** 채팅창이 테이블 아래로 깔리는 배치인지 — style.css 의 미디어 쿼리와 같은 기준 */
const SIDE_STACKED_MQ = '(max-width: 900px) and (orientation: portrait)';
const isNarrowSide = () => window.matchMedia(SIDE_STACKED_MQ).matches;
const roomBox = () => {
  const el = $('.room');
  return el ? el.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
};

let sideW = Number(localStorage.getItem(SIDE_W_KEY)) || SIDE_DEFAULT_W;
let sideH = Number(localStorage.getItem(SIDE_H_KEY)) || 0; // 0 = 아직 정한 적 없음

function clampSideW(w) {
  const max = Math.max(SIDE_MIN_W, roomBox().width - TABLE_MIN_W);
  return Math.round(Math.min(Math.max(w, SIDE_MIN_W), max));
}
function clampSideH(h) {
  const max = Math.max(SIDE_MIN_H, roomBox().height - TABLE_MIN_H);
  return Math.round(Math.min(Math.max(h, SIDE_MIN_H), max));
}
function defaultSideH() {
  return clampSideH(window.innerHeight * 0.38);
}
function currentSideH() {
  return sideH ? clampSideH(sideH) : defaultSideH();
}

function applySideSize() {
  if (torndown) return;
  const root = document.documentElement.style;
  root.setProperty('--side-w', clampSideW(sideW) + 'px');
  root.setProperty('--side-h', currentSideH() + 'px');
  sideResizer.setAttribute('aria-orientation', isNarrowSide() ? 'horizontal' : 'vertical');
}

function setSideCollapsed(collapsed) {
  sideEl.classList.toggle('collapsed', collapsed);
  if (!collapsed) sideEl.classList.remove('has-new');
  sideToggle.setAttribute('aria-expanded', String(!collapsed));
  sideToggle.title = collapsed ? '채팅창 펼치기' : '채팅창 접기';
  localStorage.setItem(SIDE_COLLAPSED_KEY, collapsed ? '1' : '0');
  if (!collapsed) scrollLogToBottom();
}

function scrollLogToBottom() {
  const log = $('#log');
  log.scrollTop = log.scrollHeight;
}

let sideDrag = null;

sideResizer.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  // 접혀 있는 상태에서 끌면 자연스럽게 펼치면서 크기를 잡는다
  if (sideEl.classList.contains('collapsed')) setSideCollapsed(false);

  const box = sideEl.getBoundingClientRect();
  sideDrag = {
    id: e.pointerId,
    narrow: isNarrowSide(),
    x: e.clientX,
    y: e.clientY,
    w: box.width,
    h: box.height,
  };
  sideResizer.setPointerCapture(e.pointerId);
  sideResizer.classList.add('dragging');
  document.body.classList.add('resizing-side', sideDrag.narrow ? 'row' : 'col');
  e.preventDefault();
});

sideResizer.addEventListener('pointermove', (e) => {
  if (!sideDrag || e.pointerId !== sideDrag.id) return;
  if (sideDrag.narrow) sideH = clampSideH(sideDrag.h - (e.clientY - sideDrag.y));
  else sideW = clampSideW(sideDrag.w - (e.clientX - sideDrag.x));
  applySideSize();
});

function endSideDrag(e) {
  if (!sideDrag || (e && e.pointerId !== sideDrag.id)) return;
  saveSideSize(sideDrag.narrow);
  sideResizer.classList.remove('dragging');
  document.body.classList.remove('resizing-side', 'row', 'col');
  sideDrag = null;
  scrollLogToBottom();
  if (state) renderSeats();
}
sideResizer.addEventListener('pointerup', endSideDrag);
sideResizer.addEventListener('pointercancel', endSideDrag);

function saveSideSize(narrow) {
  if (narrow) localStorage.setItem(SIDE_H_KEY, String(currentSideH()));
  else localStorage.setItem(SIDE_W_KEY, String(clampSideW(sideW)));
}

// 더블클릭(더블탭)하면 기본 크기로 되돌린다
sideResizer.addEventListener('dblclick', () => {
  const narrow = isNarrowSide();
  if (narrow) sideH = defaultSideH();
  else sideW = SIDE_DEFAULT_W;
  applySideSize();
  saveSideSize(narrow);
  scrollLogToBottom();
});

// 키보드로도 조절할 수 있게 (손잡이에 포커스 후 방향키, Shift 로 큰 폭)
sideResizer.addEventListener('keydown', (e) => {
  const narrow = isNarrowSide();
  const step = e.shiftKey ? 48 : 16;
  let delta = 0;
  if (narrow) {
    if (e.key === 'ArrowUp') delta = step;
    else if (e.key === 'ArrowDown') delta = -step;
  } else {
    if (e.key === 'ArrowLeft') delta = step;
    else if (e.key === 'ArrowRight') delta = -step;
  }
  if (!delta) return;
  e.preventDefault();
  if (sideEl.classList.contains('collapsed')) setSideCollapsed(false);
  if (narrow) sideH = clampSideH(currentSideH() + delta);
  else sideW = clampSideW(sideW + delta);
  applySideSize();
  saveSideSize(narrow);
});

sideToggle.addEventListener('click', () => setSideCollapsed(!sideEl.classList.contains('collapsed')));

// 좁은 화면에서 메시지를 입력하려고 하면 접혀 있어도 펼쳐 준다
$('#chat-input').addEventListener('focus', () => {
  if (sideEl.classList.contains('collapsed')) setSideCollapsed(false);
});

// 액션 바가 커졌다 작아졌다 하면 남는 공간도 바뀐다.
// 저장해 둔 크기는 그대로 두고, 표시 크기만 다시 맞춰 테이블이 눌리지 않게 한다.
if (window.ResizeObserver) {
  roomObserver = new ResizeObserver(() => applySideSize());
  roomObserver.observe($('.room'));
}

setSideCollapsed(localStorage.getItem(SIDE_COLLAPSED_KEY) === '1');
applySideSize();

setInterval(() => sendMsg({ type: 'ping' }), 25000);
setUnit(unit);
boot();
