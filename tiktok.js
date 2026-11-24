// TikTok Content Posting tool, mounted at /tiktok by server.js.
// Zero-dependency (Node 20+ global fetch). Port of the Flask demo tool.
// (Redeploy trigger: pick up Cloady environment variables, v2.)
// Secrets come only from environment variables:
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REDIRECT_URI
const crypto = require('crypto');

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY || '';
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || '';
const SCOPES = 'user.info.basic,video.publish,video.upload';
const API = 'https://open.tiktokapis.com';
const CHUNK = 64 * 1024 * 1024;

const sessions = new Map(); // sid -> { state, accessToken, openId }

function missingConfig() {
  const m = [];
  if (!CLIENT_KEY) m.push('TIKTOK_CLIENT_KEY');
  if (!CLIENT_SECRET) m.push('TIKTOK_CLIENT_SECRET');
  if (!REDIRECT_URI) m.push('TIKTOK_REDIRECT_URI');
  return m;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title, body) {
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' +
    'body{font-family:system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;line-height:1.6}' +
    'label{display:block;margin:.8em 0 .2em;font-weight:600}' +
    'input[type=text],select{width:100%;padding:.5em;box-sizing:border-box}' +
    'button{margin-top:1.2em;padding:.7em 1.4em;font-size:1em;cursor:pointer}' +
    '.err{background:#fdecea;border:1px solid #f5c6c0;padding:.8em;border-radius:6px;white-space:pre-wrap}' +
    '.ok{background:#eaf7ea;border:1px solid #bfe3bf;padding:.8em;border-radius:6px}' +
    '.creator{display:flex;gap:1em;align-items:center;background:#f5f5f5;padding:.8em;border-radius:6px}' +
    '.creator img{width:64px;height:64px;border-radius:50%}' +
    'fieldset{margin-top:1em} .row label{display:inline;font-weight:400}' +
    '</style></head><body>' + body + '</body></html>';
}

function sendHtml(res, html, status) {
  res.writeHead(status || 200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function getSession(req, res) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) cookies[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  let sid = cookies.tiktok_sess;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, {});
    res.setHeader('Set-Cookie', 'tiktok_sess=' + sid + '; Path=/tiktok; HttpOnly; SameSite=Lax');
  }
  return sessions.get(sid);
}

async function apiPost(path, token, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body || {})
  });
  return r.json();
}

function splitBuffer(buf, delim) {
  const out = [];
  let i = 0, idx;
  while ((idx = buf.indexOf(delim, i)) !== -1) { out.push(buf.subarray(i, idx)); i = idx + delim.length; }
  out.push(buf.subarray(i));
  return out;
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return null;
  const boundary = m[1] || m[2];
  const segments = splitBuffer(buf, Buffer.from('--' + boundary));
  const fields = {};
  let file = null;
  for (let seg of segments) {
    if (seg.length < 4) continue;
    if (seg[0] === 0x2d && seg[1] === 0x2d) continue; // closing "--"
    if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.subarray(2);
    const headEnd = seg.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = seg.subarray(0, headEnd).toString('utf8');
    let body = seg.subarray(headEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    const nameM = /name="([^"]+)"/.exec(head);
    if (!nameM) continue;
    const fileM = /filename="([^"]*)"/.exec(head);
    if (fileM) {
      if (fileM[1]) {
        const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(head);
        file = { filename: fileM[1], contentType: typeM ? typeM[1].trim() : 'video/mp4', data: Buffer.from(body) };
      }
    } else {
      fields[nameM[1]] = body.toString('utf8');
    }
  }
  return { fields, file };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handleHome(req, res) {
  const missing = missingConfig();
  if (missing.length) {
    return sendHtml(res, page('設定不足',
      '<h1>KaikaLab Content Publisher</h1><div class="err">環境変数が未設定です: ' +
      esc(missing.join(', ')) + '</div>'));
  }
  sendHtml(res, page('KaikaLab Content Publisher',
    '<h1>KaikaLab Content Publisher</h1>' +
    '<p>KaikaLabの教育動画をTikTokへ投稿する公式ツールです。</p>' +
    '<p><a href="/tiktok/login"><button type="button">TikTokでログイン</button></a></p>'));
}

