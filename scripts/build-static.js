'use strict';
/**
 * GitHub Pages 등 정적 호스팅용 빌드.
 * public/ 화면 + 게임 엔진 + PeerJS 를 dist/ 로 모으고, 실행 모드를 p2p 로 바꾼다.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'engine'), { recursive: true });
fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });

// 1) 화면 파일
for (const file of fs.readdirSync(path.join(root, 'public'))) {
  fs.copyFileSync(path.join(root, 'public', file), path.join(dist, file));
}

// 2) 호스트 브라우저가 돌릴 게임 엔진
for (const file of ['poker.js', 'table.js', 'protocol.js']) {
  fs.copyFileSync(path.join(root, 'src', file), path.join(dist, 'engine', file));
}

// 3) WebRTC 라이브러리 (CDN 없이 저장소에 포함해 배포)
const peerDist = path.join(root, 'node_modules', 'peerjs', 'dist');
for (const file of ['peerjs.min.js', 'peerjs.min.js.map']) {
  const from = path.join(peerDist, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dist, 'vendor', file));
}

// 4) 실행 모드를 p2p 로 고정
fs.writeFileSync(
  path.join(dist, 'config.js'),
  `/* 정적 배포용 설정 — npm run build 가 생성합니다. 수정하지 마세요. */
window.POKER_CONFIG = {
  mode: 'p2p',
  // 방장 브라우저와 참가자를 서로 찾아 주는 시그널링 서버.
  // null 이면 PeerJS 공개 서버(0.peerjs.com)를 사용합니다.
  // 직접 운영한다면 'my-peer-server.example.com/myapp' 형태로 적어 주세요.
  peerServer: null,
};
`
);

// 5) Jekyll 처리를 끄고, 잘못된 주소는 로비로 보낸다
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
fs.copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));

const files = [];
(function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else files.push(rel);
  }
})(dist, '');

console.log(`dist/ 생성 완료 (${files.length}개 파일)`);
for (const f of files.sort()) console.log('  ' + f);
