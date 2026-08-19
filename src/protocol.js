'use strict';
/**
 * 클라이언트 메시지 처리 규칙.
 * 서버 모드(Node)와 P2P 모드(호스트 브라우저)가 똑같은 규칙을 쓰도록 한 곳에 모아 둔다.
 * join/leave 이후의 연결 정리는 전송 계층이 담당한다.
 */
function handleClientMessage({ table, token, msg, reply }) {
  const me = table.players.get(token);
  if (!me) throw new Error('플레이어 정보를 찾을 수 없습니다');
  const isHost = table.hostToken === token;

  switch (msg.type) {
    case 'action':
      table.act(token, msg.action, msg.amount);
      return {};

    case 'start':
      if (!isHost) throw new Error('방장만 게임을 시작할 수 있습니다');
      if (table.status !== 'waiting') throw new Error('이미 게임이 진행 중입니다');
      table.startHand();
      return {};

    case 'sitout':
      table.setSitOut(token, msg.value);
      return {};

    case 'addChips':
      table.addChips(token, msg.amount);
      return {};

    case 'autoNext':
      if (!isHost) throw new Error('방장만 변경할 수 있습니다');
      table.autoNext = !!msg.value;
      table.pushLog(`자동 다음 핸드: ${table.autoNext ? '켜짐' : '꺼짐'}`);
      table.touch();
      return {};

    case 'chat': {
      const text = String(msg.text || '').trim().slice(0, 120);
      if (text) {
        table.pushLog(`💬 ${me.name}: ${text}`);
        table.touch();
      }
      return {};
    }

    case 'leave':
      table.removePlayer(token);
      return { left: true };

    case 'ping':
      if (reply) reply({ type: 'pong' });
      return {};

    default:
      throw new Error('알 수 없는 요청입니다');
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { handleClientMessage };
else globalThis.Protocol = { handleClientMessage };
