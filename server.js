// npm install express cookie-parser multer  ← run once if not already installed
const express      = require('express');
const cookieParser = require('cookie-parser');
const multer        = require('multer');
const { randomUUID: uuidv4 } = require('crypto');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── Config ────────────────────────────────────────────────────────────────────
const STORE_FILE = path.join(__dirname, 'uploads.json');
const TTL_MS      = 2 * 60 * 60 * 1000; // 2 hours — link expires after this
const MAX_FILES   = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024;  // 5MB per file
const PQ_NAME_MAX   = 20;               // max chars for the "name this past question" field

const ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg'];
const ACCEPT_ATTR  = ALLOWED_EXT.join(',');
const FORMATS_LABEL = 'PDF, DOC, DOCX, PPT, PPTX, PNG, JPG';

// NOTE: reused from the Study Buddy signup app — update if this upload flow should be
// routed to a different WhatsApp number.
const STUDY_BUDDY_CONTACT_URL = 'https://wa.me/2349136086344?text=Hello';

const SUBMIT_WEBHOOK_URL = 'https://sb-n8n.rhat7s.easypanel.host/webhook/get_user';

// ── Atomic write queue (avoids race conditions / file corruption) ─────────────
let storeWriteQueue = Promise.resolve();

function loadStore() {
  try { if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (e) { console.error('loadStore error:', e); }
  return {};
}

function saveStore(store) {
  storeWriteQueue = storeWriteQueue.then(() => {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, STORE_FILE); // atomic on Linux
  }).catch(err => console.error('saveStore error:', err));
}

function isExpired(record) {
  return Date.now() > record.expiresAt;
}

// Removes expired records. No webhook is fired on expiry here — unlike a multi-stage
// registration flow, an abandoned upload link has nothing worth reporting to n8n.
function cleanup(store) {
  const now = Date.now();
  const expiredIds = Object.keys(store).filter(id => now > store[id].expiresAt);
  if (!expiredIds.length) return store;
  expiredIds.forEach(id => delete store[id]);
  saveStore(store);
  return store;
}

// Enforces "one active link per wa_id": before a new upload link is minted, any other
// non-done record for this same wa_id is deleted, so any older link immediately 404s.
function invalidateActiveByWaId(store, waId) {
  const staleIds = Object.keys(store).filter(id => store[id].wa_id === waId && store[id].stage !== 'done');
  if (!staleIds.length) return;
  staleIds.forEach(id => delete store[id]);
  saveStore(store);
}

setInterval(() => {
  const before = Object.keys(loadStore()).length;
  const store  = cleanup(loadStore());
  const after  = Object.keys(store).length;
  if (before !== after) console.log(`Periodic cleanup: removed ${before - after} expired upload link(s)`);
}, 5 * 60 * 1000);

// ── Small helpers ─────────────────────────────────────────────────────────────
function setSessionCookie(res, id, token) {
  res.cookie('usess_' + id, token, { maxAge: TTL_MS, httpOnly: false, sameSite: 'lax' });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Safe to drop inside a <script> tag — also guards against premature </script> breaks.
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// ── Multer (memory storage — files are relayed to n8n then discarded) ─────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error(`"${file.originalname}" is not an accepted file type.`));
    cb(null, true);
  }
}).any();

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /create-upload-link  { wa_id, username } → { link, id }
// Any other active (non-done) link already sitting for this wa_id is invalidated first
// — see invalidateActiveByWaId — so at most one upload link is ever "live" per wa_id.
app.post('/create-upload-link', (req, res) => {
  const { wa_id, username } = req.body || {};
  if (!wa_id || !username) return res.status(400).json({ error: 'Missing wa_id or username' });

  const id      = uuidv4();
  const waIdStr = String(wa_id);
  const store   = cleanup(loadStore());
  invalidateActiveByWaId(store, waIdStr);

  store[id] = {
    wa_id: waIdStr,
    username: String(username),
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    claimed: false,
    sessionToken: null,
    stage: 'upload',          // upload → done
    submittedAt: null,
    fileCount: 0
  };
  saveStore(store);

  const host     = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  res.json({ link: `${protocol}://${host}/upload/${id}`, id, expiresIn: '2 hours' });
});

