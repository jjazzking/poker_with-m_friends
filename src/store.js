'use strict';
/**
 * 방 상태를 디스크에 저장/복원한다.
 *
 * 무료 호스팅은 프로세스가 수시로 재시작되므로(배포, OOM, 슬립 해제) 메모리에만
 * 들고 있으면 그때마다 판돈과 스택이 통째로 날아간다. 진행 중이던 핸드까지
 * 되살리지는 않지만, 누가 어느 자리에 얼마를 들고 앉아 있었는지는 지켜 준다.
 *
 * DATA_DIR 을 영구 볼륨으로 잡아 주면 재배포에도 살아남는다.
 * 지정하지 않으면 임시 디렉터리를 쓰므로 프로세스 재시작까지만 보존된다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 1;
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'poker-with-friends');
const FILE = path.join(DATA_DIR, 'rooms.json');

/** @returns {Array<{id:string, config:object, snapshot:object, lastActivity:number}>} */
function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (_) {
    return []; // 첫 실행이거나 저장본이 없음
  }

  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== VERSION || !Array.isArray(data.rooms)) return [];
    return data.rooms.filter((r) => r && typeof r.id === 'string' && r.config && r.snapshot);
  } catch (err) {
    console.warn('[store] 저장본을 읽을 수 없어 무시합니다:', err.message);
    return [];
  }
}

/**
 * 임시 파일에 쓴 뒤 rename 으로 갈아 끼운다.
 * 저장 도중에 프로세스가 죽어도 반쪽짜리 파일이 남지 않는다.
 */
function save(rooms) {
  const payload = JSON.stringify({ version: VERSION, savedAt: Date.now(), rooms });
  const tmp = `${FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, FILE);
    return true;
  } catch (err) {
    console.warn('[store] 저장 실패:', err.message);
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      /* 정리 실패는 무시 */
    }
    return false;
  }
}

module.exports = { load, save, FILE, DATA_DIR };
