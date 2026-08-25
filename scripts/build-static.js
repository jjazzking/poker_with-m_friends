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

// 4) 실행 모드 결정 — 중앙 서버 주소가 주어지면 server 모드, 없으면 p2p 폴백
const serverUrl = (process.env.POKER_SERVER_URL || '').trim().replace(/\/+$/, '');

/*
 * 서버 주소 없이 구우면 사이트가 조용히 P2P 폴백으로 되돌아간다.
 * 눈에 띄지 않은 채 배포되면 "접속이 안 된다"로만 돌아오므로, 자동 배포에서는
 * 폴백을 기본값으로 삼지 않는다. 정말 서버 없이 굽고 싶으면 ALLOW_P2P_FALLBACK=1.
 */
if (!serverUrl && process.env.CI && !process.env.ALLOW_P2P_FALLBACK) {
  console.error('POKER_SERVER_URL 이 비어 있습니다.');
  console.error('저장소 Settings > Secrets and variables > Actions > Variables 에 서버 주소를 넣어 주세요.');
  console.error('서버 없이 P2P 폴백으로 굽는 것이 의도라면 ALLOW_P2P_FALLBACK=1 을 함께 지정하세요.');
  process.exit(1);
}

if (serverUrl && !/^https:\/\//.test(serverUrl)) {
  console.error(`POKER_SERVER_URL 은 https:// 로 시작해야 합니다 (받은 값: ${serverUrl})`);
  console.error('GitHub Pages 는 https 라서 http 서버를 부르면 브라우저가 차단합니다.');
  process.exit(1);
}

fs.writeFileSync(
  path.join(dist, 'config.js'),
  serverUrl
    ? `/* 정적 배포용 설정 — npm run build 가 생성합니다. 수정하지 마세요. */
window.POKER_CONFIG = {
  mode: 'server',
  serverUrl: ${JSON.stringify(serverUrl)},
  peerServer: null,
};
`
    : `/* 정적 배포용 설정 — npm run build 가 생성합니다. 수정하지 마세요. */
/* POKER_SERVER_URL 이 없어 서버 없이 도는 P2P 폴백으로 빌드되었습니다.   */
window.POKER_CONFIG = {
  mode: 'p2p',
  serverUrl: null,
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
console.log(
  serverUrl
    ? `  실행 모드: server → ${serverUrl}`
    : '  실행 모드: p2p (POKER_SERVER_URL 이 없어 폴백으로 빌드했습니다)'
);
for (const f of files.sort()) console.log('  ' + f);
