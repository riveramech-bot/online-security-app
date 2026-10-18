const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HIBP_API_KEY = process.env.HIBP_API_KEY || '';
const ABUSECH_AUTH_KEY = process.env.ABUSECH_AUTH_KEY || '';
const PORT = process.env.PORT || 3000;

// ---------- simple in-memory cache (per-process, resets on restart) ----------
const cacheStore = new Map();
function cached(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = cacheStore.get(key);
  if (hit && now - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fetcher().then((v) => {
    cacheStore.set(key, { v, t: now });
    return v;
  });
}

// ---------- status: tells the frontend whether breach-checking is live ----------
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    breachCheckEnabled: true, // XposedOrNot is free/keyless, so this is always on
    hibpEnabled: Boolean(HIBP_API_KEY), // optional extra coverage layer
    passwordCheckEnabled: true, // this one is always free/keyless too
    linkCheckEnabled: Boolean(ABUSECH_AUTH_KEY)
  });
});

// ---------- breach check ----------
// Primary source: XposedOrNot's breach-analytics API — free, keyless, no
// signup required. If an HIBP_API_KEY is ever added, its results get merged
// in too (deduped by breach name) for broader coverage, but nothing here
// depends on that key existing.
async function fetchXposedOrNot(email) {
  const url = `https://api.xposedornot.com/v1/breach-analytics?email=${encodeURIComponent(email)}`;
  const r = await fetch(url, {
    headers: { 'user-agent': 'family-exposure-dashboard' },
    signal: AbortSignal.timeout(15000)
  });
  if (r.status === 429) throw new Error('rate-limited');
  if (!r.ok) throw new Error(`XposedOrNot responded ${r.status}`);
  const json = await r.json();
  const details = (json.ExposedBreaches && json.ExposedBreaches.breaches_details) || [];
  const breaches = details.map((b) => ({
    name: b.breach,
    title: b.breach,
    domain: b.domain || null,
    breachDate: b.xposed_date ? String(b.xposed_date) : null,
    addedDate: null,
    pwnCount: typeof b.xposed_records === 'number' ? b.xposed_records : null,
    description: b.details || '',
    dataClasses: b.xposed_data ? b.xposed_data.split(';').map((s) => s.trim()).filter(Boolean) : [],
    isVerified: Boolean(b.verified),
    isSensitive: false
  }));

  // Pastes: data dumped in hacker "paste" sites (Pastebin and similar),
  // separate from formal breach disclosures. Same free source, no extra call.
  const pastesSummary = json.PastesSummary || {};
  const pasteCount = parseInt(pastesSummary.cnt, 10) || 0;
  const rawPastes = json.ExposedPastes;
  const pastes = Array.isArray(rawPastes)
    ? rawPastes
    : (rawPastes && typeof rawPastes === 'object' ? Object.values(rawPastes) : []);

  return { breaches, pasteCount, pastes: pastes.filter((p) => p && typeof p === 'object') };
}

async function fetchHibp(email) {
  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
  const r = await fetch(url, {
    headers: {
      'hibp-api-key': HIBP_API_KEY,
      'user-agent': 'family-exposure-dashboard'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (r.status === 404) return []; // HIBP's documented "no breaches found" response
  if (r.status === 429) throw new Error('rate-limited');
  if (!r.ok) throw new Error(`HIBP responded ${r.status}`);
  const raw = await r.json();
  return raw.map((b) => ({
    name: b.Name,
    title: b.Title,
    domain: b.Domain,
    breachDate: b.BreachDate,
    addedDate: b.AddedDate,
    pwnCount: b.PwnCount,
    description: (b.Description || '').replace(/<[^>]+>/g, ''),
    dataClasses: b.DataClasses || [],
    isVerified: b.IsVerified,
    isSensitive: b.IsSensitive
  }));
}

app.get('/api/breach-check', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email required' });
  }

  const key = `breach:${email}:${HIBP_API_KEY ? 'with-hibp' : 'free-only'}`;
  try {
    const result = await cached(key, 6 * 60 * 60 * 1000, async () => {
      const fetchers = [fetchXposedOrNot(email)];
      if (HIBP_API_KEY) fetchers.push(fetchHibp(email).then((breaches) => ({ breaches, pasteCount: 0, pastes: [] })));

      const sources = await Promise.allSettled(fetchers);
      const anySucceeded = sources.some((s) => s.status === 'fulfilled');

      if (!anySucceeded) {
        // Every configured source failed — this is a real check failure,
        // not "no breaches found", so don't report it as clean.
        throw sources[0].reason;
      }

      const merged = [];
      const seen = new Set();
      let pasteCount = 0;
      let pastes = [];
      for (const s of sources) {
        if (s.status !== 'fulfilled') continue;
        for (const b of s.value.breaches) {
          const k = (b.name || '').toLowerCase();
          if (!seen.has(k)) {
            merged.push(b);
            seen.add(k);
          }
        }
        if (s.value.pasteCount) pasteCount = s.value.pasteCount;
        if (s.value.pastes && s.value.pastes.length) pastes = s.value.pastes;
      }
      return { breaches: merged, pasteCount, pastes };
    });

    res.json({
      ok: true,
      email,
      breachCount: result.breaches.length,
      breaches: result.breaches,
      pasteCount: result.pasteCount,
      pastes: result.pastes
    });
  } catch (err) {
    const rateLimited = err.message === 'rate-limited';
    res.status(rateLimited ? 429 : 502).json({
      ok: false,
      error: rateLimited
        ? 'Rate-limited, try again in a few minutes.'
        : `Breach lookup failed: ${err.message}`
    });
  }
});

// ---------- password strength check ----------
// Two parts, both run server-side so nothing sensitive stays in the browser
// longer than it has to:
//  1. Local heuristic scoring (length, character variety, common patterns)
//  2. Have I Been Pwned's Pwned Passwords API, using k-anonymity: we only
//     ever send the first 5 characters of the SHA-1 hash, never the password
//     or the full hash. This endpoint is free and needs no API key.
const COMMON_PASSWORDS = new Set([
  'password', '123456', '123456789', 'qwerty', 'abc123', 'password1',
  'iloveyou', '111111', '123123', 'admin', 'letmein', 'welcome',
  'monkey', 'dragon', 'football', 'baseball', 'master', 'sunshine',
  'princess', 'qwerty123', '000000', '1q2w3e4r', 'trustno1'
]);

function localHeuristicScore(pw) {
  let score = 0;
  const notes = [];

  if (pw.length >= 8) score += 1;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (pw.length < 8) notes.push('Shorter than 8 characters');

  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);
  const variety = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  score += variety - 1; // 0..3 extra points

  if (variety < 3) notes.push('Mix in uppercase, numbers, and symbols');

  if (/(.)\1\1/.test(pw)) { score -= 1; notes.push('Repeated characters in a row'); }
  if (/^[0-9]+$/.test(pw)) { score -= 1; notes.push('All numbers'); }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) { score -= 3; notes.push('This is one of the most common passwords in the world'); }

  score = Math.max(0, Math.min(6, score));
  return { score, notes };
}

