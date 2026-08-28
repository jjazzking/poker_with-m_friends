'use strict';
/**
 * 전송 계층. 화면 코드(room.js/lobby.js)는 이 모듈만 보고,
 * 실제로 WebSocket 서버에 붙는지 WebRTC로 방장에게 붙는지는 여기서 감춘다.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const cfg = window.POKER_CONFIG || {};
  const MODE = params.get('mode') || cfg.mode || 'server';
  const PEER_SERVER = params.get('peer') || cfg.peerServer || null;
  // 중앙 서버 주소. 비어 있으면 이 페이지를 서빙한 서버와 같은 곳으로 본다.
  // GitHub Pages 처럼 정적 호스팅에서 열었다면 반드시 채워져 있어야 한다.
  const SERVER_URL = normalizeBase(params.get('server') || cfg.serverUrl || null);

  function normalizeBase(url) {
    if (!url) return null;
    const trimmed = String(url).trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    return (/^https?:\/\//.test(trimmed) ? trimmed : 'https://' + trimmed) + '/';
  }

  /** 서버의 HTTP 주소 (SERVER_URL 이 없으면 현재 경로 기준 상대 주소) */
  function apiUrl(pathname) {
    return SERVER_URL ? new URL(pathname, SERVER_URL).href : pathname;
  }

  /** 서버의 WebSocket 주소 */
  function wsUrl() {
    if (!SERVER_URL) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}/ws`;
    }
    const u = new URL('ws', SERVER_URL);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }

  /**
   * https 페이지에서 http 서버를 부르면 브라우저가 조용히 막아 버린다.
   * 무한 스피너 대신 원인을 바로 알려 주기 위해 미리 확인한다.
   */
  function mixedContentError() {
    if (!SERVER_URL) return null;
    if (location.protocol === 'https:' && SERVER_URL.startsWith('http://')) {
      return '서버 주소가 http 입니다. https 로 접속되는 서버 주소를 설정해 주세요.';
    }
    return null;
  }

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 I,O,0,1 제외
  const PEER_PREFIX = 'holdem-';
  const HOST_CFG_KEY = (code) => `poker:host:${code}`;
  const HOST_SNAP_KEY = (code) => `poker:snapshot:${code}`;

  function randomCode(len = 6) {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
  }

  function peerOptions() {
    if (!PEER_SERVER) return {}; // PeerJS 공개 시그널링 서버
    const m = /^(?:(https?):\/\/)?([^:/]+)(?::(\d+))?(\/.*)?$/.exec(PEER_SERVER);
    if (!m) return {};
    return {
      host: m[2],
      port: m[3] ? Number(m[3]) : m[1] === 'https' ? 443 : 80,
      path: m[4] || '/',
      secure: m[1] === 'https',
      config: { iceServers: [] }, // 자체 시그널링 서버를 쓸 땐 STUN 없이 로컬 후보만 사용
    };
  }

  /** 외부에 노출되는 전송 계층 */
  const Net = {
    mode: MODE,
    isHost: false,
    roomId: null,
  };

  /* ------------------------------------------------------------ 서버 모드 */

  const ServerNet = {
    async createRoom(config) {
      const blocked = mixedContentError();
      if (blocked) throw new Error(blocked);

      let res;
      try {
        res = await fetch(apiUrl('api/rooms'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
      } catch (_) {
        throw new Error('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.error) || '방 생성에 실패했습니다');
      }
      const data = await res.json();
      return { roomId: data.roomId };
    },

    /**
     * 방 조회 결과는 세 가지다. 이걸 뭉뚱그리면 자고 있는 서버를
     * "방이 없다"고 오진하게 된다.
     *   found   — 서버가 방 정보를 줬다
     *   missing — 서버가 그런 방은 없다고 답했다 (404)
     *   unknown — 서버에 닿지 못했다. 방이 있는지 없는지 알 수 없다.
     */
    async roomInfo(roomId) {
      try {
        const res = await fetch(apiUrl(`api/rooms/${encodeURIComponent(roomId)}`));
        if (res.status === 404) return { status: 'missing' };
        if (!res.ok) return { status: 'unknown' }; // 서버가 아파도 방 탓은 아니다
        return { status: 'found', info: await res.json() };
      } catch (_) {
        return { status: 'unknown' }; // 자는 중이거나 네트워크가 끊겼다
      }
    },

    join({ roomId, name, token, handlers }) {
      const blocked = mixedContentError();
      if (blocked) return handlers.onFatal(blocked);

      let ws = null;
      let delay = 500;
      let attempts = 0;
      let everConnected = false;
      let closed = false; // leave 등으로 의도적으로 끊은 경우

      const open = () => {
        if (closed) return;
        try {
          ws = new WebSocket(wsUrl());
        } catch (_) {
          return scheduleRetry();
        }

        ws.addEventListener('open', () => {
          everConnected = true;
          attempts = 0;
          delay = 500;
          ws.send(JSON.stringify({ type: 'join', roomId, token, name }));
        });

        ws.addEventListener('message', (ev) => {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch (_) {
            return;
          }
          if (msg.type === 'state') handlers.onState(msg);
          else if (msg.type === 'error') handlers.onError(msg.message);
          else if (msg.type === 'fatal') {
            closed = true; // 방이 없는 등 재시도가 무의미한 상황
            handlers.onFatal(msg.message, msg.title);
          }
        });

        ws.addEventListener('close', () => {
          if (closed) return;
          if (everConnected) handlers.onDisconnect();
          scheduleRetry();
        });

        // error 뒤에는 항상 close 가 이어지므로 재연결은 close 에서만 건다
        ws.addEventListener('error', () => {});
      };

      const scheduleRetry = () => {
        attempts += 1;

        // 한 번도 못 붙었다면 주소나 서버 자체가 문제일 가능성이 높다
        if (!everConnected) {
          if (attempts === 3) {
            handlers.onError(
              SERVER_URL
                ? '서버를 깨우는 중입니다… (무료 호스팅은 첫 접속에 1분쯤 걸릴 수 있어요)'
                : '서버에 연결할 수 없습니다. 다시 시도하는 중…'
            );
          }
          if (attempts >= 12) {
            closed = true;
            return handlers.onFatal('서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요.');
          }
        }

        setTimeout(open, delay);
        delay = Math.min(delay * 2, 8000);
      };

      open();

      Net.send = (msg) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        if (msg && msg.type === 'leave') {
          closed = true;
          if (ws) ws.close();
        }
      };
    },
  };

  /* ------------------------------------------------------------ P2P 모드 */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(src + ' 로드 실패'));
      document.head.appendChild(el);
    });
  }

  let depsLoaded = null;
  function loadP2PDeps() {
    if (!depsLoaded) {
      depsLoaded = (async () => {
        await loadScript('vendor/peerjs.min.js');
        await loadScript('engine/poker.js');
        await loadScript('engine/table.js');
        await loadScript('engine/protocol.js');
      })();
    }
    return depsLoaded;
  }

  const P2PNet = {
    async createRoom(config) {
      const roomId = randomCode();
      // 방 설정은 이 탭에만 저장해 두고, 테이블 화면에서 방장 피어를 띄운다
      sessionStorage.setItem(HOST_CFG_KEY(roomId), JSON.stringify(config));
      return { roomId };
    },

    async roomInfo(roomId) {
      const raw = sessionStorage.getItem(HOST_CFG_KEY(roomId));
      // 참가자는 방장에게 붙기 전에는 방 설정도, 방의 존재 여부도 알 수 없다
      if (!raw) return { status: 'unknown' };
      return { status: 'found', info: { roomId, config: JSON.parse(raw), host: true } };
    },

    async join({ roomId, name, token, handlers }) {
      await loadP2PDeps();
      const raw = sessionStorage.getItem(HOST_CFG_KEY(roomId));
      if (raw) return hostRoom({ roomId, config: JSON.parse(raw), name, token, handlers });
      return guestRoom({ roomId, name, token, handlers });
    },
  };

  /* ---- 방장: 이 탭이 곧 서버 ---- */
  function hostRoom({ roomId, config, name, token, handlers }) {
    Net.isHost = true;
    const conns = new Map(); // token -> DataConnection

    const table = new Table(roomId, config, () => broadcast());
    // 방장이 새로고침해도 각자 스택이 유지되도록 복원
    try {
      const snap = sessionStorage.getItem(HOST_SNAP_KEY(roomId));
      if (snap) table.restore(JSON.parse(snap));
    } catch (_) {
      /* 손상된 스냅샷은 무시 */
    }
    table.hostToken = token;
    table.addPlayer(token, name);
    table.hostToken = token;

    function broadcast() {
      try {
        sessionStorage.setItem(HOST_SNAP_KEY(roomId), JSON.stringify(table.snapshot()));
      } catch (_) {
        /* 저장 공간 부족은 치명적이지 않다 */
      }
      handlers.onState(table.publicState(token));
      for (const [tk, conn] of conns) {
        if (conn.open) {
          try {
            conn.send(table.publicState(tk));
          } catch (_) {
            /* 끊긴 연결 */
          }
        }
      }
    }

    let peer = null;
    let idAttempts = 0;

    // 새로고침 직후에는 시그널링 서버에 이전 등록이 잠깐 남아 있을 수 있어 몇 번 다시 시도한다
    const openPeer = () => {
      peer = new Peer(PEER_PREFIX + roomId, peerOptions());
      Net.peer = peer;

      peer.on('open', () => {
        idAttempts = 0;
        handlers.onHostReady && handlers.onHostReady(roomId);
        broadcast();
      });

      /*
       * 시그널링 소켓은 탭을 잠깐 내리거나 네트워크가 한 번 끊기기만 해도 떨어진다.
       * 이때 다시 붙지 않으면 이미 연결된 사람들만 남고, 새로 들어오는 사람에게는
       * 방장이 영영 보이지 않는다("방장이 접속해 있지 않습니다").
       */
      peer.on('disconnected', () => {
        if (peer.destroyed) return;
        try {
          peer.reconnect();
        } catch (_) {
          setTimeout(openPeer, 1500);
        }
      });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          if (idAttempts++ < 6) {
            try {
              peer.destroy();
            } catch (_) {
              /* 이미 정리됨 */
            }
            setTimeout(openPeer, 1500);
          } else {
            handlers.onFatal('같은 코드의 방이 이미 열려 있습니다. 방을 다시 만들어 주세요.');
          }
        } else if (err.type === 'network' || err.type === 'server-error') {
          handlers.onError('시그널링 서버 연결이 불안정합니다. 다시 시도합니다…');
          if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 2000);
        } else if (err.type !== 'peer-unavailable') {
          handlers.onError('연결 오류: ' + err.type);
        }
      });

      peer.on('connection', onConnection);
    };

    /** 강퇴된 참가자의 연결을 이유와 함께 끊는다 */
    function dropGuest(kickedToken) {
      const conn = conns.get(kickedToken);
      if (!conn) return;
      conns.delete(kickedToken);
      conn.playerToken = null;
      try {
        if (conn.open) {
          conn.send({
            type: 'fatal',
            title: '테이블에서 나가게 되었습니다',
            message: '방장이 당신을 테이블에서 내보냈습니다.',
          });
        }
        setTimeout(() => conn.close(), 200);
      } catch (_) {
        /* 이미 끊긴 연결 */
      }
    }

    function onConnection(conn) {
      conn.on('data', (msg) => {
        try {
          if (!msg || typeof msg !== 'object') return;

          if (msg.type === 'join') {
            const tk = String(msg.token || '').slice(0, 64);
            const nm = String(msg.name || '').trim().slice(0, 14) || '플레이어';
            if (!tk) return;
            if (table.isBanned(tk)) {
              conn.send({
                type: 'fatal',
                title: '입장할 수 없습니다',
                message: '방장이 이 테이블에서 내보냈습니다.',
              });
              setTimeout(() => conn.close(), 200);
              return;
            }
            const player = table.addPlayer(tk, nm);
            table.setConnected(tk, true);
            const prev = conns.get(tk);
            if (prev && prev !== conn) prev.close();
            conns.set(tk, conn);
            conn.playerToken = tk;
            conn.send({ type: 'joined', token: tk, playerId: player.id, roomId });
            broadcast();
            return;
          }

          if (!conn.playerToken) return;
          const result = Protocol.handleClientMessage({
            table,
            token: conn.playerToken,
            msg,
            reply: (payload) => conn.open && conn.send(payload),
          });
          if (result.kicked) dropGuest(result.kicked);
          if (result.left) {
            conns.delete(conn.playerToken);
            conn.playerToken = null;
            broadcast();
          }
        } catch (err) {
          if (conn.open) conn.send({ type: 'error', message: err.message || '알 수 없는 오류' });
        }
      });

      conn.on('close', () => {
        if (!conn.playerToken) return;
        if (conns.get(conn.playerToken) === conn) {
          conns.delete(conn.playerToken);
          table.setConnected(conn.playerToken, false);
          broadcast();
        }
      });
    }

    openPeer();

    // 방장 본인의 액션은 네트워크를 타지 않고 바로 테이블에 적용된다
    Net.send = (msg) => {
      try {
        const result = Protocol.handleClientMessage({ table, token, msg, reply: () => {} });
        if (result.kicked) dropGuest(result.kicked);
        if (result.left) {
          sessionStorage.removeItem(HOST_CFG_KEY(roomId));
          sessionStorage.removeItem(HOST_SNAP_KEY(roomId));
          if (peer) peer.destroy();
        }
      } catch (err) {
        handlers.onError(err.message || '알 수 없는 오류');
      }
    };

    // 방장 탭이 닫히면 참가자들이 곧바로 알 수 있도록 정리
    window.addEventListener('beforeunload', () => peer && peer.destroy());
  }

  /* ---- 참가자: 방장에게 붙는다 ---- */
  function guestRoom({ roomId, name, token, handlers }) {
    Net.isHost = false;
    let conn = null;
    let attempts = 0;
    let peer = null;

    const connect = () => {
      peer = new Peer(peerOptions());
      Net.peer = peer;

      peer.on('open', () => {
        conn = peer.connect(PEER_PREFIX + roomId, { reliable: true });
        conn.on('open', () => {
          attempts = 0;
          conn.send({ type: 'join', roomId, token, name });
        });
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'state') handlers.onState(msg);
          else if (msg.type === 'error') handlers.onError(msg.message);
          else if (msg.type === 'fatal') handlers.onFatal(msg.message, msg.title);
        });
        conn.on('close', () => {
          handlers.onDisconnect();
          retry();
        });
      });

      peer.on('disconnected', () => {
        if (peer.destroyed || stopped) return;
        try {
          peer.reconnect();
        } catch (_) {
          retry();
        }
      });

      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          if (attempts === 0) handlers.onError('방장이 접속해 있지 않습니다. 다시 시도합니다…');
          retry();
        } else if (err.type === 'network' || err.type === 'server-error') {
          handlers.onError('시그널링 서버에 연결할 수 없습니다.');
          retry();
        } else {
          handlers.onError('연결 오류: ' + err.type);
        }
      });
    };

    /*
     * 한 번의 실패가 conn.close 와 peer.error 로 두 번 들어오는 일이 흔하다.
     * 그때마다 예약하면 Peer 가 2 → 4 → 8 개로 불어나 시그널링 서버에서
     * 막혀 버리므로, 예약은 항상 하나만 살아 있게 한다.
     */
    let retryTimer = null;
    let stopped = false;

    const retry = () => {
      if (stopped || retryTimer) return;
      if (attempts > 40) {
        stopped = true;
        return handlers.onFatal('방장과 연결할 수 없습니다. 방장이 페이지를 열어 두었는지 확인해 주세요.');
      }
      const wait = Math.min(1000 * 2 ** Math.min(attempts, 3), 8000);
      attempts++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (stopped) return;
        try {
          if (peer && !peer.destroyed) peer.destroy();
        } catch (_) {
          /* 이미 정리됨 */
        }
        conn = null;
        connect();
      }, wait);
    };

    connect();

    Net.send = (msg) => {
      if (conn && conn.open) conn.send(msg);
      if (msg && msg.type === 'leave') {
        stopped = true;
        clearTimeout(retryTimer);
        retryTimer = null;
        try {
          if (peer && !peer.destroyed) peer.destroy();
        } catch (_) {
          /* 이미 정리됨 */
        }
      }
    };
  }

  /* ------------------------------------------------------------ 공개 API */

  const impl = MODE === 'p2p' ? P2PNet : ServerNet;

  Net.createRoom = (config) => impl.createRoom(config);
  Net.roomInfo = (roomId) => impl.roomInfo(roomId).catch(() => ({ status: 'unknown' }));
  Net.join = (opts) => {
    Net.roomId = opts.roomId;
    return impl.join(opts);
  };
  Net.send = () => {}; // join 이후 실제 구현으로 교체된다
  Net.makeRoomCode = randomCode;

  /**
   * 서버 예열.
   *
   * 무료 호스팅은 한동안 요청이 없으면 잠들고, 다시 깨어나는 데 1분 가까이 걸린다.
   * 로비를 여는 순간 미리 깨워 두면 사용자가 닉네임과 블라인드를 채워 넣는 동안
   * 서버가 일어나므로, 정작 "방 만들기"를 누를 때는 기다릴 일이 거의 없다.
   *
   * 실패해도 조용히 넘어간다 — 실제 판단은 방 생성/접속이 한다.
   */
  Net.warmUp = ({ onStatus } = {}) => {
    if (MODE !== 'server') return Promise.resolve(false);

    const say = (state, message) => onStatus && onStatus(state, message);
    const started = Date.now();
    const LIMIT_MS = 90000;
    let announced = false;

    const attempt = async () => {
      try {
        const res = await fetch(apiUrl('api/health'), { cache: 'no-store' });
        if (res.ok) {
          say('ready', announced ? '서버 준비 완료' : '');
          return true;
        }
      } catch (_) {
        /* 아직 자는 중이거나 네트워크가 불안정하다 */
      }

      if (Date.now() - started > LIMIT_MS) {
        say('down', '서버에 연결되지 않습니다. 잠시 후 다시 시도해 주세요.');
        return false;
      }

      // 첫 시도가 실패했을 때만 안내한다. 깨어 있으면 아무 표시도 하지 않는다.
      if (!announced) {
        announced = true;
        say('waking', '서버를 깨우는 중입니다… (최대 1분)');
      }
      await new Promise((r) => setTimeout(r, 3000));
      return attempt();
    };

    return attempt();
  };

  window.Net = Net;
})();