// GET /upload/:id — serves the page for whatever stage the record is actually on.
app.get('/upload/:id', (req, res) => {
  const store  = cleanup(loadStore());
  const record = store[req.params.id];
  if (!record) return res.status(404).send(expiredPage());

  const cookieName    = 'usess_' + req.params.id;
  const sessionCookie = req.cookies?.[cookieName];

  if (!record.claimed) {
    const token = uuidv4();
    record.claimed      = true;
    record.sessionToken = token;
    saveStore(store);
    setSessionCookie(res, req.params.id, token);
    return res.send(renderPage(req.params.id, record));
  }

  if (sessionCookie === record.sessionToken) return res.send(renderPage(req.params.id, record));

  return res.status(403).send(claimedPage(req.params.id));
});

// POST /upload/:id/recover — cookie recovery without a token in the URL
app.post('/upload/:id/recover', (req, res) => {
  const store  = loadStore();
  const record = store[req.params.id];
  if (!record) return res.status(404).json({ ok: false, error: 'Upload link not found' });

  const { token } = req.body || {};
  if (!token || token !== record.sessionToken) return res.status(403).json({ ok: false, error: 'Invalid token' });

  setSessionCookie(res, req.params.id, record.sessionToken);
  res.json({ ok: true });
});

// POST /upload/:id/submit  (multipart/form-data: file0..fileN, name0..nameN)
// Files arrive as fileN / nameN pairs so each file's PQ-name survives multipart's lack
// of native array grouping. wa_id/username are pulled from the server-side record, not
// the client, so they can't be spoofed.
app.post('/upload/:id/submit', (req, res) => {
  const store  = loadStore();
  const record = store[req.params.id];
  const cookieName = 'usess_' + req.params.id;

  if (!record) return res.status(404).json({ ok: false, error: 'Upload link not found.' });
  if (req.cookies?.[cookieName] !== record.sessionToken) return res.status(403).json({ ok: false, error: 'Unauthorized' });

  if (isExpired(record)) {
    delete store[req.params.id];
    saveStore(store);
    return res.status(410).json({ ok: false, locked: true, error: 'This link has expired. Please request a new upload link on WhatsApp.' });
  }
  if (record.stage !== 'upload') {
    return res.status(400).json({ ok: false, error: 'This link has already been used.' });
  }

  upload(req, res, async function (err) {
    if (err) {
      let msg = 'Upload error. Please try again.';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'One or more files exceed the 5MB limit.';
        else if (err.code === 'LIMIT_FILE_COUNT') msg = `You can upload up to ${MAX_FILES} files.`;
        else msg = err.message || msg;
      } else if (err.message) {
        msg = err.message;
      }
      return res.status(400).json({ ok: false, error: msg });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'Please attach at least one file.' });
    if (files.length > MAX_FILES) return res.status(400).json({ ok: false, error: `You can upload up to ${MAX_FILES} files.` });

    // Pair each fileN with its nameN and validate the name.
    const items = [];
    for (const f of files) {
      const idxMatch = f.fieldname.match(/^file(\d+)$/);
      if (!idxMatch) continue; // ignore unexpected fields
      const pqName = String(req.body[`name${idxMatch[1]}`] || '').trim();
      if (!pqName) return res.status(400).json({ ok: false, error: `Please give "${f.originalname}" a name.` });
      if (pqName.length > PQ_NAME_MAX) return res.status(400).json({ ok: false, error: `Names must be ${PQ_NAME_MAX} characters or fewer.` });
      items.push({ file: f, name: pqName });
    }
    if (!items.length) return res.status(400).json({ ok: false, error: 'Please attach at least one file.' });

    // Relay to n8n as multipart/form-data (binary-safe, and matches how an n8n Webhook
    // node naturally ingests file uploads).
    const forwardForm = new FormData();
    forwardForm.append('wa_id', record.wa_id);
    forwardForm.append('username', record.username);
    forwardForm.append('submission_id', req.params.id);
    forwardForm.append('file_count', String(items.length));
    forwardForm.append('submitted_at', new Date().toISOString());
    items.forEach((item, i) => {
      forwardForm.append(`file${i}`, new Blob([item.file.buffer], { type: item.file.mimetype || 'application/octet-stream' }), item.file.originalname);
      forwardForm.append(`name${i}`, item.name);
    });

    let result;
    try {
      const r   = await fetch(SUBMIT_WEBHOOK_URL, { method: 'POST', body: forwardForm });
      const raw = await r.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* not JSON, that's fine */ }
      result = { httpOk: r.ok, data };
    } catch (e) {
      console.error('Submit webhook failed:', e.message);
      return res.status(502).json({ ok: false, error: 'Could not reach the upload service. Please try again.' });
    }

    if (!result.httpOk || result.data?.ok === false || result.data?.error) {
      return res.status(400).json({ ok: false, error: result.data?.error || result.data?.message || 'Upload could not be completed. Please try again.' });
    }

    record.stage       = 'done';
    record.submittedAt = Date.now();
    record.fileCount   = items.length;
    saveStore(store);
    res.json({ ok: true });
  });
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'PQ Upload' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PQ upload app running on port ${PORT}`));

// ── Shared page shell ─────────────────────────────────────────────────────────
const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23090b18'/><circle cx='16' cy='16' r='10' fill='none' stroke='%233b82f6' stroke-width='2'/><polyline points='11,16 14.5,20 21,12' fill='none' stroke='%2322c55e' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/></svg>`;

