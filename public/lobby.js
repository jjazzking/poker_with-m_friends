'use strict';

const $ = (sel) => document.querySelector(sel);
const NAME_KEY = 'poker:name';

const savedName = localStorage.getItem(NAME_KEY) || '';
$('#nickname').value = savedName;
$('#join-name').value = savedName;

const bbInput = $('#bb');
const sbInput = $('#sb');
const stackInput = $('#stack');

function syncStackHint() {
  const bb = Number(bbInput.value) || 0;
  const stack = Number(stackInput.value) || 0;
  $('#stack-bb').textContent = bb > 0 ? `= ${(stack / bb).toFixed(1)} BB` : '';
}

bbInput.addEventListener('input', () => {
  const bb = Number(bbInput.value) || 0;
  // BB를 바꾸면 SB는 절반으로 자동 제안 (직접 수정하면 그대로 유지)
  if (!sbInput.dataset.touched) sbInput.value = Math.max(1, Math.floor(bb / 2));
  syncStackHint();
});
sbInput.addEventListener('input', () => {
  sbInput.dataset.touched = '1';
});
stackInput.addEventListener('input', syncStackHint);

document.querySelectorAll('#stack-presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const bb = Number(bbInput.value) || 0;
    stackInput.value = bb * Number(btn.dataset.bb);
    syncStackHint();
  });
});
syncStackHint();

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#create-error');
  err.textContent = '';

  const name = $('#nickname').value.trim();
  if (!name) return (err.textContent = '닉네임을 입력해 주세요.');

  const bb = Number(bbInput.value);
  const sb = Number(sbInput.value);
  const stack = Number(stackInput.value);
  if (!(bb >= 2)) return (err.textContent = '빅 블라인드는 2 이상이어야 합니다.');
  if (!(sb >= 1) || sb > bb) return (err.textContent = '스몰 블라인드는 1 이상, BB 이하여야 합니다.');
  if (!(stack >= bb)) return (err.textContent = '최초 스택은 BB보다 커야 합니다.');

  localStorage.setItem(NAME_KEY, name);

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#room-name').value.trim() || '친구들과 홀덤',
        bigBlind: bb,
        smallBlind: sb,
        startingStack: stack,
        maxPlayers: Number($('#max-players').value),
        actionTime: Number($('#action-time').value),
      }),
    });
    if (!res.ok) throw new Error('방 생성에 실패했습니다');
    const data = await res.json();
    location.href = `/room/${data.roomId}`;
  } catch (e2) {
    err.textContent = e2.message;
  }
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#join-error');
  err.textContent = '';

  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code) return (err.textContent = '방 코드를 입력해 주세요.');
  if (!name) return (err.textContent = '닉네임을 입력해 주세요.');

  const res = await fetch(`/api/rooms/${code}`);
  if (!res.ok) return (err.textContent = '그런 방이 없습니다. 코드를 확인해 주세요.');

  localStorage.setItem(NAME_KEY, name);
  location.href = `/room/${code}`;
});
