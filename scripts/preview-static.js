'use strict';
/** 정적 빌드(dist/)를 GitHub Pages 와 같은 형태로 로컬에서 확인해 보는 서버 */
const path = require('path');
const fs = require('fs');
const express = require('express');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
  console.error('dist/ 가 없습니다. 먼저 `npm run build` 를 실행해 주세요.');
  process.exit(1);
}

const port = Number(process.env.PORT) || 4000;
const app = express();
app.use(express.static(dist));
// 어떤 모드로 빌드됐는지는 생성된 config.js 가 알고 있다
function builtMode() {
  try {
    const cfg = fs.readFileSync(path.join(dist, 'config.js'), 'utf8');
    const url = /serverUrl:\s*"([^"]+)"/.exec(cfg);
    if (/mode:\s*'server'/.test(cfg)) return { mode: 'server', serverUrl: url ? url[1] : null };
    return { mode: 'p2p' };
  } catch (_) {
    return { mode: '?' };
  }
}

app.listen(port, () => {
  const built = builtMode();
  console.log(`♠ 정적 빌드 미리보기 → http://localhost:${port}`);

  if (built.mode === 'server') {
    console.log(`  중앙 서버 모드 → ${built.serverUrl}`);
  } else {
    console.log('  P2P 모드입니다. 방장 탭을 열어 둔 채로 링크를 다른 창에 붙여 넣어 보세요.');
    console.log('  중앙 서버로 시험하려면 다른 터미널에서 `npm start` 를 띄운 뒤');
    console.log(`  http://localhost:${port}/index.html?mode=server&server=http://localhost:3000 로 접속하세요.`);
  }
});