const BASE_STYLE = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  :root{
    --bg:#090b18;--surface:#0d1626;--surface2:#121d30;--border:#1e2d45;
    --accent:#3b82f6;--accent2:#60a5fa;--good:#22c55e;--bad:#ef4444;
    --amber:#f59e0b;--text:#e2e8f0;--muted:#64748b;--mono:'JetBrains Mono',monospace;
  }
  body{background:var(--bg);color:var(--text);font-family:'Sora',sans-serif;min-height:100vh;margin:0;overflow-x:hidden;}

  .bg-aura{
    position:fixed;inset:-25%;z-index:0;pointer-events:none;opacity:.7;
    background:conic-gradient(from 0deg at 50% 50%,
      rgba(59,130,246,.14), rgba(20,184,166,.10), rgba(124,58,237,.14),
      rgba(59,130,246,.10), rgba(20,184,166,.12), rgba(59,130,246,.14));
    filter:blur(90px);
    animation:auraSpin 30s linear infinite;
  }
  @keyframes auraSpin{ to{ transform:rotate(360deg); } }

  .bg-particles{
    position:fixed;inset:-40px;z-index:0;pointer-events:none;opacity:.55;
    background-image:
      radial-gradient(1.6px 1.6px at 12% 22%, rgba(226,232,240,.55) 0%, transparent 60%),
      radial-gradient(1.6px 1.6px at 68% 14%, rgba(226,232,240,.4) 0%, transparent 60%),
      radial-gradient(1.3px 1.3px at 38% 68%, rgba(226,232,240,.45) 0%, transparent 60%),
      radial-gradient(1.6px 1.6px at 86% 52%, rgba(226,232,240,.35) 0%, transparent 60%),
      radial-gradient(1.3px 1.3px at 8% 82%, rgba(226,232,240,.4) 0%, transparent 60%),
      radial-gradient(1.6px 1.6px at 55% 90%, rgba(226,232,240,.35) 0%, transparent 60%),
      radial-gradient(1.3px 1.3px at 92% 28%, rgba(226,232,240,.45) 0%, transparent 60%),
      radial-gradient(1.6px 1.6px at 28% 46%, rgba(226,232,240,.3) 0%, transparent 60%),
      radial-gradient(1.3px 1.3px at 78% 78%, rgba(226,232,240,.35) 0%, transparent 60%);
    animation:driftParticles 22s ease-in-out infinite;
  }
  @keyframes driftParticles{
    0%,100%{transform:translate(0,0);}
    50%{transform:translate(-16px,-22px);}
  }

  .bg-grid{position:fixed;inset:0;z-index:0;pointer-events:none;
    background-image:linear-gradient(rgba(99,102,241,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,.06) 1px,transparent 1px);
    background-size:44px 44px;animation:gridPulse 5s ease-in-out infinite;}
  @keyframes gridPulse{0%,100%{opacity:.45;}50%{opacity:1;}}
  .bg-orb{position:fixed;border-radius:50%;pointer-events:none;z-index:0;filter:blur(80px);}
  .bg-orb-1{width:520px;height:520px;top:-160px;right:-120px;background:radial-gradient(circle,rgba(99,102,241,.2) 0%,transparent 70%);animation:orbFloat 9s ease-in-out infinite;}
  .bg-orb-2{width:420px;height:420px;bottom:5%;left:-120px;background:radial-gradient(circle,rgba(20,184,166,.16) 0%,transparent 70%);animation:orbFloat 11s ease-in-out infinite reverse;}
  .bg-orb-3{width:300px;height:300px;top:38%;left:62%;background:radial-gradient(circle,rgba(124,58,237,.16) 0%,transparent 70%);animation:orbFloat 13s ease-in-out infinite;}
  @keyframes orbFloat{0%,100%{transform:translateY(0) scale(1);}50%{transform:translateY(-32px) scale(1.05);}}
  .wrap{max-width:460px;margin:0 auto;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;position:relative;z-index:1;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:32px 26px;width:100%;animation:slideIn .35s cubic-bezier(.4,0,.2,1);}
  @keyframes slideIn{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
  @keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
  .eyebrow{font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:.14em;text-transform:uppercase;margin-bottom:6px;}
  h1{font-size:1.35rem;font-weight:600;margin-bottom:8px;}
  .sub{color:var(--muted);font-size:.86rem;line-height:1.55;margin-bottom:22px;}
  label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:6px;letter-spacing:.02em;}
  input[type=text]{
    width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);
    font-family:'Sora',sans-serif;font-size:.92rem;padding:13px 14px;outline:none;transition:border-color .2s;margin-bottom:4px;
  }
  input[readonly]{color:var(--muted);cursor:default;}
  .field{margin-bottom:18px;}
  .banner{font-size:.82rem;padding:12px 14px;border-radius:10px;margin-bottom:16px;display:none;line-height:1.5;}
  .banner.show{display:block;animation:fadeIn .2s ease;}
  .banner.bad{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);color:#fca5a5;}
  .banner.good{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);color:#86efac;}
  .btn{width:100%;padding:14px;border-radius:12px;border:none;font-family:'Sora',sans-serif;font-size:.92rem;font-weight:600;
    cursor:pointer;transition:all .2s;background:linear-gradient(135deg,var(--accent),#7c3aed);color:#fff;}
  .btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(99,102,241,.35);}
  .btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none;}
  .center-icon{font-size:2.4rem;text-align:center;margin-bottom:14px;}
  .expiry-timer{font-family:var(--mono);font-size:.7rem;color:var(--muted);text-align:right;margin-bottom:14px;}
  .expiry-timer.warn{color:var(--amber);}
  .expiry-timer.danger{color:var(--bad);}

  /* Dropzone + file list */
  .dropzone{border:2px dashed var(--border);border-radius:14px;padding:30px 16px;text-align:center;cursor:pointer;
    transition:all .2s;margin-bottom:14px;background:var(--surface2);}
  .dropzone:hover,.dropzone.drag{border-color:var(--accent);background:rgba(59,130,246,.07);}
  .dz-icon{font-size:2rem;margin-bottom:8px;}
  .dz-text{font-size:.88rem;color:var(--text);margin-bottom:4px;}
  .dz-sub{font-size:.72rem;color:var(--muted);line-height:1.5;}
  .file-count-badge{font-family:var(--mono);font-size:.72rem;color:var(--muted);text-align:right;margin-bottom:14px;}
  .file-list{display:flex;flex-direction:column;gap:12px;margin-bottom:20px;}
  .file-item{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:14px;animation:fadeIn .2s ease;}
  .file-item-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
  .file-icon{font-size:1.25rem;flex-shrink:0;}
  .file-meta{flex:1;min-width:0;}
  .file-name{font-size:.83rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .file-size{font-size:.71rem;color:var(--muted);}
  .file-remove{background:none;border:none;color:var(--muted);font-size:1.15rem;line-height:1;cursor:pointer;padding:2px 6px;flex-shrink:0;}
  .file-remove:hover{color:var(--bad);}
  .pq-input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);
    font-family:'Sora',sans-serif;font-size:.83rem;padding:9px 11px;outline:none;transition:border-color .2s;margin-bottom:0;}
  .pq-input:focus{border-color:var(--accent);}
  .pq-input.err-input{border-color:var(--bad);}
  .char-row{display:flex;align-items:center;gap:8px;margin-top:7px;}
  .char-bar{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden;}
  .char-bar-fill{height:100%;width:0%;background:var(--good);border-radius:2px;transition:width .15s,background .15s;}
  .char-count{font-family:var(--mono);font-size:.66rem;color:var(--muted);flex-shrink:0;min-width:32px;text-align:right;}
  @media(max-width:380px){.card{padding:26px 18px;}}
