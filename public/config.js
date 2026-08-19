/**
 * 배포 형태에 따른 실행 모드.
 *   server : Node + WebSocket 서버 (npm start)
 *   p2p    : 정적 호스팅(GitHub Pages 등) — 방장 브라우저가 서버 역할을 하고 WebRTC로 직접 연결
 *
 * 정적 빌드(npm run build)는 이 파일을 p2p 설정으로 덮어씁니다.
 * URL에 ?mode=p2p 를 붙이면 로컬에서도 P2P 모드를 시험해 볼 수 있습니다.
 */
window.POKER_CONFIG = {
  mode: 'server',
  peerServer: null, // null이면 PeerJS 공개 시그널링 서버 사용
};
