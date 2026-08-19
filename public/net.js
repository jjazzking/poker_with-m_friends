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
      const res = await fetch('api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error('방 생성에 실패했습니다');
      const data = await res.json();
      return { roomId: data.roomId };
    },

    async roomInfo(roomId) {
      const res = await fetch(`api/rooms/${encodeURIComponent(roomId)}`);
      if (!res.ok) return null;
      return res.json();
    },

    join({ roomId, name, token, handlers }) {
      let ws = null;
      let delay = 500;

      const open = () => {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/ws`);
        ws.addEventListener('open', () => {
          delay = 500;
          ws.send(JSON.stringify({ type: 'join', roomId, token, name }));
        });
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state') handlers.onState(msg);
          else if (msg.type === 'error') handlers.onError(msg.message);
          else if (msg.type === 'fatal') handlers.onFatal(msg.message);
        });
        ws.addEventListener('close', () => {
          handlers.onDisconnect();
          setTimeout(open, delay);
          delay = Math.min(delay * 2, 8000);
        });
      };
      open();

      Net.send = (msg) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
      if (!raw) return null; // 참가자는 방장에게 붙기 전에는 설정을 알 수 없다
      return { roomId, config: JSON.parse(raw), host: true };
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
        } else if (err.type !== 'peer-unavailable') {
          handlers.onError('연결 오류: ' + err.type);
        }
      });

      peer.on('connection', onConnection);
    };

    function onConnection(conn) {
      conn.on('data', (msg) => {
        try {
          if (!msg || typeof msg !== 'object') return;

          if (msg.type === 'join') {
            const tk = String(msg.token || '').slice(0, 64);
            const nm = String(msg.name || '').trim().slice(0, 14) || '플레이어';
            if (!tk) return;
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
          else if (msg.type === 'fatal') handlers.onFatal(msg.message);
        });
        conn.on('close', () => {
          handlers.onDisconnect();
          retry();
        });
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

    const retry = () => {
      if (attempts > 40) return handlers.onFatal('방장과 연결할 수 없습니다. 방장이 페이지를 열어 두었는지 확인해 주세요.');
      const wait = Math.min(1000 * 2 ** Math.min(attempts, 3), 8000);
      attempts++;
      setTimeout(() => {
        try {
          if (peer && !peer.destroyed) peer.destroy();
        } catch (_) {
          /* 이미 정리됨 */
        }
        connect();
      }, wait);
    };

    connect();

    Net.send = (msg) => {
      if (conn && conn.open) conn.send(msg);
    };
  }

  /* ------------------------------------------------------------ 공개 API */

  const impl = MODE === 'p2p' ? P2PNet : ServerNet;

  Net.createRoom = (config) => impl.createRoom(config);
  Net.roomInfo = (roomId) => impl.roomInfo(roomId);
  Net.join = (opts) => {
    Net.roomId = opts.roomId;
    return impl.join(opts);
  };
  Net.send = () => {}; // join 이후 실제 구현으로 교체된다
  Net.makeRoomCode = randomCode;

  window.Net = Net;
})();