`;

function shell(bodyHtml, title, tokenScript) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON}"/>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
  <style>${BASE_STYLE}</style></head><body>
  <div class="bg-aura"></div><div class="bg-particles"></div><div class="bg-grid"></div>
  <div class="bg-orb bg-orb-1"></div><div class="bg-orb bg-orb-2"></div><div class="bg-orb bg-orb-3"></div>
  <div class="wrap"><div class="card">${bodyHtml}</div></div>
  ${tokenScript || ''}
  </body></html>`;
}

// Keeps the session token available client-side so claimedPage() can recover a dropped
// cookie (e.g. a WhatsApp in-app browser blocking third-party cookies) without ever
// putting the token in the URL.
function tokenPersistScript(id, sessionToken) {
  return `<script>try{localStorage.setItem('ust_' + ${safeJson(id)}, ${safeJson(sessionToken)});}catch(e){}</script>`;
}

// Live "link expires in …" countdown. Reloads the page at zero so the server can serve
// the (now-expired) state.
function expiryTimerScript(expiresAt) {
  return `<script>
    (function(){
      var expiresAt = ${expiresAt};
      var el = document.getElementById('expiryTimer');
      if (!el) return;
      function tick(){
        var msLeft = expiresAt - Date.now();
        if (msLeft <= 0) { location.reload(); return; }
        var totalSec = Math.floor(msLeft / 1000);
        var h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
        var pad = function(n){ return String(n).padStart(2, '0'); };
        el.textContent = 'Link expires in ' + (h > 0 ? h + ':' + pad(m) : m) + ':' + pad(s);
        el.className = 'expiry-timer' + (msLeft < 5*60*1000 ? ' danger' : (msLeft < 15*60*1000 ? ' warn' : ''));
      }
      tick();
      setInterval(tick, 1000);
    })();
  </script>`;
}