async function checkPwnedPassword(pw) {
  const sha1 = crypto.createHash('sha1').update(pw, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  const url = `https://api.pwnedpasswords.com/range/${prefix}`;
  const r = await fetch(url, {
    headers: { 'user-agent': 'family-exposure-dashboard' },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`Pwned Passwords API responded ${r.status}`);
  const text = await r.text();
  const lines = text.split('\n');
  for (const line of lines) {
    const [hashSuffix, count] = line.trim().split(':');
    if (hashSuffix === suffix) {
      return { pwned: true, count: parseInt(count, 10) || 0 };
    }
  }
  return { pwned: false, count: 0 };
}

app.post('/api/password-strength', async (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (!pw) return res.status(400).json({ ok: false, error: 'password required' });

  const { score, notes } = localHeuristicScore(pw);

  let pwned = null;
  try {
    pwned = await checkPwnedPassword(pw);
  } catch (err) {
    // Don't fail the whole request just because the pwned-check is down;
    // still return the local heuristic.
    pwned = { pwned: null, count: 0, error: err.message };
  }

  let finalScore = score;
  const allNotes = [...notes];
  if (pwned && pwned.pwned) {
    finalScore = 0;
    allNotes.unshift(`Found in ${pwned.count.toLocaleString()} previous data breaches — do not use this password anywhere`);
  }

  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong', 'Excellent'];
  res.json({
    ok: true,
    score: finalScore,
    maxScore: 6,
    label: labels[finalScore] || labels[0],
    pwned: pwned && pwned.pwned,
    pwnedCount: pwned ? pwned.count : null,
    notes: allNotes
  });
});

// ---------- suspicious link checker ----------
// Lookup against URLhaus (abuse.ch), a community-run database of known
// phishing/malware URLs. As of 2025 abuse.ch requires a free Auth-Key for
// API access (sign in with Google/GitHub/X/LinkedIn at auth.abuse.ch, no
// cost) — without one, this route says so clearly instead of pretending.
app.post('/api/link-check', async (req, res) => {
  if (!ABUSECH_AUTH_KEY) {
    return res.json({
      ok: false,
      noKey: true,
      error: 'No ABUSECH_AUTH_KEY configured yet. Free to get at auth.abuse.ch — add it in Render env vars to enable.'
    });
  }

  let input = String((req.body && req.body.url) || '').trim();
  if (!input) return res.status(400).json({ ok: false, error: 'url required' });
  if (!/^https?:\/\//i.test(input)) input = 'http://' + input;

  let parsed;
  try {
    parsed = new URL(input);
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'That doesn\'t look like a valid URL' });
  }

  const key = `link:${parsed.href}`;
  try {
    const result = await cached(key, 30 * 60 * 1000, async () => {
      const r = await fetch('https://urlhaus-api.abuse.ch/v1/url/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Auth-Key': ABUSECH_AUTH_KEY,
          'user-agent': 'family-exposure-dashboard'
        },
        body: new URLSearchParams({ url: parsed.href }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error(`URLhaus responded ${r.status}`);
      return r.json();
    });

    if (result.query_status === 'ok') {
      res.json({
        ok: true,
        checkedUrl: parsed.href,
        flagged: true,
        threat: result.threat || 'malicious',
        status: result.url_status || null,
        dateAdded: result.date_added || null,
        tags: result.tags || [],
        reference: result.urlhaus_reference || null
      });
    } else {
      // "no_results" (or any other non-"ok" status) means URLhaus has no
      // record of it — not a guarantee of safety, just nothing known-bad.
      res.json({ ok: true, checkedUrl: parsed.href, flagged: false });
    }
  } catch (err) {
    res.status(502).json({ ok: false, error: `Link check failed: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`online-security-app listening on :${PORT}`);
  console.log('breach checking: ENABLED (XposedOrNot, free/keyless)' + (HIBP_API_KEY ? ' + HIBP' : ''));
});
