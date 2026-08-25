'use strict';
/**
 * 테이블(한 방)의 게임 상태 머신.
 * 서버 모드에서는 Node 프로세스가, GitHub Pages P2P 모드에서는 호스트 브라우저가 이 코드를 돌린다.
 */
// 브라우저에서는 모든 스크립트가 같은 전역 스코프를 공유하므로 이름을 풀어 두지 않는다
const PokerLib = typeof require === 'function' ? require('./poker') : globalThis.Poker;

const MAX_SEATS = 9;
const SHOWDOWN_DELAY = 6000;
const FOLD_END_DELAY = 2500;
const RUNOUT_DELAY = 1400;
// 연결이 끊긴 사람을 자리비움 처리하기까지 기다리는 시간.
// 새로고침이나 잠깐의 네트워크 끊김으로 곧바로 빠지지 않을 만큼은 줘야 한다.
const DISCONNECT_GRACE_MS = 30000;

let nextPlayerId = 1;

class Table {
  /**
   * @param {string} id 방 코드
   * @param {object} config { name, smallBlind, bigBlind, startingStack, maxPlayers, actionTime }
   * @param {Function} onChange 상태가 바뀔 때마다 호출되는 브로드캐스트 콜백
   */
  constructor(id, config, onChange) {
    this.id = id;
    this.config = config;
    this.onChange = onChange || (() => {});

    this.players = new Map(); // token -> player
    this.hostToken = null;
    this.status = 'waiting'; // waiting | playing | showdown
    this.street = null; // preflop | flop | turn | river
    this.board = [];
    this.deck = [];
    this.buttonSeat = null;
    this.actorSeat = null;
    this.currentBet = 0;
    this.minRaise = config.bigBlind;
    this.handNo = 0;
    this.log = [];
    this.results = null;
    this.deadline = null;
    this.timers = [];
    this.dropTimers = new Map(); // token -> 연결 끊김 퇴장 타이머
    this.disconnectGrace = config.disconnectGrace ?? DISCONNECT_GRACE_MS;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.autoNext = true;
    // 테스트에서 짧게 줄일 수 있도록 딜레이를 설정으로 노출한다
    this.delays = {
      showdown: config.showdownDelay ?? SHOWDOWN_DELAY,
      fold: config.foldDelay ?? FOLD_END_DELAY,
      runout: config.runoutDelay ?? RUNOUT_DELAY,
    };
  }

  /* ------------------------------------------------------------ 플레이어 */

  seatTaken(seat) {
    for (const p of this.players.values()) if (p.seat === seat) return true;
    return false;
  }

  freeSeat() {
    for (let s = 0; s < this.config.maxPlayers; s++) if (!this.seatTaken(s)) return s;
    return -1;
  }

  makePlayer(token, name, seat, stack) {
    return {
      id: 'P' + nextPlayerId++,
      token,
      name: (name || '플레이어').slice(0, 14),
      seat,
      stack,
      connected: true,
      sittingOut: false,
      autoSatOut: false, // 연결이 끊겨서 자리비움된 경우에만 true
      leaving: false,    // 핸드가 끝나면 자리에서 빠진다
      dropAt: null,      // 연결이 끊긴 사람이 자동 자리비움되는 시각
      // 핸드 단위 상태
      inHand: false,
      cards: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      lastAction: null,
      handLabel: null,
      won: 0,
    };
  }

  addPlayer(token, name) {
    const existing = this.players.get(token);
    if (existing) {
      existing.name = name || existing.name;
      existing.leaving = false; // 돌아왔으니 내보내지 않는다
      this.markReconnected(existing);
      this.touch();
      return existing;
    }
    const seat = this.freeSeat();
    if (seat < 0) throw new Error('자리가 가득 찼습니다 (최대 ' + this.config.maxPlayers + '명)');

    const player = this.makePlayer(token, name, seat, this.config.startingStack);
    this.players.set(token, player);
    if (!this.hostToken) this.hostToken = token;
    this.pushLog(`${player.name} 님이 입장했습니다.`);
    this.touch();
    return player;
  }

