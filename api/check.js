// FB UID Checker API — Vercel Serverless Function
//
//   GET  /api/check                       -> health / usage info
//   GET  /api/check?uid=100012345678901   -> check one UID
//   GET  /api/check?uids=id1,id2,id3      -> check a few UIDs
//   POST /api/check-uids  {"uids":[...]}  -> check up to 30 UIDs
//
// Optional protection: set env var API_KEY in Vercel, then send it as
// header "x-api-key: <key>" (or ?key=<key>).

const MAX_UIDS = 30;        // max UIDs per request
const TIMEOUT_MS = 8000;    // per attempt
const RETRIES = 1;          // extra attempt on network error/timeout

const MSG = {
  live: 'OK - Live Account',
  dead: 'Bad - Dead Account',
};

function extractUID(value) {
  const m = String(value ?? '').match(/\d{5,30}/);
  return m ? m[0] : '';
}

async function checkOnce(uid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://graph2.facebook.com/v3.3/${uid}/picture?redirect=0`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = (await r.text()).toLowerCase();
    const live = text.includes('height') && text.includes('width');
    return { uid, status: live ? 'live' : 'dead', live, message: live ? MSG.live : MSG.dead };
  } finally {
    clearTimeout(timer);
  }
}

async function checkUID(uid) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await checkOnce(uid);
    } catch (e) {
      lastErr = e;
    }
  }
  return {
    uid,
    status: 'error',
    live: false,
    message: lastErr?.name === 'AbortError' ? 'Request timeout' : (lastErr?.message || 'Request failed'),
  };
}

function summarize(results) {
  return {
    total: results.length,
    live: results.filter(r => r.status === 'live').length,
    dead: results.filter(r => r.status === 'dead').length,
    error: results.filter(r => r.status === 'error').length,
  };
}

// Accepts: array, "id1,id2", "id1\nid2", or Facebook URLs
function normalizeInput(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(/[\s,;]+/);
  const uids = [];
  const invalid = [];
  const seen = new Set();
  for (const item of list) {
    if (item === '' || item == null) continue;
    const uid = extractUID(item);
    if (!uid) { invalid.push(String(item)); continue; }
    if (!seen.has(uid)) { seen.add(uid); uids.push(uid); }
  }
  return { uids, invalid };
}

function fail(res, code, error, message) {
  return res.status(code).json({ success: false, error, message });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Optional API key protection
  const requiredKey = process.env.API_KEY;
  if (requiredKey) {
    const sent = req.headers['x-api-key'] || req.query?.key;
    if (sent !== requiredKey) return fail(res, 401, 'unauthorized', 'Invalid or missing API key');
  }

  try {
    let input;

    if (req.method === 'GET') {
      const q = req.query || {};
      input = q.uids ?? q.uid;
      if (input === undefined) {
        return res.status(200).json({
          success: true,
          name: 'FB UID Checker API',
          status: 'running',
          maxUidsPerRequest: MAX_UIDS,
          usage: {
            single: 'GET /api/check?uid=100012345678901',
            multiple: 'GET /api/check?uids=id1,id2,id3',
            bulk: 'POST /api/check-uids  body: {"uids":["id1","id2"]}',
          },
        });
      }
    } else if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { return fail(res, 400, 'invalid_json', 'Request body is not valid JSON'); }
      }
      input = body?.uids ?? body?.uid;
    } else {
      return fail(res, 405, 'method_not_allowed', 'Use GET or POST');
    }

    const { uids, invalid } = normalizeInput(input);

    if (!uids.length) {
      return fail(res, 400, 'no_valid_uid', 'Provide at least one valid numeric UID (5-30 digits)');
    }
    if (uids.length > MAX_UIDS) {
      return fail(res, 400, 'too_many_uids', `Maximum ${MAX_UIDS} UIDs per request. You sent ${uids.length}.`);
    }

    const results = await Promise.all(uids.map(checkUID));

    // Single UID -> flat response, easier to use
    if (uids.length === 1 && !Array.isArray(input) && req.method === 'GET') {
      return res.status(200).json({ success: true, ...results[0] });
    }

    return res.status(200).json({
      success: true,
      ...summarize(results),
      results,
      ...(invalid.length ? { invalid } : {}),
    });
  } catch (e) {
    return fail(res, 500, 'server_error', e?.message || 'Unexpected error');
  }
}
