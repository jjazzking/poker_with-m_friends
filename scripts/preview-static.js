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
app.listen(port, () => {
  console.log(`♠ 정적 빌드 미리보기 → http://localhost:${port}`);
  console.log('  (P2P 모드입니다. 방장 탭을 열어 둔 채로 링크를 다른 창에 붙여 넣어 보세요)');
});
