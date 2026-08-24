/**
 * 배포 형태에 따른 실행 모드.
 *   server : 중앙 서버(Node + WebSocket)에 붙는다 — 기본이자 권장 방식
 *   p2p    : 서버 없이 방장 브라우저가 딜러 역할을 하고 WebRTC로 직접 연결 (폴백)
 *
 * serverUrl
 *   중앙 서버의 주소. null 이면 이 페이지를 서빙한 서버와 같은 곳으로 본다.
 *   GitHub Pages 처럼 정적 호스팅에서 열 때는 반드시 채워져 있어야 하며,
 *   정적 빌드(npm run build)가 POKER_SERVER_URL 환경변수를 읽어 이 파일을 생성한다.
 *
 * URL 옵션으로 임시 변경도 가능하다.
 *   ?server=https://my-poker.onrender.com  다른 서버로 붙어 보기
 *   ?mode=p2p                              서버 없이 P2P 로 시험해 보기
 */
window.POKER_CONFIG = {
  mode: 'server',
  serverUrl: null,
  peerServer: null, // p2p 폴백에서만 쓰임. null이면 PeerJS 공개 시그널링 서버 사용
};