  /**
   * 호스트 브라우저가 새로고침돼도 스택이 날아가지 않도록 저장/복원한다.
   * (P2P 모드에서 호스트 탭이 곧 서버이므로 필요하다)
   */
  snapshot() {
    return {
      handNo: this.handNo,
      buttonSeat: this.buttonSeat,
      hostToken: this.hostToken,
      players: this.seatedPlayers().map((p) => ({
        token: p.token,
        name: p.name,
        seat: p.seat,
        stack: p.stack,
        sittingOut: p.sittingOut,
      })),
    };
  }

  restore(snap) {
    if (!snap || !Array.isArray(snap.players)) return;
    for (const s of snap.players) {
      if (this.players.has(s.token) || s.seat >= this.config.maxPlayers) continue;
      const p = this.makePlayer(s.token, s.name, s.seat, Math.max(0, Math.floor(s.stack) || 0));
      p.sittingOut = !!s.sittingOut;
      this.players.set(s.token, p);
      this.markDisconnected(p); // 실제로 다시 붙을 때까지는 끊긴 상태로 둔다
    }
    this.handNo = Number(snap.handNo) || 0;
    this.buttonSeat = typeof snap.buttonSeat === 'number' ? snap.buttonSeat : null;
    if (snap.hostToken && this.players.has(snap.hostToken)) this.hostToken = snap.hostToken;
    this.pushLog('이전 테이블 상태를 복원했습니다.');
  }

  removePlayer(token) {
    const p = this.players.get(token);
    if (!p) return;
    this.cancelDrop(token);

    if (p.inHand && this.status === 'playing' && !p.folded) {
      // 진행 중인 핸드에서는 폴드만 시키고 자리는 남겨 둔다.
      // 여기서 바로 지우면 이 사람이 팟에 넣은 칩이 pot() 계산에서 통째로
      // 사라져 버린다. 실제 정리는 핸드가 끝난 뒤 purgeLeaving() 이 한다.
      p.folded = true;
      p.hasActed = true;
      p.lastAction = '폴드';
      p.leaving = true;
      this.pushLog(`${p.name} 님이 나가서 폴드 처리되었습니다.`);
      if (this.hostToken === token) this.reassignHost();
      if (this.actorSeat === p.seat) this.advance();
      else this.checkAloneWinner();
      this.touch();
      return;
    }

    this.players.delete(token);
    this.pushLog(`${p.name} 님이 나갔습니다.`);
    if (this.hostToken === token) this.reassignHost();
    this.touch();
  }

  /** 핸드가 끝난 뒤, 나가기로 표시된 사람들을 실제로 자리에서 뺀다 */
  purgeLeaving() {
    let removed = 0;
    for (const [token, p] of [...this.players]) {
      if (!p.leaving) continue;
      this.players.delete(token);
      this.cancelDrop(token);
      if (this.hostToken === token) this.reassignHost();
      removed++;
    }
    return removed;
  }

  reassignHost() {
    // 나가는 중인 사람에게 방장을 넘기면 곧바로 다시 넘겨야 한다
    const next = [...this.players.values()].find((p) => !p.leaving);
    this.hostToken = next ? next.token : null;
  }

  setConnected(token, connected) {
    const p = this.players.get(token);
    if (!p) return;
    if (connected) {
      p.leaving = false;
      this.markReconnected(p);
    } else {
      this.markDisconnected(p);
    }
    this.touch();
  }

  markDisconnected(p) {
    if (!p.connected) return; // 이미 끊긴 것으로 처리했다
    p.connected = false;
    this.scheduleDrop(p.token);
  }

  markReconnected(p) {
    p.connected = true;
    this.cancelDrop(p.token);
    if (!p.autoSatOut) return;
    // 연결이 끊겨서 비워진 자리만 자동으로 되돌린다. 직접 고른 자리비움은 그대로 둔다.
    p.autoSatOut = false;
    p.sittingOut = false;
    this.pushLog(`${p.name} 님이 다시 연결되어 참가합니다.`);
    this.maybeAutoStart();
  }