function handleLogin(req, res, sess) {
  sess.state = crypto.randomBytes(8).toString('hex');
  const q = new URLSearchParams({
    client_key: CLIENT_KEY, scope: SCOPES, response_type: 'code',
    redirect_uri: REDIRECT_URI, state: sess.state
  });
  res.writeHead(302, { Location: 'https://www.tiktok.com/v2/auth/authorize/?' + q.toString() });
  res.end();
}

async function handleCallback(req, res, sess, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return sendHtml(res, page('認可エラー', '<div class="err">認可エラー: ' + esc(err) + '</div>'), 400);
  if (!code || !state || state !== sess.state) {
    return sendHtml(res, page('認可エラー', '<div class="err">state が一致しません。最初からやり直してください。</div>'), 400);
  }
  const form = new URLSearchParams({
    client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, code: code,
    grant_type: 'authorization_code', redirect_uri: REDIRECT_URI
  });
  const r = await fetch(API + '/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const data = await r.json();
  if (!data.access_token) {
    return sendHtml(res, page('トークン取得失敗',
      '<div class="err">トークン取得に失敗しました:\n' + esc(JSON.stringify(data, null, 2)) + '</div>'), 400);
  }
  sess.accessToken = data.access_token;
  sess.openId = data.open_id;
  res.writeHead(302, { Location: '/tiktok/post' });
  res.end();
}

async function handlePostForm(req, res, sess) {
  const info = await apiPost('/v2/post/publish/creator_info/query/', sess.accessToken, {});
  if (!info.data) {
    return sendHtml(res, page('エラー',
      '<div class="err">クリエイター情報を取得できませんでした:\n' +
      esc(JSON.stringify(info, null, 2)) + '</div><p><a href="/tiktok">トップへ戻る</a></p>'), 400);
  }
  const c = info.data;
  const options = (c.privacy_level_options || [])
    .map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
  const dis = (flag) => flag ? ' disabled' : '';
  const body =
    '<h1>動画を投稿</h1>' +
    '<div class="creator"><img src="' + esc(c.creator_avatar_url) + '" alt="">' +
    '<div><strong>' + esc(c.creator_nickname) + '</strong><br>@' + esc(c.creator_username) + '</div></div>' +
    '<form method="post" enctype="multipart/form-data">' +
    '<label>動画ファイル（mp4 / webm）</label>' +
    '<input type="file" name="video" accept="video/mp4,video/webm" required>' +
    '<label>タイトル</label>' +
    '<input type="text" name="title" maxlength="2200" required>' +
    '<label>公開範囲（自分で選んでください）</label>' +
    '<select name="privacy_level" required>' +
    '<option value="" disabled selected>選択してください</option>' + options + '</select>' +
    '<fieldset><legend>視聴者の操作</legend>' +
    '<span class="row"><label><input type="checkbox" name="allow_comment"' + dis(c.comment_disabled) + '> コメント</label></span> ' +
    '<span class="row"><label><input type="checkbox" name="allow_duet"' + dis(c.duet_disabled) + '> デュエット</label></span> ' +
    '<span class="row"><label><input type="checkbox" name="allow_stitch"' + dis(c.stitch_disabled) + '> スティッチ</label></span>' +
    '</fieldset>' +
    '<fieldset><legend>開示設定</legend>' +
    '<span class="row"><label><input type="checkbox" name="brand_organic"> 自分のブランドを宣伝する</label></span><br>' +
    '<span class="row"><label><input type="checkbox" name="brand_content"> 有料パートナーシップ（第三者のブランド）</label></span>' +
    '</fieldset>' +
    '<button type="submit">TikTokへ投稿</button></form>';
  sendHtml(res, page('動画を投稿', body));
}

async function handlePostSubmit(req, res, sess) {
  const buf = await readBody(req);
  const parsed = parseMultipart(buf, req.headers['content-type']);
  if (!parsed || !parsed.file) {
    return sendHtml(res, page('エラー', '<div class="err">動画ファイルが選択されていません。</div>'), 400);
  }
  const f = parsed.fields;
  const video = parsed.file;
  if (!f.privacy_level) {
    return sendHtml(res, page('エラー', '<div class="err">公開範囲を選択してください。</div>'), 400);
  }
  const brandContent = f.brand_content === 'on';
  const brandOrganic = f.brand_organic === 'on';
  const postInfo = {
    title: f.title || '',
    privacy_level: f.privacy_level,
    disable_comment: f.allow_comment !== 'on',
    disable_duet: f.allow_duet !== 'on',
    disable_stitch: f.allow_stitch !== 'on',
    brand_content_toggle: brandContent,
    brand_organic_toggle: brandOrganic,
    is_aigc: false
  };
  const size = video.data.length;
  const chunkSize = size < CHUNK ? size : CHUNK;
  const total = Math.max(1, Math.ceil(size / chunkSize));
  const init = await apiPost('/v2/post/publish/video/init/', sess.accessToken, {
    post_info: postInfo,
    source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: total }
  });
  if (!init.data || !init.data.publish_id) {
    return sendHtml(res, page('投稿初期化失敗',
      '<div class="err">投稿の初期化に失敗しました:\n' + esc(JSON.stringify(init, null, 2)) + '</div>'), 400);
  }
  const publishId = init.data.publish_id;
  const uploadUrl = init.data.upload_url;
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, size) - 1;
    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': video.contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size
      },
      body: video.data.subarray(start, end + 1)
    });
    if (!(r.status === 200 || r.status === 201 || r.status === 206)) {
      return sendHtml(res, page('アップロード失敗',
        '<div class="err">チャンク ' + (i + 1) + ' のアップロードに失敗しました（HTTP ' + r.status + '）。publish_id: ' +
        esc(publishId) + '</div>'), 400);
    }
  }
  let status = {};
  for (let i = 0; i < 30; i++) {
    const st = await apiPost('/v2/post/publish/status/fetch/', sess.accessToken, { publish_id: publishId });
    status = st.data || {};
    if (['PUBLISH_COMPLETE', 'FAILED', 'SEND_TO_USER_INBOX'].includes(status.status)) break;
    await sleep(5000);
  }
  const body =
    '<h1>投稿結果</h1>' +
    '<p>publish_id: <code>' + esc(publishId) + '</code></p>' +
    '<p>ステータス: <strong>' + esc(status.status || '不明') + '</strong></p>' +
    (status.fail_reason ? '<div class="err">失敗理由: ' + esc(status.fail_reason) + '</div>' : '') +
    (status.status === 'PUBLISH_COMPLETE'
      ? '<div class="ok">投稿が完了しました。TikTokプロフィールで確認できます（未審査アプリのため自分のみ閲覧可の場合があります）。</div>' : '') +
    '<p><a href="/tiktok/status?publish_id=' + encodeURIComponent(publishId) + '">ステータスを再確認</a> / ' +
    '<a href="/tiktok/post">別の動画を投稿</a></p>';
  sendHtml(res, page('投稿結果', body));
}

