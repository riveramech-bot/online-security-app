const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HIBP_API_KEY = process.env.HIBP_API_KEY || '';
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
    breachCheckEnabled: Boolean(HIBP_API_KEY),
    passwordCheckEnabled: true // this one is always free/keyless
  });
});

// ---------- breach check (Have I Been Pwned "breachedaccount" API) ----------
// Requires a paid HIBP API key (HIBP_API_KEY env var). Without one, this
// route reports that clearly instead of pretending to work.
app.get('/api/breach-check', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, error: 'Valid email required' });
  }
  if (!HIBP_API_KEY) {
    return res.json({
      ok: false,
      noKey: true,
      error: 'No HIBP_API_KEY configured yet. Add one in Render env vars to enable breach checking.'
    });
  }

  const key = `breach:${email}`;
  try {
    const result = await cached(key, 6 * 60 * 60 * 1000, async () => {
      const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
      const r = await fetch(url, {
        headers: {
          'hibp-api-key': HIBP_API_KEY,
          'user-agent': 'family-exposure-dashboard'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (r.status === 404) {
        // HIBP's documented "no breaches found" response
        return { breaches: [] };
      }
      if (r.status === 429) {
        throw new Error('rate-limited');
      }
      if (!r.ok) {
        throw new Error(`HIBP responded ${r.status}`);
      }
      const breaches = await r.json();
      return { breaches };
    });

    const breaches = (result.breaches || []).map((b) => ({
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

    res.json({ ok: true, email, breachCount: breaches.length, breaches });
  } catch (err) {
    const rateLimited = err.message === 'rate-limited';
    res.status(rateLimited ? 429 : 502).json({
      ok: false,
      error: rateLimited
        ? 'Rate-limited by HIBP, try again in a minute.'
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

app.listen(PORT, () => {
  console.log(`online-security-app listening on :${PORT}`);
  console.log(`breach checking: ${HIBP_API_KEY ? 'ENABLED' : 'disabled (no HIBP_API_KEY)'}`);
});