  /**
   * 연결이 끊긴 사람을 유예 시간 뒤에 자리비움 처리한다.
   * 그 사이에 돌아오면 cancelDrop() 으로 없던 일이 된다.
   */
  scheduleDrop(token) {
    this.cancelDrop(token);
    const p = this.players.get(token);
    if (!p || !this.disconnectGrace) return;

    p.dropAt = Date.now() + this.disconnectGrace;
    const timer = setTimeout(() => {
      this.dropTimers.delete(token);
      this.dropDisconnected(token);
    }, this.disconnectGrace);

    if (typeof timer.unref === 'function') timer.unref();
    this.dropTimers.set(token, timer);
  }

  /**
   * 유예 시간이 지나도 돌아오지 않으면 자리를 비운다.
   * 자리에서 아예 빼지 않는 이유는 스택을 지켜 주기 위해서다. 돌아오면
   * markReconnected() 가 다시 참가시킨다.
   */
  dropDisconnected(token) {
    const p = this.players.get(token);
    if (!p || p.connected) return; // 그새 돌아왔다
    p.dropAt = null;

    if (!p.sittingOut) {
      p.sittingOut = true;
      p.autoSatOut = true;
      const secs = Math.round(this.disconnectGrace / 1000);
      this.pushLog(`${p.name} 님의 연결이 ${secs}초 이상 끊겨 자리비움 처리되었습니다.`);
    }

    // 방장이 끊긴 채로 남으면 아무도 게임을 시작할 수 없다. 자리는 지켜 주되 권한은 넘긴다.
    if (this.hostToken === token) {
      const next = [...this.players.values()].find((q) => q.connected && !q.leaving);
      if (next) {
        this.hostToken = next.token;
        this.pushLog(`${next.name} 님이 새 방장이 되었습니다.`);
      }
    }

    // 진행 중인 핸드를 붙잡고 있으면 폴드시켜 다음 사람으로 넘긴다
    if (this.status === 'playing' && p.inHand && !p.folded) {
      p.folded = true;
      p.hasActed = true;
      p.lastAction = '폴드';
      this.pushLog(`${p.name} 님이 연결 끊김으로 폴드 처리되었습니다.`);
      if (this.actorSeat === p.seat) this.advance();
      else this.checkAloneWinner();
      this.touch();
      return;
    }

    // 남은 사람만으로 다음 핸드를 시작할 수 있으면 이어서 진행한다
    if (this.status === 'waiting') this.maybeAutoStart();
    this.touch();
  }

  cancelDrop(token) {
    const timer = this.dropTimers.get(token);
    if (timer) clearTimeout(timer);
    this.dropTimers.delete(token);
    const p = this.players.get(token);
    if (p) p.dropAt = null;
  }

  clearDropTimers() {
    for (const timer of this.dropTimers.values()) clearTimeout(timer);
    this.dropTimers.clear();
  }

  /** 방을 버릴 때 이 테이블이 잡고 있는 타이머를 전부 정리한다 */
  dispose() {
    this.clearTimers();
    this.clearDropTimers();
  }

  setSitOut(token, value) {
    const p = this.players.get(token);
    if (!p) return;
    p.sittingOut = !!value;
    p.autoSatOut = false; // 직접 고른 선택이므로 재접속해도 뒤집지 않는다
    this.pushLog(`${p.name} 님이 ${value ? '자리를 비웠습니다' : '다시 참가합니다'}.`);
    if (!value && this.status === 'waiting') this.maybeAutoStart();
    this.touch();
  }

  addChips(token, amount) {
    const p = this.players.get(token);
    if (!p) return;
    const amt = Math.max(0, Math.floor(amount));
    if (!amt) return;
    if (p.inHand && this.status === 'playing') throw new Error('핸드가 끝난 뒤에 칩을 추가할 수 있습니다');
    p.stack += amt;
    if (p.sittingOut) p.sittingOut = false; // 칩을 넣었으면 다시 참가 상태로
    this.pushLog(`${p.name} 님이 ${amt.toLocaleString()} 칩을 추가했습니다.`);
    this.maybeAutoStart();
    this.touch();
  }