function renderPage(id, record) {
  if (record.stage === 'upload') return uploadPage(id, record);
  if (record.stage === 'done')   return donePage(id, record);
  return expiredPage();
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Upload page ───────────────────────────────────────────────────────────────
function uploadPage(id, record) {
  const idJson        = safeJson(id);
  const identityLabel = `${record.username} • ${record.wa_id}`;
  const body = `
    <div class="expiry-timer" id="expiryTimer"></div>
    <div class="eyebrow">Upload Past Questions</div>
    <h1>Share your past questions</h1>
    <div class="sub">Can't find the past questions you need? Upload them here and we'll add them for everyone.</div>
    <div class="field">
      <label>Uploading as</label>
      <input type="text" readonly value="${escapeHtml(identityLabel)}" tabindex="-1"/>
    </div>
    <div class="banner bad" id="banner"></div>

    <div class="dropzone" id="dropzone">
      <div class="dz-icon">📎</div>
      <div class="dz-text">Drag & drop files here, or tap to browse</div>
      <div class="dz-sub">${FORMATS_LABEL}<br/>Max 5MB each • Up to ${MAX_FILES} files</div>
      <input type="file" id="fileInput" multiple hidden accept="${ACCEPT_ATTR}"/>
    </div>
    <div class="file-count-badge" id="fileCountBadge">0/${MAX_FILES} files selected</div>
    <div class="file-list" id="fileList"></div>

    <button class="btn" id="submitBtn" disabled>Submit past questions</button>

    <script>
      const ID            = ${idJson};
      const MAX_FILES     = ${MAX_FILES};
      const MAX_FILE_SIZE = ${MAX_FILE_SIZE};
      const PQ_NAME_MAX   = ${PQ_NAME_MAX};
      const ALLOWED_EXT   = ${safeJson(ALLOWED_EXT)};

      const dropzone       = document.getElementById('dropzone');
      const fileInput      = document.getElementById('fileInput');
      const fileList       = document.getElementById('fileList');
      const fileCountBadge = document.getElementById('fileCountBadge');
      const banner         = document.getElementById('banner');
      const btn            = document.getElementById('submitBtn');

      let entries = []; // { uid, file, name }
      let uidCounter = 0;

      function showBanner(msg, good) {
        banner.textContent = msg;
        banner.classList.toggle('good', !!good);
        banner.classList.toggle('bad', !good);
        banner.classList.add('show');
      }
      function clearBanner() { banner.classList.remove('show'); }

      function fileIcon(ext) {
        if (['.png', '.jpg', '.jpeg'].includes(ext)) return '🖼️';
        if (['.ppt', '.pptx'].includes(ext)) return '📊';
        if (['.doc', '.docx'].includes(ext)) return '📝';
        return '📄';
      }
      function extOf(filename) {
        const i = filename.lastIndexOf('.');
        return i === -1 ? '' : filename.slice(i).toLowerCase();
      }
      function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }

      function addFiles(fileArr) {
        const rejected = [];
        for (const file of fileArr) {
          const ext = extOf(file.name);
          if (!ALLOWED_EXT.includes(ext)) { rejected.push(file.name + ' (unsupported type)'); continue; }
          if (file.size > MAX_FILE_SIZE) { rejected.push(file.name + ' (over 5MB)'); continue; }
          if (entries.length >= MAX_FILES) { rejected.push(file.name + ' (limit of ' + MAX_FILES + ' reached)'); continue; }
          entries.push({ uid: 'f' + (uidCounter++), file, name: '' });
        }
        if (rejected.length) showBanner("Couldn't add: " + rejected.join(', '));
        else clearBanner();
        render();
      }

      function removeFile(uid) {
        entries = entries.filter(e => e.uid !== uid);
        render();
      }

      function render() {
        fileCountBadge.textContent = entries.length + '/' + MAX_FILES + ' files selected';
        fileList.innerHTML = entries.map(e => {
          const ext = extOf(e.file.name);
          const pct = Math.min(100, (e.name.length / PQ_NAME_MAX) * 100);
          const barColor = e.name.length >= PQ_NAME_MAX ? 'var(--amber)' : 'var(--good)';
          return \`
            <div class="file-item" data-uid="\${e.uid}">
              <div class="file-item-head">
                <div class="file-icon">\${fileIcon(ext)}</div>
                <div class="file-meta">
                  <div class="file-name">\${e.file.name}</div>
                  <div class="file-size">\${formatSize(e.file.size)}</div>
                </div>
                <button type="button" class="file-remove" data-remove="\${e.uid}" aria-label="Remove file">✕</button>
              </div>
              <input type="text" class="pq-input" data-name-for="\${e.uid}" placeholder="Name this past question (e.g. Pharm 2nd MCQ 2023)"
                     maxlength="\${PQ_NAME_MAX}" value="\${e.name.replace(/"/g,'&quot;')}"/>
              <div class="char-row">
                <div class="char-bar"><div class="char-bar-fill" style="width:\${pct}%;background:\${barColor};"></div></div>
                <div class="char-count">\${e.name.length}/\${PQ_NAME_MAX}</div>
              </div>
            </div>\`;
        }).join('');

        fileList.querySelectorAll('[data-remove]').forEach(elm => {
          elm.addEventListener('click', () => removeFile(elm.getAttribute('data-remove')));
        });
        fileList.querySelectorAll('[data-name-for]').forEach(elm => {
          elm.addEventListener('input', () => {
            const uid = elm.getAttribute('data-name-for');
            const entry = entries.find(x => x.uid === uid);
            if (entry) entry.name = elm.value;
            const row = elm.closest('.file-item');
            const pct = Math.min(100, (elm.value.length / PQ_NAME_MAX) * 100);
            row.querySelector('.char-bar-fill').style.width = pct + '%';
            row.querySelector('.char-bar-fill').style.background = elm.value.length >= PQ_NAME_MAX ? 'var(--amber)' : 'var(--good)';
            row.querySelector('.char-count').textContent = elm.value.length + '/' + PQ_NAME_MAX;
            checkValid();
          });
        });

        checkValid();
      }

      function checkValid() {
        const allNamed = entries.length > 0 && entries.every(e => e.name.trim().length > 0 && e.name.trim().length <= PQ_NAME_MAX);
        btn.disabled = !allNamed;
      }

      dropzone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files)); fileInput.value = ''; });
      ['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
      ['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
      dropzone.addEventListener('drop', e => { addFiles(Array.from(e.dataTransfer.files || [])); });

      // If a submit fails purely due to a dropped connection (not a real error
      // response), wait for the browser to report it's back online (or 8s, whichever
      // first) and retry automatically.
      function retryOnReconnect(attemptFn) {
        showBanner("No connection — we'll retry automatically once you're back online.", false);
        let fired = false, timer;
        function retryNow() {
          if (fired) return;
          fired = true;
          window.removeEventListener('online', retryNow);
          clearTimeout(timer);
          showBanner('Reconnected — retrying…', false);
          attemptFn();
        }
        window.addEventListener('online', retryNow);
        timer = setTimeout(retryNow, 8000);
      }

      async function attemptSubmit() {
        btn.disabled = true; btn.textContent = 'Uploading…';
        try {
          const form = new FormData();
          entries.forEach((e, i) => {
            form.append('file' + i, e.file, e.file.name);
            form.append('name' + i, e.name.trim());
          });
          const r = await fetch('/upload/' + ID + '/submit', { method: 'POST', credentials: 'same-origin', body: form });
          const data = await r.json();
          if (data.ok) { location.reload(); return; }
          showBanner(data.error || 'Something went wrong. Please try again.', false);
          if (data.locked) { btn.disabled = true; setTimeout(() => location.reload(), 1800); return; }
          btn.disabled = false; btn.textContent = 'Submit past questions';
          checkValid();
        } catch (e) {
          retryOnReconnect(attemptSubmit);
        }
      }

      btn.addEventListener('click', () => { clearBanner(); attemptSubmit(); });
      render();
    </script>`;
  return shell(body, 'Upload Past Questions', tokenPersistScript(id, record.sessionToken) + expiryTimerScript(record.expiresAt));
}

// ── Done page ─────────────────────────────────────────────────────────────────
function donePage(id, record) {
  const count = record.fileCount || 0;
  const body = `
    <div class="center-icon">🎉</div>
    <h1 style="text-align:center;">Thanks, ${escapeHtml(record.username)}!</h1>
    <div class="sub" style="text-align:center;margin-bottom:0;">
      ${count} file${count === 1 ? '' : 's'} submitted for review. You can close this page and head back to WhatsApp.
    </div>`;
  const cleanupScript = `<script>try{localStorage.removeItem('ust_' + ${safeJson(id)});}catch(e){}</script>`;
  return shell(body, 'Upload Complete', cleanupScript);
}

// ── Expired / recovery pages ──────────────────────────────────────────────────
function expiredPage() {
  const body = `
    <div class="center-icon">⏳</div>
    <h1 style="text-align:center;">Link expired</h1>
    <div class="sub" style="text-align:center;">This upload link is no longer valid — it may have expired, been replaced by a newer link, or already been used.</div>
    <div class="sub" style="text-align:center;margin-bottom:0;"><a href="${STUDY_BUDDY_CONTACT_URL}" target="_blank" rel="noopener noreferrer" style="color:var(--accent2);font-weight:600;text-decoration:underline;">Contact Study Buddy</a> on WhatsApp for a new link.</div>`;
  return shell(body, 'Upload Link Expired');
}

function claimedPage(id) {
  const idJson = safeJson(id);
  const body = `
    <div class="center-icon" id="iconChecking">🔒</div>
    <h1 style="text-align:center;" id="titleChecking">Reconnecting…</h1>
    <div class="sub" style="text-align:center;" id="msgChecking">Verifying your session…</div>
    <div id="errorBox" style="display:none;">
      <div class="center-icon">⚠️</div>
      <h1 style="text-align:center;color:var(--bad);">Link unavailable</h1>
      <div class="sub" style="text-align:center;margin-bottom:0;">This upload link is already in use by another session.</div>
    </div>
    <script>
      (function() {
        var tok = localStorage.getItem('ust_' + ${idJson});
        if (!tok) { showError(); return; }
        fetch('/upload/' + ${idJson} + '/recover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ token: tok })
        }).then(function(r) {
          if (r.ok) location.href = '/upload/' + ${idJson};
          else showError();
        }).catch(showError);
        function showError() {
          document.getElementById('iconChecking').style.display = 'none';
          document.getElementById('titleChecking').style.display = 'none';
          document.getElementById('msgChecking').style.display = 'none';
          document.getElementById('errorBox').style.display = 'block';
        }
      })();
    </script>`;
  return shell(body, 'Reconnecting');
}