async function handleStatus(req, res, sess, url) {
  const publishId = url.searchParams.get('publish_id') || '';
  const st = await apiPost('/v2/post/publish/status/fetch/', sess.accessToken, { publish_id: publishId });
  sendHtml(res, page('投稿ステータス',
    '<h1>投稿ステータス</h1><p>publish_id: <code>' + esc(publishId) + '</code></p>' +
    '<div class="ok">' + esc(JSON.stringify(st.data || st, null, 2)) + '</div>' +
    '<p><a href="/tiktok/post">投稿画面へ</a></p>'));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (path !== '/tiktok' && !path.startsWith('/tiktok/')) return false;
  try {
    const sess = getSession(req, res);
    if (path === '/tiktok' || path === '/tiktok/') { await handleHome(req, res); return true; }
    if (missingConfig().length) {
      sendHtml(res, page('設定不足', '<div class="err">環境変数が未設定です: ' +
        esc(missingConfig().join(', ')) + '</div>'), 500);
      return true;
    }
    if (path === '/tiktok/login') { handleLogin(req, res, sess); return true; }
    if (path === '/tiktok/callback') { await handleCallback(req, res, sess, url); return true; }
    if (path === '/tiktok/post') {
      if (!sess.accessToken) { res.writeHead(302, { Location: '/tiktok' }); res.end(); return true; }
      if (req.method === 'POST') await handlePostSubmit(req, res, sess);
      else await handlePostForm(req, res, sess);
      return true;
    }
    if (path === '/tiktok/status') {
      if (!sess.accessToken) { res.writeHead(302, { Location: '/tiktok' }); res.end(); return true; }
      await handleStatus(req, res, sess, url);
      return true;
    }
    sendHtml(res, page('Not found', '<p>Not found</p>'), 404);
    return true;
  } catch (e) {
    sendHtml(res, page('エラー', '<div class="err">' + esc(e && e.message) + '</div>'), 500);
    return true;
  }
}

module.exports = { handle };
