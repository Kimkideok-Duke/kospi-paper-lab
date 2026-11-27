const $ = s => document.querySelector(s);
const message = text => { $('#auth-message').textContent = text; };
async function api(path, data) {
  const response = await fetch('/api/auth/' + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? '요청을 처리하지 못했습니다.');
  return result;
}
const invite = new URL(location.href).searchParams.get('invite');
if ($('#login-form')) {
  if (invite) {
    $('#auth-title').textContent = '나만의 마켓랩 시작하기';
    $('#auth-description').textContent = '개인 계정을 만들면 국내·미국장에 각각 1,000만 원의 모의 원금이 제공됩니다.';
    $('#auth-submit').textContent = '초대받은 계정 만들기';
    $('#login-form').elements.password.minLength = 12;
    $('#login-form').elements.password.autocomplete = 'new-password';
    $('#invite-hint').textContent = '비밀번호는 12자 이상 입력하세요. 초대 링크는 한 번만 사용할 수 있습니다.';
    history.replaceState(null, '', '/login');
  }
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('#auth-submit'); button.disabled = true; message('');
    try { await api(invite ? 'register' : 'login', { ...Object.fromEntries(new FormData(event.target)), ...(invite ? { invite } : {}) }); location.replace(new URL(location.href).searchParams.get('next')==='/research'?'/research':'/'); }
    catch (e) { message(e.message); } finally { button.disabled = false; }
  });
}
if ($('#account-name')) {
  try { const user = await api('me'); $('#account-name').textContent = user.username + (user.role === 'owner' ? ' · 소유자' : ' · 개인 계정'); $('#owner-tools').hidden = user.role !== 'owner'; }
  catch { location.replace('/login'); }
  $('#logout').addEventListener('click', async () => { try { await api('logout', {}); location.replace('/login'); } catch (e) { message(e.message); } });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { await api('password', Object.fromEntries(new FormData(event.target))); event.target.reset(); message('비밀번호를 변경했습니다. 다른 기기의 로그인은 해제됐습니다.'); }
    catch (e) { message(e.message); } finally { button.disabled = false; }
  });
  $('#create-invite').addEventListener('click', async event => {
    event.target.disabled = true;
    try { const { invite } = await api('invites', {}); $('#invite-url').value = location.origin + '/login?invite=' + invite; $('#invite-result').hidden = false; $('#copy-invite').hidden = false; message('가입 링크를 초대할 사람에게만 전달하세요. 24시간 후 만료됩니다.'); }
    catch (e) { message(e.message); } finally { event.target.disabled = false; }
  });
  $('#copy-invite').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#invite-url').value); message('초대 링크를 복사했습니다.'); } catch { $('#invite-url').select(); message('선택한 링크를 복사해 주세요.'); } });
}