  /* ------------------------------------------------------------ 유틸 */

  seatedPlayers() {
    return [...this.players.values()].sort((a, b) => a.seat - b.seat);
  }

  playerAtSeat(seat) {
    for (const p of this.players.values()) if (p.seat === seat) return p;
    return null;
  }

  eligiblePlayers() {
    return this.seatedPlayers().filter((p) => !p.sittingOut && p.stack > 0 && !p.leaving);
  }

  playersInHand() {
    return this.seatedPlayers().filter((p) => p.inHand && !p.folded);
  }

  /** seat 다음 자리부터 조건에 맞는 첫 플레이어 */
  nextPlayer(fromSeat, filter) {
    const seats = this.config.maxPlayers;
    for (let i = 1; i <= seats; i++) {
      const seat = (fromSeat + i) % seats;
      const p = this.playerAtSeat(seat);
      if (p && filter(p)) return p;
    }
    return null;
  }

  pot() {
    let sum = 0;
    for (const p of this.players.values()) sum += p.totalBet;
    return sum;
  }

  pushLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 60) this.log.shift();
  }

  touch() {
    this.lastActivity = Date.now();
    this.onChange();
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.deadline = null;
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      try {
        fn();
      } catch (err) {
        console.error('[table]', this.id, err);
      }
    }, ms);
    this.timers.push(t);
    return t;
  }

  /* ------------------------------------------------------------ 핸드 진행 */

  maybeAutoStart() {
    if (this.status !== 'waiting') return;
    if (this.eligiblePlayers().length >= 2 && this.handNo > 0 && this.autoNext) this.startHand();
  }

  startHand() {
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) {
      this.status = 'waiting';
      this.touch();
      throw new Error('게임을 시작하려면 칩을 가진 플레이어가 2명 이상 필요합니다');
    }

    this.clearTimers();
    this.handNo++;
    this.status = 'playing';
    this.street = 'preflop';
    this.board = [];
    this.results = null;
    this.deck = PokerLib.newShuffledDeck();
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;

    for (const p of this.players.values()) {
      p.cards = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = false;
      p.allIn = false;
      p.hasActed = false;
      p.lastAction = null;
      p.handLabel = null;
      p.won = 0;
      p.inHand = eligible.includes(p);
    }

    // 딜러 버튼 이동
    if (this.buttonSeat === null) this.buttonSeat = eligible[0].seat;
    else {
      const next = this.nextPlayer(this.buttonSeat, (p) => p.inHand);
      this.buttonSeat = next.seat;
    }

    // 홀카드 랜덤 배분 (버튼 다음부터 한 장씩 두 바퀴)
    const order = [];
    let cursor = this.buttonSeat;
    for (let i = 0; i < eligible.length; i++) {
      const p = this.nextPlayer(cursor, (x) => x.inHand);
      order.push(p);
      cursor = p.seat;
    }
    for (let round = 0; round < 2; round++) {
      for (const p of order) p.cards.push(this.deck.pop());
    }

    // 블라인드
    const headsUp = order.length === 2;
    const sbPlayer = headsUp ? this.playerAtSeat(this.buttonSeat) : order[0];
    const bbPlayer = headsUp ? order[0] : order[1];
    this.postBlind(sbPlayer, this.config.smallBlind, 'SB');
    this.postBlind(bbPlayer, this.config.bigBlind, 'BB');
    this.currentBet = Math.max(sbPlayer.bet, bbPlayer.bet, this.config.bigBlind);

    const first = this.nextPlayer(bbPlayer.seat, (p) => p.inHand && !p.allIn);
    this.actorSeat = first ? first.seat : null;
    this.sbSeat = sbPlayer.seat;
    this.bbSeat = bbPlayer.seat;

    this.pushLog(`--- #${this.handNo} 핸드 시작 (SB ${this.config.smallBlind} / BB ${this.config.bigBlind}) ---`);
    this.startActionTimer();

    if (this.actorSeat === null) this.advance();
    else this.touch();
  }

  postBlind(player, amount, label) {
    const amt = Math.min(amount, player.stack);
    player.stack -= amt;
    player.bet += amt;
    player.totalBet += amt;
    player.lastAction = label;
    if (player.stack === 0) player.allIn = true;
  }

  startActionTimer() {
    this.deadline = null;
    if (!this.config.actionTime || this.actorSeat === null) return;
    this.deadline = Date.now() + this.config.actionTime * 1000;
    const seat = this.actorSeat;
    const hand = this.handNo;
    this.later(() => {
      if (this.status !== 'playing' || this.actorSeat !== seat || this.handNo !== hand) return;
      const p = this.playerAtSeat(seat);
      if (!p) return;
      const canCheck = p.bet === this.currentBet;
      this.pushLog(`${p.name} 님 시간 초과 — 자동 ${canCheck ? '체크' : '폴드'}`);
      this.applyAction(p, canCheck ? 'check' : 'fold');
    }, this.config.actionTime * 1000 + 500);
  }

  /** 외부 진입점: 토큰으로 액션 실행 */
  act(token, action, amount) {
    const p = this.players.get(token);
    if (!p) throw new Error('플레이어를 찾을 수 없습니다');
    if (this.status !== 'playing') throw new Error('지금은 액션할 수 없습니다');
    if (p.seat !== this.actorSeat) throw new Error('아직 차례가 아닙니다');
    this.applyAction(p, action, amount);
  }

  applyAction(p, action, amount) {
    const toCall = this.currentBet - p.bet;

    switch (action) {
      case 'fold': {
        if (toCall === 0) {
          // 체크가 가능하면 폴드 대신 체크로 보호
          p.lastAction = '체크';
          p.hasActed = true;
          this.pushLog(`${p.name}: 체크`);
          break;
        }
        p.folded = true;
        p.hasActed = true;
        p.lastAction = '폴드';
        this.pushLog(`${p.name}: 폴드`);
        break;
      }
      case 'check': {
        if (toCall > 0) throw new Error('체크할 수 없습니다 — 콜 또는 폴드하세요');
        p.hasActed = true;
        p.lastAction = '체크';
        this.pushLog(`${p.name}: 체크`);
        break;
      }
      case 'call': {
        if (toCall <= 0) throw new Error('콜할 금액이 없습니다');
        const paid = this.commit(p, toCall);
        p.hasActed = true;
        p.lastAction = p.allIn ? `올인 ${paid.toLocaleString()}` : `콜 ${paid.toLocaleString()}`;
        this.pushLog(`${p.name}: ${p.lastAction}`);
        break;
      }
      case 'allin': {
        const target = p.bet + p.stack;
        this.raiseTo(p, target, true);
        break;
      }
      case 'raise':
      case 'bet': {
        const target = Math.floor(Number(amount));
        if (!Number.isFinite(target)) throw new Error('베팅 금액이 올바르지 않습니다');
        this.raiseTo(p, target, false);
        break;
      }
      default:
        throw new Error('알 수 없는 액션입니다');
    }

    this.advance();
  }

  /** 스택에서 amount 만큼(부족하면 전부) 베팅에 넣는다 */
  commit(p, amount) {
    const paid = Math.min(Math.max(0, Math.floor(amount)), p.stack);
    p.stack -= paid;
    p.bet += paid;
    p.totalBet += paid;
    if (p.stack === 0) p.allIn = true;
    return paid;
  }

  raiseTo(p, target, isAllIn) {
    const maxTarget = p.bet + p.stack;
    if (target > maxTarget) target = maxTarget;
    const isShove = target === maxTarget;

    if (target <= this.currentBet) {
      if (isShove) {
        // 콜보다 적은 올인
        const paid = this.commit(p, target - p.bet);
        p.hasActed = true;
        p.lastAction = `올인 ${paid.toLocaleString()}`;
        this.pushLog(`${p.name}: ${p.lastAction}`);
        return;
      }
      throw new Error(`최소 ${(this.currentBet + this.minRaise).toLocaleString()} 이상으로 올려야 합니다`);
    }

    const raiseSize = target - this.currentBet;
    if (raiseSize < this.minRaise && !isShove) {
      throw new Error(`최소 레이즈는 ${(this.currentBet + this.minRaise).toLocaleString()} 까지입니다`);
    }

    const wasBet = this.currentBet > 0;
    this.commit(p, target - p.bet);

    const fullRaise = raiseSize >= this.minRaise;
    if (fullRaise) this.minRaise = raiseSize;
    this.currentBet = target;

    // 풀 레이즈면 이미 액션한 플레이어들에게 액션이 다시 열린다
    if (fullRaise) {
      for (const other of this.players.values()) {
        if (other !== p && other.inHand && !other.folded && !other.allIn) other.hasActed = false;
      }
    }
    p.hasActed = true;

    const label = p.allIn
      ? `올인 ${target.toLocaleString()}`
      : `${wasBet ? '레이즈' : '벳'} ${target.toLocaleString()}`;
    p.lastAction = label;
    this.pushLog(`${p.name}: ${label}`);
  }

  /* ------------------------------------------------------------ 진행 판정 */

  roundComplete() {
    const active = this.playersInHand();
    const canAct = active.filter((p) => !p.allIn);
    if (canAct.length === 0) return true;
    if (canAct.length === 1 && active.length === 1) return true;
    for (const p of canAct) {
      if (!p.hasActed) return false;
      if (p.bet !== this.currentBet) return false;
    }
    return true;
  }

  checkAloneWinner() {
    const active = this.playersInHand();
    if (active.length === 1) {
      this.awardUncontested(active[0]);
      return true;
    }
    return false;
  }

  advance() {
    this.clearTimers();
    if (this.status !== 'playing') return;

    if (this.checkAloneWinner()) return;

    if (this.roundComplete()) {
      this.nextStreet();
      return;
    }

    const start = this.actorSeat === null ? this.buttonSeat : this.actorSeat;
    const next = this.nextPlayer(start, (p) => p.inHand && !p.folded && !p.allIn && (!p.hasActed || p.bet !== this.currentBet));
    if (!next) {
      this.nextStreet();
      return;
    }
    this.actorSeat = next.seat;
    this.startActionTimer();
    this.touch();
  }

  collectBets() {
    for (const p of this.players.values()) {
      p.bet = 0;
      p.hasActed = false;
      if (!p.folded) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.config.bigBlind;
  }

  dealBoard(n) {
    this.deck.pop(); // 번 카드
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop());
  }

  nextStreet() {
    this.collectBets();

    if (this.street === 'river') {
      this.showdown();
      return;
    }

    const nextName = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.street];
    this.street = nextName;
    this.dealBoard(nextName === 'flop' ? 3 : 1);
    this.pushLog(`[${{ flop: '플랍', turn: '턴', river: '리버' }[nextName]}] ${this.board.map(PokerLib.cardCode).join(' ')}`);

    const active = this.playersInHand();
    const canAct = active.filter((p) => !p.allIn);

    // 액션 가능한 플레이어가 1명 이하 → 남은 보드를 자동으로 깐다
    if (canAct.length <= 1) {
      this.actorSeat = null;
      this.touch();
      this.later(() => this.nextStreet(), this.delays.runout);
      return;
    }

    const first = this.nextPlayer(this.buttonSeat, (p) => p.inHand && !p.folded && !p.allIn);
    this.actorSeat = first ? first.seat : null;
    this.startActionTimer();
    this.touch();
  }

  /* ------------------------------------------------------------ 정산 */

  buildPots() {
    const contributors = this.seatedPlayers().filter((p) => p.totalBet > 0);
    const levels = [...new Set(contributors.map((p) => p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      const eligible = [];
      for (const p of contributors) {
        if (p.totalBet > prev) {
          amount += Math.min(p.totalBet, level) - prev;
          if (!p.folded && p.inHand) eligible.push(p);
        }
      }
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // 참가자 구성이 같은 팟은 병합
    const merged = [];
    for (const pot of pots) {
      const key = pot.eligible.map((p) => p.id).sort().join(',');
      const last = merged[merged.length - 1];
      if (last && last.key === key) last.amount += pot.amount;
      else merged.push({ ...pot, key });
    }
    return merged;
  }

  awardUncontested(winner) {
    const total = this.pot();
    winner.stack += total;
    winner.won = total;
    this.results = {
      showdown: false,
      pots: [{ amount: total, winners: [{ id: winner.id, name: winner.name, share: total }] }],
    };
    this.pushLog(`${winner.name} 님이 ${total.toLocaleString()} 칩을 획득했습니다 (모두 폴드).`);
    this.endHand(this.delays.fold);
  }

  showdown() {
    const active = this.playersInHand();
    const scores = new Map();
    for (const p of active) {
      const best = PokerLib.evaluateBest([...p.cards, ...this.board]);
      scores.set(p.id, best);
      p.handLabel = best.name;
      p.bestCards = best.cards.map(PokerLib.cardCode);
    }

    const pots = this.buildPots();
    const potResults = [];
    for (const pot of pots) {
      const contenders = pot.eligible.length ? pot.eligible : active;
      let best = null;
      let winners = [];
      for (const p of contenders) {
        const sc = scores.get(p.id);
        if (!sc) continue;
        const cmp = best ? PokerLib.compareHands(sc, best) : 1;
        if (cmp > 0) {
          best = sc;
          winners = [p];
        } else if (cmp === 0) winners.push(p);
      }
      if (!winners.length) continue;

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // 남는 칩은 버튼 다음 자리부터 순서대로
      const ordered = [...winners].sort(
        (a, b) => this.seatOrderFromButton(a.seat) - this.seatOrderFromButton(b.seat)
      );
      const detail = [];
      for (const w of ordered) {
        let amt = share;
        if (remainder > 0) {
          amt += 1;
          remainder--;
        }
        w.stack += amt;
        w.won += amt;
        detail.push({ id: w.id, name: w.name, share: amt, hand: scores.get(w.id).name });
      }
      potResults.push({ amount: pot.amount, winners: detail });
    }

    this.results = { showdown: true, pots: potResults };
    for (const pr of potResults) {
      this.pushLog(
        pr.winners.map((w) => `${w.name}(${w.hand})`).join(', ') +
          ` → ${pr.amount.toLocaleString()} 칩 획득`
      );
    }
    this.endHand(this.delays.showdown);
  }

  seatOrderFromButton(seat) {
    const seats = this.config.maxPlayers;
    return (seat - this.buttonSeat + seats) % seats;
  }

  endHand(delay) {
    this.clearTimers();
    this.status = 'showdown';
    this.actorSeat = null;
    for (const p of this.players.values()) p.bet = 0;
    this.touch();

    this.later(() => {
      this.status = 'waiting';
      for (const p of this.players.values()) {
        p.inHand = false;
        p.cards = [];
        p.totalBet = 0;
        p.lastAction = null;
        if (p.stack <= 0) p.sittingOut = true;
      }
      this.board = [];
      this.results = null;
      this.purgeLeaving(); // 팟 정산이 끝난 지금이 자리를 빼기에 안전한 시점이다
      this.touch();
      if (this.autoNext && this.eligiblePlayers().length >= 2) {
        try {
          this.startHand();
        } catch (_) {
          /* 인원 부족 */
        }
      }
    }, delay);
  }

  /* ------------------------------------------------------------ 상태 직렬화 */

  legalActionsFor(p) {
    if (this.status !== 'playing' || !p || p.seat !== this.actorSeat) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const maxRaiseTo = p.bet + p.stack;
    const minRaiseTo = Math.min(this.currentBet + this.minRaise, maxRaiseTo);
    return {
      canCheck: this.currentBet - p.bet <= 0,
      callAmount: Math.max(0, toCall),
      canRaise: p.stack > 0 && maxRaiseTo > this.currentBet,
      minRaiseTo,
      maxRaiseTo,
      currentBet: this.currentBet,
      myBet: p.bet,
      pot: this.pot(),
    };
  }

  /**
   * 보는 사람 본인의 "지금 완성된 패"를 계산한다.
   * 플랍 이후에는 홀카드+보드 7장 중 최고 5장을, 프리플랍에는 홀카드 조합을 알려 준다.
   */
  madeHandFor(player) {
    if (!player || !player.inHand || player.folded || player.cards.length < 2) return null;

    if (this.board.length < 3) {
      const [a, b] = player.cards;
      const label = PokerLib.RANK_LABEL;
      if (a.r === b.r) {
        return { name: `포켓 페어 (${label[a.r]}${label[a.r]})`, cards: player.cards.map(PokerLib.cardCode) };
      }
      const hi = a.r > b.r ? a : b;
      return { name: `${label[hi.r]} 하이 (${a.s === b.s ? '수티드' : '오프숫'})`, cards: [] };
    }

    const best = PokerLib.evaluateBest([...player.cards, ...this.board]);
    // 페어부터 보이도록 (같은 랭크 묶음 크기 → 랭크) 순으로 정렬해서 읽기 쉽게 만든다
    const counts = new Map();
    for (const c of best.cards) counts.set(c.r, (counts.get(c.r) || 0) + 1);
    const ordered = [...best.cards].sort(
      (x, y) => counts.get(y.r) - counts.get(x.r) || y.r - x.r
    );
    return { name: best.name, cards: ordered.map(PokerLib.cardCode) };
  }

  publicState(viewerToken) {
    const viewer = this.players.get(viewerToken) || null;
    const revealAll = this.status === 'showdown' && this.results && this.results.showdown;

    const players = this.seatedPlayers().map((p) => {
      const isMe = viewer && p.token === viewerToken;
      const showCards = isMe || (revealAll && p.inHand && !p.folded);
      return {
        id: p.id,
        name: p.name,
        seat: p.seat,
        stack: p.stack,
        bet: p.bet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        connected: p.connected,
        sittingOut: p.sittingOut,
        leaving: p.leaving,
        dropAt: p.dropAt,
        isHost: p.token === this.hostToken,
        isMe: !!isMe,
        lastAction: p.lastAction,
        handLabel: revealAll ? p.handLabel : isMe ? null : null,
        cards: showCards ? p.cards.map(PokerLib.cardCode) : p.inHand ? ['??', '??'] : [],
        won: p.won,
      };
    });

    return {
      type: 'state',
      room: {
        id: this.id,
        name: this.config.name,
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        startingStack: this.config.startingStack,
        maxPlayers: this.config.maxPlayers,
        actionTime: this.config.actionTime,
        disconnectGrace: this.disconnectGrace,
      },
      status: this.status,
      street: this.street,
      handNo: this.handNo,
      board: this.board.map(PokerLib.cardCode),
      pot: this.pot(),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      buttonSeat: this.buttonSeat,
      actorSeat: this.actorSeat,
      deadline: this.deadline,
      players,
      results: this.results,
      log: this.log.slice(-25),
      you: viewer
        ? {
            id: viewer.id,
            seat: viewer.seat,
            stack: viewer.stack,
            isHost: viewer.token === this.hostToken,
            sittingOut: viewer.sittingOut,
            cards: viewer.cards.map(PokerLib.cardCode),
            made: this.madeHandFor(viewer),
          }
        : null,
      legal: viewer ? this.legalActionsFor(viewer) : null,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Table, MAX_SEATS };
else Object.assign(globalThis, { Table, MAX_SEATS });
