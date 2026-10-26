(function () {
  'use strict';

  var STORAGE_KEY = 'fed_family_v1';
  var INTERVAL_KEY = 'fed_interval_days';
  var REMOVAL_KEY = 'fed_removal_v1';
  var FREEZE_KEY = 'fed_freeze_status_v1';

  var BROKERS = window.FED_BROKERS || [];
  var NEED_LABELS = window.FED_NEED_LABELS || {};

  var CREDIT_BUREAUS = [
    { id: 'equifax', name: 'Equifax', url: 'https://my.equifax.com/consumer-registration/' },
    { id: 'experian', name: 'Experian', url: 'https://www.experian.com/freeze/center.html' },
    { id: 'transunion', name: 'TransUnion', url: 'https://www.transunion.com/credit-freeze' },
    { id: 'innovis', name: 'Innovis', url: 'https://www.innovis.com/securityFreeze/index' }
  ];

  var state = {
    family: [],
    intervalDays: 7,
    breachEnabled: false,
    removal: {},
    removalMemberId: null,
    openBroker: null,
    freezeStatus: {}
  };

  // ---------- persistence (client-side only, by design: no family PII sits on the server) ----------
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      state.family = raw ? JSON.parse(raw) : [];
    } catch (e) { state.family = []; }
    try {
      var iv = localStorage.getItem(INTERVAL_KEY);
      state.intervalDays = iv ? parseInt(iv, 10) : 7;
    } catch (e) { state.intervalDays = 7; }
    try {
      var rm = localStorage.getItem(REMOVAL_KEY);
      state.removal = rm ? JSON.parse(rm) : {};
    } catch (e) { state.removal = {}; }
    try {
      var fs = localStorage.getItem(FREEZE_KEY);
      state.freezeStatus = fs ? JSON.parse(fs) : {};
    } catch (e) { state.freezeStatus = {}; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.family)); } catch (e) {}
  }
  function saveInterval() {
    try { localStorage.setItem(INTERVAL_KEY, String(state.intervalDays)); } catch (e) {}
  }
  function saveRemoval() {
    try { localStorage.setItem(REMOVAL_KEY, JSON.stringify(state.removal)); } catch (e) {}
  }
  function saveFreezeStatus() {
    try { localStorage.setItem(FREEZE_KEY, JSON.stringify(state.freezeStatus)); } catch (e) {}
  }

  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

  function showToast(msg, isErr) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 3500);
  }

  // ---------- status ----------
  function loadStatus() {
    return fetch('/api/status').then(function (r) { return r.json(); }).then(function (d) {
      state.breachEnabled = !!d.breachCheckEnabled;
      state.linkCheckEnabled = !!d.linkCheckEnabled;
      var badge = document.getElementById('statusBadge');
      if (state.breachEnabled) {
        badge.textContent = d.hibpEnabled ? 'Breach checking: live (free + HIBP)' : 'Breach checking: live (free)';
        badge.className = 'status-badge ok';
      } else {
        badge.textContent = 'Breach checking unavailable';
        badge.className = 'status-badge warn';
      }
      var linkNote = document.getElementById('linkCheckNote');
      if (linkNote) {
        linkNote.style.display = state.linkCheckEnabled ? 'none' : 'block';
      }
    }).catch(function () {
      var badge = document.getElementById('statusBadge');
      badge.textContent = 'Status unknown';
    });
  }

  // ---------- breach checking ----------
  function checkMember(member) {
    if (!state.breachEnabled) {
      member.status = 'no-key';
      save();
      renderAll();
      return Promise.resolve();
    }
    return fetch('/api/breach-check?email=' + encodeURIComponent(member.email))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.noKey) {
          member.status = 'no-key';
        } else if (d.ok) {
          // Diff against the last good check so a recheck can say what is NEW.
          var hadPrior = member.lastChecked && (member.status === 'clean' || member.status === 'exposed');
          var priorNames = (member.breaches || []).map(function (b) { return b.name; });
          var fresh = (d.breaches || []).filter(function (b) { return priorNames.indexOf(b.name) === -1; });
          if (hadPrior && fresh.length) {
            member.newBreaches = (member.newBreaches || []).concat(fresh.map(function (b) { return b.title || b.name; }));
            member.newSince = Date.now();
            member.alerted = false;
          }
          member.status = d.breachCount > 0 ? 'exposed' : 'clean';
          member.breachCount = d.breachCount;
          member.breaches = d.breaches;
          member.pasteCount = d.pasteCount || 0;
          member.pastes = d.pastes || [];
        } else {
          member.status = 'error';
          member.error = d.error;
        }
        member.lastChecked = Date.now();
        save();
        renderAll();
      })
      .catch(function (err) {
        member.status = 'error';
        member.error = err.message;
        member.lastChecked = Date.now();
        save();
        renderAll();
      });
  }

  // ---------- automatic rechecking ----------
  // Runs whenever the app is open or brought back to the foreground (and on a
  // 30-minute timer while it stays open). Family data lives only in this
  // browser, so a recheck can only happen while the app is loaded here.
  var AUTO_TICK_MS = 30 * 60 * 1000;   // how often an open tab looks for due checks
  var MEMBER_GAP_MS = 2500;            // pause between members so the APIs don't rate-limit us
  var MIN_GAP_BETWEEN_RUNS_MS = 60 * 1000;
  var NOTIFY_KEY = 'fed_notify_v1';
  var lastRunStarted = 0;

  function isDue(m, now) {
    var intervalMs = state.intervalDays * 24 * 60 * 60 * 1000;
    return !m.lastChecked || (now - m.lastChecked) > intervalMs;
  }

  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // force = true rechecks everyone now (the "Check all now" button).
  function autoRecheckIfDue(force) {
    if (state.checking || !state.breachEnabled) { updateAutoNote(); return Promise.resolve(); }
    var now = Date.now();
    if (!force && now - lastRunStarted < MIN_GAP_BETWEEN_RUNS_MS) return Promise.resolve();
    var due = state.family.filter(function (m) { return force || isDue(m, now); });
    if (!due.length) { updateAutoNote(); return Promise.resolve(); }

    state.checking = true;
    lastRunStarted = now;
    updateAutoNote();

    // One member at a time, with a short gap, instead of firing every request at once.
    var chain = Promise.resolve();
    due.forEach(function (m, i) {
      chain = chain.then(function () { return i === 0 ? null : sleep(MEMBER_GAP_MS); })
        .then(function () { return checkMember(m); });
    });
    return chain.then(function () {
      state.checking = false;
      alertNewBreaches();
      updateAutoNote();
    }).catch(function () {
      state.checking = false;
      updateAutoNote();
    });
  }

  function alertNewBreaches() {
    var flagged = state.family.filter(function (m) { return m.newBreaches && m.newBreaches.length && !m.alerted; });
    flagged.forEach(function (m) {
      var msg = m.name + ': new breach' + (m.newBreaches.length === 1 ? '' : 'es') + ' found (' + m.newBreaches.slice(0, 3).join(', ') + (m.newBreaches.length > 3 ? ', …' : '') + ')';
      showToast(msg, true);
      try {
        if (notifyOn() && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Family Exposure Dashboard', { body: msg });
        }
      } catch (e) {}
      m.alerted = true;
    });
    if (flagged.length) save();
  }

  function notifyOn() {
    try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch (e) { return false; }
  }

  function setNotify(on) {
    try { localStorage.setItem(NOTIFY_KEY, on ? '1' : '0'); } catch (e) {}
    renderNotifyBtn();
  }

  function renderNotifyBtn() {
    var btn = document.getElementById('notifyBtn');
    if (!btn) return;
    if (!('Notification' in window)) { btn.style.display = 'none'; return; }
    var on = notifyOn() && Notification.permission === 'granted';
    btn.textContent = on ? '🔔 Alerts on' : '🔕 Alerts off';
  }

  function toggleNotify() {
    if (notifyOn()) { setNotify(false); return; }
    if (!('Notification' in window)) return;
    Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') {
        setNotify(true);
        showToast('Alerts on. You will get a notification when a recheck finds a new breach.');
      } else {
        setNotify(false);
        showToast('Notifications are blocked in this browser, so alerts stay off.', true);
      }
    });
  }

  function updateAutoNote() {
    var el = document.getElementById('autoNote');
    if (!el) return;
    if (state.checking) { el.textContent = 'Rechecking now…'; return; }
    if (!state.family.length) { el.textContent = ''; return; }
    var last = Math.max.apply(null, state.family.map(function (m) { return m.lastChecked || 0; }));
    var oldest = Math.min.apply(null, state.family.map(function (m) { return m.lastChecked || 0; }));
    var intervalMs = state.intervalDays * 24 * 60 * 60 * 1000;
    var dueIn = oldest ? (oldest + intervalMs) - Date.now() : 0;
    var nextTxt = dueIn <= 0 ? 'due now' : 'in ' + (dueIn < 3600000 ? Math.max(1, Math.round(dueIn / 60000)) + 'm' : dueIn < 86400000 ? Math.round(dueIn / 3600000) + 'h' : Math.round(dueIn / 86400000) + 'd');
    el.textContent = (last ? 'Last check ' + timeAgo(last) : 'Not checked yet') + ' · next auto-check ' + nextTxt + ' (runs while this page is open)';
  }

  // ---------- score ----------
  function renderScore() {
    var ring = document.getElementById('scoreRing');
    var num = document.getElementById('scoreNumber');
    var headline = document.getElementById('scoreHeadline');
    var sub = document.getElementById('scoreSub');

    if (state.family.length === 0) {
      num.textContent = '--';
      ring.style.background = 'conic-gradient(#262f45 0deg, #262f45 0deg)';
      headline.textContent = 'Add your family to get started';
      sub.textContent = "Everyone's exposure, in one place.";
      return;
    }

    var checked = state.family.filter(function (m) { return m.status && m.status !== 'no-key'; });
    var cleanCount = checked.filter(function (m) { return m.status === 'clean'; }).length;
    var exposedCount = checked.filter(function (m) { return m.status === 'exposed'; }).length;

    if (checked.length === 0) {
      num.textContent = '?';
      headline.textContent = state.breachEnabled ? 'Checking…' : 'Add a breach-check API key to score your family';
      sub.textContent = state.breachEnabled ? 'Running first checks now.' : 'Password checking still works without one.';
      return;
    }

    var pct = Math.round((cleanCount / checked.length) * 100);
    num.textContent = pct + '%';
    var color = pct >= 80 ? '#4fd68a' : pct >= 50 ? '#e8a94c' : '#f08a8a';
    ring.style.background = 'conic-gradient(' + color + ' ' + (pct * 3.6) + 'deg, #262f45 0deg)';

    if (exposedCount === 0) {
      headline.textContent = 'Everyone checked is clean';
      sub.textContent = cleanCount + ' of ' + checked.length + ' family members show no known breaches.';
    } else {
      headline.textContent = exposedCount + ' of ' + checked.length + ' family members have exposure to fix';
      sub.textContent = 'Tap a card below to see details and a fix checklist.';
    }
  }

  // ---------- family grid ----------
  function statusPillHtml(m) {
    if (m.status === 'clean') return '<span class="mc-pill pill-clean">Clean</span>';
    if (m.status === 'exposed') return '<span class="mc-pill pill-exposed">' + m.breachCount + ' breach' + (m.breachCount === 1 ? '' : 'es') + '</span>';
    if (m.status === 'no-key') return '<span class="mc-pill pill-unknown">No API key</span>';
    if (m.status === 'error') return '<span class="mc-pill pill-unknown">Check failed</span>';
    return '<span class="mc-pill pill-unknown">Checking…</span>';
  }

  function timeAgo(ts) {
    if (!ts) return 'never checked';
    var diff = Date.now() - ts;
    var mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.round(hrs / 24);
    return days + 'd ago';
  }

  function removalLine(m) {
    var s = removalSummary(m.id);
    return '<div class="mc-removal">Removals: ' + s.done + '/' + s.total + ' clear' +
      (s.need ? ' &middot; <span class="mc-need">' + s.need + ' need you</span>' : '') + '</div>';
  }

  function renderFamily() {
    var grid = document.getElementById('familyGrid');
    var empty = document.getElementById('emptyState');
    grid.innerHTML = '';
    if (state.family.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    state.family.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'member-card';
      card.innerHTML =
        '<div class="mc-top"><span class="mc-name">' + escapeHtml(m.name) + '</span><span>' +
          (m.newBreaches && m.newBreaches.length ? '<span class="mc-pill pill-new" title="' + escapeHtml(m.newBreaches.join(', ')) + '">' + m.newBreaches.length + ' new</span> ' : '') +
          statusPillHtml(m) + '</span></div>' +
        '<div class="mc-email">' + escapeHtml(m.email) + '</div>' +
        '<div class="mc-meta">Checked ' + timeAgo(m.lastChecked) + '</div>' + removalLine(m);
      card.addEventListener('click', function () {
        // opening a card counts as seeing what was new
        if (m.newBreaches && m.newBreaches.length) { m.newBreaches = []; m.alerted = false; save(); }
        openDetail(m.id);
        renderFamily();
      });
      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderAll() {
    renderScore();
    renderFamily();
    renderRemoval();
    renderFreezeTable();
    updateAutoNote();
  }

  // ---------- data broker removal (per person) ----------
  // Everything here stays in this browser's localStorage. The app never sends
  // names, phone numbers or listing addresses to the server.
  var STATUS_LABELS = {
    todo: 'Not checked',
    notlisted: 'Not listed',
    listed: 'Listed',
    submitted: 'Submitted: confirm email',
    confirmed: 'Confirmed: waiting',
    removed: 'Removed',
    reappeared: 'Came back'
  };
  var DAY = 24 * 60 * 60 * 1000;

  function getProfile(m) {
    m.profile = m.profile || {};
    return m.profile;
  }

  // What the broker search links and messages are built from.
  function searchProfile(m) {
    var p = getProfile(m);
    var parts = String(p.legalName || m.name || '').trim().split(/\s+/).filter(Boolean);
    return {
      first: parts[0] || '',
      last: parts.length > 1 ? parts[parts.length - 1] : '',
      city: String(p.city || '').trim(),
      st: String(p.state || '').trim().toUpperCase(),
      phones: String(p.phones || '').split(/[,;\n]+/)
        .map(function (s) { return s.replace(/\D/g, ''); })
        .filter(function (s) { return s.length === 10; })
    };
  }

  function getRec(memberId, brokerId) {
    var byMember = state.removal[memberId] || {};
    return byMember[brokerId] || { status: 'todo' };
  }

  function setRec(memberId, brokerId, patch) {
    state.removal[memberId] = state.removal[memberId] || {};
    var cur = state.removal[memberId][brokerId] || { status: 'todo' };
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    cur.updatedAt = Date.now();
    state.removal[memberId][brokerId] = cur;
    saveRemoval();
  }

  // Returns a short "what do I do next" string, or null if nothing is needed now.
  function attentionFor(rec) {
    var now = Date.now();
    if (rec.status === 'listed') return 'Start the opt-out';
    if (rec.status === 'reappeared') return 'It came back: submit again';
    if (rec.status === 'submitted') {
      return (now - (rec.submittedAt || rec.updatedAt || now)) > DAY
        ? 'No confirmation after a day: try the email fallback'
        : 'Click the confirmation link in the alias inbox';
    }
    if (rec.status === 'confirmed') {
      return (now - (rec.confirmedAt || rec.updatedAt || now)) > 3 * DAY ? 'Check whether the listing is gone' : null;
    }
    if (rec.status === 'removed' || rec.status === 'notlisted') {
      return (now - (rec.checkedAt || rec.updatedAt || now)) > state.intervalDays * DAY ? 'Recheck due' : null;
    }
    return null;
  }

  function removalSummary(memberId) {
    var done = 0, need = 0;
    BROKERS.forEach(function (b) {
      var r = getRec(memberId, b.id);
      if (r.status === 'removed' || r.status === 'notlisted') done++;
      if (attentionFor(r)) need++;
    });
    return { done: done, need: need, total: BROKERS.length };
  }

  function removalMessage(m, b, rec) {
    var p = getProfile(m);
    var sp = searchProfile(m);
    var where = [sp.city, sp.st].filter(Boolean).join(', ');
    var lines = [
      'Please remove my listing from ' + b.name + (b.also ? ' (and ' + b.also + ')' : '') + '.',
      '',
      'Name: ' + (p.legalName || m.name)
    ];
    if (where) lines.push('Location shown on your site: ' + where);
    if (rec.profileUrl) lines.push('Listing: ' + rec.profileUrl);
    lines.push('', 'Please suppress all name, address, phone and relative information tied to this record, and confirm by reply to this email address.');
    return lines.join('\n');
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      showToast(ok ? 'Copied' : 'Copy failed', !ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { showToast('Copied'); }, fallback);
    } else {
      fallback();
    }
  }

  function currentRemovalMember() {
    var m = state.family.find(function (x) { return x.id === state.removalMemberId; });
    if (!m && state.family.length) {
      m = state.family[0];
      state.removalMemberId = m.id;
    }
    return m || null;
  }

  function renderRemoval(keepProfile) {
    var chips = document.getElementById('removalMembers');
    var profileEl = document.getElementById('removalProfile');
    var needsEl = document.getElementById('removalNeeds');
    var list = document.getElementById('brokerList');
    var empty = document.getElementById('removalEmpty');
    if (!list || !chips) return;

    var member = currentRemovalMember();
    if (!member) {
      chips.innerHTML = '';
      profileEl.innerHTML = '';
      needsEl.innerHTML = '';
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    // member chips
    chips.innerHTML = state.family.map(function (m) {
      var s = removalSummary(m.id);
      return '<button class="chip' + (m.id === member.id ? ' active' : '') + '" data-member="' + escapeHtml(m.id) + '">' +
        escapeHtml(m.name) + ' <span class="chip-count">' + s.done + '/' + s.total + '</span>' +
        (s.need ? '<span class="chip-need">' + s.need + '</span>' : '') + '</button>';
    }).join('');

    // profile used for searches and messages
    var p = getProfile(member);
    if (!keepProfile) profileEl.innerHTML =
      '<div class="rp-grid">' +
      '<label>Full name as listed<input data-pfield="legalName" value="' + escapeHtml(p.legalName || member.name) + '" placeholder="e.g. Michael E Rivera" /></label>' +
      '<label>City<input data-pfield="city" value="' + escapeHtml(p.city || '') + '" placeholder="e.g. Hatfield" /></label>' +
      '<label>State (2 letters)<input data-pfield="state" maxlength="2" value="' + escapeHtml(p.state || '') + '" placeholder="PA" /></label>' +
      '<label>Phone numbers (comma separated)<input data-pfield="phones" value="' + escapeHtml(p.phones || '') + '" placeholder="e.g. 267-555-0100" /></label>' +
      '<label class="rp-wide">Alias email for opt-outs<input data-pfield="aliasEmail" type="email" value="' + escapeHtml(p.aliasEmail || '') + '" placeholder="a throwaway address used only for removals" /></label>' +
      '</div>' +
      '<p class="rp-note">Use a separate throwaway email for each person: BeenVerified allows one opt-out per address, and confirmation links land here. Only enter details a site already shows. Nothing here leaves this browser.</p>';

    // what needs the person right now
    var needs = [];
    BROKERS.forEach(function (b) {
      var a = attentionFor(getRec(member.id, b.id));
      if (a) needs.push({ broker: b, text: a });
    });
    if (needs.length) {
      needsEl.innerHTML = '<div class="needs-title">Needs you (' + needs.length + ')</div>' +
        needs.slice(0, 8).map(function (n) {
          return '<button class="need-row" data-open="' + n.broker.id + '"><strong>' + escapeHtml(n.broker.name) + '</strong> ' + escapeHtml(n.text) + '</button>';
        }).join('') +
        (needs.length > 8 ? '<div class="need-more">and ' + (needs.length - 8) + ' more below</div>' : '');
    } else {
      needsEl.innerHTML = '';
    }

    // broker rows
    var sp = searchProfile(member);
    list.innerHTML = BROKERS.map(function (b) {
      var rec = getRec(member.id, b.id);
      var attn = attentionFor(rec);
      var searchUrl = b.search ? b.search(sp) : null;
      var open = state.openBroker === b.id;

      var tags = (b.needs || []).map(function (n) {
        return '<span class="need-tag">' + escapeHtml(NEED_LABELS[n] || n) + '</span>';
      }).join('');

      var btn = function (status, label, extra) {
        return '<button class="btn btn-ghost btn-sm" data-act="set" data-broker="' + b.id + '" data-status="' + status + '"' + (extra || '') + '>' + label + '</button>';
      };
      var actions = '';
      if (rec.status === 'todo') actions = btn('notlisted', 'Not listed') + btn('listed', 'Found it');
      else if (rec.status === 'listed') actions = btn('submitted', 'I submitted it') + btn('notlisted', 'Not listed after all');
      else if (rec.status === 'submitted') actions = btn('confirmed', 'I clicked the email link');
      else if (rec.status === 'confirmed') actions = btn('removed', 'It is gone') + btn('listed', 'Still listed');
      else if (rec.status === 'removed') actions = btn('removed', 'Still gone') + btn('reappeared', 'It is back');
      else if (rec.status === 'notlisted') actions = btn('notlisted', 'Still not listed') + btn('listed', 'Found it');
      else if (rec.status === 'reappeared') actions = btn('submitted', 'Submitted again');

      var links = '';
      if (searchUrl) links += '<a class="btn btn-ghost btn-sm" href="' + escapeHtml(searchUrl) + '" target="_blank" rel="noopener">Search</a>';
      links += '<a class="btn btn-primary btn-sm" href="' + escapeHtml(b.optOutUrl) + '" target="_blank" rel="noopener">Opt-out page</a>';

      var detail = '';
      if (open) {
        var have = [];
        var fullName = p.legalName || member.name;
        if (fullName) have.push(['Name', fullName]);
        if (sp.city || sp.st) have.push(['Location', [sp.city, sp.st].filter(Boolean).join(', ')]);
        if (p.aliasEmail) have.push(['Alias email', p.aliasEmail]);
        sp.phones.forEach(function (ph) { have.push(['Phone', ph]); });

        detail = '<div class="br-detail">' +
          '<ol class="br-steps">' + b.steps.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol>' +
          (b.tip ? '<p class="br-tip">' + escapeHtml(b.tip) + '</p>' : '') +
          ((b.needs || []).some(function (n) { return n === 'captcha' || n === 'certify' || n === 'emailConfirm' || n === 'call'; })
            ? '<p class="br-human">These steps need a person: the app can\'t tick captchas, make the "this is me" certification, or open your alias inbox.</p>' : '') +
          (have.length ? '<div class="br-have"><span>Copy:</span>' + have.map(function (h) {
            return '<button class="copy-chip" data-copy="' + escapeHtml(h[1]) + '">' + escapeHtml(h[0]) + '</button>';
          }).join('') + '</div>' : '') +
          '<label class="br-field">Your listing address (paste it here to keep it)<input data-field="profileUrl" data-broker="' + b.id + '" value="' + escapeHtml(rec.profileUrl || '') + '" placeholder="https://..." /></label>' +
          '<label class="br-field">Notes<input data-field="note" data-broker="' + b.id + '" value="' + escapeHtml(rec.note || '') + '" placeholder="e.g. second form done, waiting on reply" /></label>' +
          '<div class="br-fallback">' +
          '<button class="btn btn-ghost btn-sm" data-act="copymsg" data-broker="' + b.id + '">Copy removal message</button>' +
          (b.fallbackEmail ? ' <button class="btn btn-ghost btn-sm" data-copy="' + escapeHtml(b.fallbackEmail) + '">Copy ' + escapeHtml(b.fallbackEmail) + '</button>' : '') +
          ' <button class="btn btn-ghost btn-sm" data-act="set" data-broker="' + b.id + '" data-status="todo">Reset</button>' +
          '</div></div>';
      }

      return '<div class="broker-row st-' + rec.status + '" data-row="' + b.id + '">' +
        '<div class="br-head">' +
        '<div class="br-main"><div class="br-top"><span class="bn-title">' + escapeHtml(b.name) + '</span>' +
        '<span class="rm-pill rm-' + rec.status + '">' + escapeHtml(STATUS_LABELS[rec.status] || rec.status) + '</span></div>' +
        (b.also ? '<div class="bn-note">Also covers: ' + escapeHtml(b.also) + '</div>' : '') +
        (tags ? '<div class="br-tags">' + tags + '</div>' : '') +
        (attn ? '<div class="br-attn">' + escapeHtml(attn) + '</div>' : '') +
        '</div>' +
        '<div class="br-actions">' + actions + links +
        '<button class="btn btn-ghost btn-sm" data-act="toggle" data-broker="' + b.id + '">' + (open ? 'Hide steps' : 'Steps') + '</button></div>' +
        '</div>' + detail + '</div>';
    }).join('');
  }

  function wireRemoval() {
    var section = document.getElementById('removalSection');
    if (!section) return;

    section.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('button') : null;
      if (!t) return;

      if (t.hasAttribute('data-member')) {
        state.removalMemberId = t.getAttribute('data-member');
        state.openBroker = null;
        renderRemoval();
        return;
      }
      if (t.hasAttribute('data-open')) {
        state.openBroker = t.getAttribute('data-open');
        renderRemoval();
        var row = section.querySelector('[data-row="' + state.openBroker + '"]');
        if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (t.hasAttribute('data-copy') && !t.hasAttribute('data-act')) {
        copyText(t.getAttribute('data-copy'));
        return;
      }

      var act = t.getAttribute('data-act');
      var bid = t.getAttribute('data-broker');
      var member = currentRemovalMember();
      if (!act || !member) return;
      var broker = BROKERS.find(function (b) { return b.id === bid; });
      if (!broker) return;

      if (act === 'toggle') {
        state.openBroker = state.openBroker === bid ? null : bid;
        renderRemoval();
      } else if (act === 'copymsg') {
        copyText(removalMessage(member, broker, getRec(member.id, bid)));
      } else if (act === 'set') {
        var status = t.getAttribute('data-status');
        var now = Date.now();
        var patch = { status: status };
        if (status === 'submitted') patch.submittedAt = now;
        if (status === 'confirmed') patch.confirmedAt = now;
        if (status === 'removed' || status === 'notlisted' || status === 'reappeared') patch.checkedAt = now;
        setRec(member.id, bid, patch);
        renderAll();
      }
    });

    section.addEventListener('change', function (e) {
      var el = e.target;
      var member = currentRemovalMember();
      if (!member) return;
      var pf = el.getAttribute && el.getAttribute('data-pfield');
      if (pf) {
        var val = el.value.trim();
        if (pf === 'state') val = val.toUpperCase();
        getProfile(member)[pf] = val;
        save();
        renderRemoval(true);
        return;
      }
      var field = el.getAttribute && el.getAttribute('data-field');
      if (field) {
        var patch = {};
        patch[field] = el.value.trim();
        setRec(member.id, el.getAttribute('data-broker'), patch);
      }
    });
  }

  // ---------- credit freeze checklist ----------
  function renderFreezeTable() {
    var wrap = document.getElementById('freezeTable');
    var empty = document.getElementById('freezeEmpty');
    if (!wrap) return;
    if (state.family.length === 0) {
      wrap.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    var html = '<table><thead><tr><th>Family member</th>';
    CREDIT_BUREAUS.forEach(function (b) {
      html += '<th>' + escapeHtml(b.name) + '<a href="' + b.url + '" target="_blank" rel="noopener">freeze &rarr;</a></th>';
    });
    html += '</tr></thead><tbody>';

    state.family.forEach(function (m) {
      state.freezeStatus[m.id] = state.freezeStatus[m.id] || {};
      html += '<tr><td>' + escapeHtml(m.name) + '</td>';
      CREDIT_BUREAUS.forEach(function (b) {
        var checked = !!state.freezeStatus[m.id][b.id];
        html += '<td><input type="checkbox" data-member="' + m.id + '" data-bureau="' + b.id + '" ' + (checked ? 'checked' : '') + ' /></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('input[type=checkbox][data-member]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var mId = cb.getAttribute('data-member');
        var bId = cb.getAttribute('data-bureau');
        state.freezeStatus[mId] = state.freezeStatus[mId] || {};
        state.freezeStatus[mId][bId] = cb.checked;
        saveFreezeStatus();
      });
    });
  }

  // ---------- suspicious link checker ----------
  function runLinkCheck() {
    var url = document.getElementById('linkInput').value.trim();
    var resultEl = document.getElementById('linkResult');
    if (!url) { resultEl.innerHTML = ''; return; }
    resultEl.innerHTML = '<p style="color:#a9b4cc;">Checking…</p>';
    fetch('/api/link-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) {
        var color = d.noKey ? '#e8a94c' : '#f08a8a';
        resultEl.innerHTML = '<p style="color:' + color + ';">' + escapeHtml(d.error || 'Check failed.') + '</p>';
        return;
      }
      if (d.flagged) {
        var html = '<div style="font-weight:700;color:#f08a8a;">⚠ Known malicious link — do not click</div>';
        html += '<div style="font-size:12px;color:#a9b4cc;margin-top:6px;">Threat type: ' + escapeHtml(d.threat || 'unknown') + '</div>';
        if (d.dateAdded) html += '<div style="font-size:12px;color:#a9b4cc;">Flagged since: ' + escapeHtml(d.dateAdded) + '</div>';
        resultEl.innerHTML = html;
      } else {
        resultEl.innerHTML = '<div style="font-weight:700;color:#4fd68a;">✓ Not found in known-malicious databases</div>' +
          '<div style="font-size:12px;color:#a9b4cc;margin-top:6px;">Not a guarantee of safety — stay cautious with links from people or senders you don\'t recognize.</div>';
      }
    }).catch(function () {
      resultEl.innerHTML = '<p style="color:#f08a8a;">Check failed — try again.</p>';
    });
  }

  // ---------- guided fix-it checklist ----------
  function buildChecklistSteps(breach) {
    var steps = [];
    var classes = (breach.dataClasses || []).map(function (c) { return c.toLowerCase(); });
    var hasPw = classes.some(function (c) { return c.indexOf('password') !== -1; });
    var hasFinancial = classes.some(function (c) { return c.indexOf('credit') !== -1 || c.indexOf('bank') !== -1 || c.indexOf('financial') !== -1; });
    var hasSsn = classes.some(function (c) { return c.indexOf('social security') !== -1 || c.indexOf('government') !== -1 || c.indexOf('id') !== -1; });

    if (hasPw) {
      steps.push('Change your password on ' + (breach.domain || breach.title) + ' right now');
      steps.push("Check anywhere else you've reused that same password, and change it there too");
    } else {
      steps.push('Review your account on ' + (breach.domain || breach.title) + ' for anything you did not recognize');
    }
    steps.push('Turn on two-factor authentication for this account if it offers it');
    if (hasFinancial) {
      steps.push('Check recent statements for your card or bank account for unfamiliar charges');
      steps.push('Consider calling your card issuer or bank to flag the exposure');
    }
    if (hasSsn) {
      steps.push('Consider placing a free credit freeze with the major credit bureaus');
    }
    steps.push('Use a password manager so every account gets its own strong password going forward');
    return steps;
  }

  function checklistKey(memberId, breachName) {
    return memberId + '::' + breachName;
  }

  function getChecklistState(member, breach) {
    member.checklists = member.checklists || {};
    var key = breach.name;
    if (!member.checklists[key]) {
      member.checklists[key] = buildChecklistSteps(breach).map(function (text) {
        return { text: text, done: false };
      });
    }
    return member.checklists[key];
  }

  // ---------- detail modal ----------
  var currentDetailMemberId = null;

  function openDetail(memberId) {
    currentDetailMemberId = memberId;
    renderDetail();
    document.getElementById('detailModal').classList.remove('hidden');
  }

  function closeDetail() {
    document.getElementById('detailModal').classList.add('hidden');
    currentDetailMemberId = null;
  }

  function renderDetail() {
    var member = state.family.find(function (m) { return m.id === currentDetailMemberId; });
    if (!member) return;
    document.getElementById('detailName').textContent = member.name;
    var body = document.getElementById('detailBody');

    var html = '';
    html += '<div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;">';
    html += '<button class="btn btn-primary" id="recheckBtn">Re-check now</button>';
    html += '<button class="btn btn-danger" id="removeBtn">Remove from dashboard</button>';
    html += '</div>';

    if (member.status === 'no-key') {
      html += '<p style="color:#a9b4cc;font-size:13px;">Breach checking needs an HIBP API key added on the server. Password checking below still works without it.</p>';
    } else if (member.status === 'error') {
      html += '<p style="color:#f08a8a;font-size:13px;">Last check failed: ' + escapeHtml(member.error || 'unknown error') + '</p>';
    } else if (member.status === 'clean') {
      html += '<p style="color:#4fd68a;font-size:13px;">No known breaches for ' + escapeHtml(member.email) + '.</p>';
      if (member.pasteCount) {
        html += '<p style="color:#e8a94c;font-size:13px;">But found in ' + member.pasteCount + ' dark-web paste' + (member.pasteCount === 1 ? '' : 's') + ' — data dumped outside formal breaches. Worth treating like a breach: change reused passwords tied to this email.</p>';
      }
    } else if (member.status === 'exposed' && member.breaches) {
      member.breaches.forEach(function (b) {
        var checklist = getChecklistState(member, b);
        html += '<div class="breach-item">';
        html += '<div class="b-title">' + escapeHtml(b.title) + '</div>';
        html += '<div class="b-date">Breached ' + escapeHtml(b.breachDate || '?') + '</div>';
        html += '<div class="b-desc">' + escapeHtml((b.description || '').slice(0, 220)) + (b.description && b.description.length > 220 ? '…' : '') + '</div>';
        html += '<div class="b-classes">' + (b.dataClasses || []).map(function (c) { return '<span class="b-class-pill">' + escapeHtml(c) + '</span>'; }).join('') + '</div>';
        html += '<div class="checklist">';
        checklist.forEach(function (item, idx) {
          html += '<label class="checklist-item ' + (item.done ? 'done' : '') + '">' +
            '<input type="checkbox" data-breach="' + escapeHtml(b.name) + '" data-idx="' + idx + '" ' + (item.done ? 'checked' : '') + ' />' +
            '<span>' + escapeHtml(item.text) + '</span></label>';
        });
        html += '</div></div>';
      });
      if (member.pasteCount) {
        html += '<div class="paste-item"><div class="p-title">⚠ Also found in ' + member.pasteCount + ' dark-web paste' + (member.pasteCount === 1 ? '' : 's') + '</div>' +
          '<div class="p-sub">Data dumped outside formal breach disclosures. Treat it the same as a breach above — change any reused passwords.</div></div>';
      }
    } else {
      html += '<p style="color:#a9b4cc;font-size:13px;">Not checked yet.</p>';
    }

    body.innerHTML = html;

    var recheckBtn = document.getElementById('recheckBtn');
    if (recheckBtn) recheckBtn.addEventListener('click', function () {
      recheckBtn.textContent = 'Checking…';
      checkMember(member).then(function () { renderDetail(); });
    });
    var removeBtn = document.getElementById('removeBtn');
    if (removeBtn) removeBtn.addEventListener('click', function () {
      state.family = state.family.filter(function (m) { return m.id !== member.id; });
      save();
      renderAll();
      closeDetail();
    });

    body.querySelectorAll('input[type=checkbox][data-breach]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var bName = cb.getAttribute('data-breach');
        var idx = parseInt(cb.getAttribute('data-idx'), 10);
        member.checklists[bName][idx].done = cb.checked;
        save();
        renderDetail();
      });
    });
  }

  // ---------- add member modal ----------
  function openAddModal() {
    document.getElementById('newName').value = '';
    document.getElementById('newEmail').value = '';
    document.getElementById('addModal').classList.remove('hidden');
  }
  function closeAddModal() {
    document.getElementById('addModal').classList.add('hidden');
  }
  function confirmAdd() {
    var name = document.getElementById('newName').value.trim();
    var email = document.getElementById('newEmail').value.trim().toLowerCase();
    if (!name || !email || !email.includes('@')) {
      showToast('Enter a name and a valid email', true);
      return;
    }
    var member = { id: uid(), name: name, email: email, status: 'pending', lastChecked: null, breachCount: 0, breaches: [], checklists: {} };
    state.family.push(member);
    save();
    renderAll();
    closeAddModal();
    showToast('Checking ' + name + '…');
    checkMember(member);
  }

  // ---------- password strength tool ----------
  function runPasswordCheck() {
    var pw = document.getElementById('pwInput').value;
    var resultEl = document.getElementById('pwResult');
    if (!pw) { resultEl.innerHTML = ''; return; }
    resultEl.innerHTML = '<p style="color:#a9b4cc;">Checking…</p>';
    fetch('/api/password-strength', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { resultEl.innerHTML = '<p style="color:#f08a8a;">Check failed.</p>'; return; }
      var pct = Math.round((d.score / d.maxScore) * 100);
      var color = pct >= 80 ? '#4fd68a' : pct >= 50 ? '#e8a94c' : '#f08a8a';
      var html = '<div style="font-weight:700;color:' + color + ';">' + escapeHtml(d.label) + '</div>';
      html += '<div class="pw-meter"><div class="pw-meter-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>';
      if (d.notes && d.notes.length) {
        html += '<ul class="pw-notes">' + d.notes.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') + '</ul>';
      }
      resultEl.innerHTML = html;
    }).catch(function () {
      resultEl.innerHTML = '<p style="color:#f08a8a;">Check failed — try again.</p>';
    });
  }

  // ---------- wire up ----------
  function init() {
    load();
    document.getElementById('intervalSelect').value = String(state.intervalDays);
    document.getElementById('intervalSelect').addEventListener('change', function (e) {
      state.intervalDays = parseInt(e.target.value, 10);
      saveInterval();
      lastRunStarted = 0;
      autoRecheckIfDue();
      updateAutoNote();
    });

    document.getElementById('addMemberBtn').addEventListener('click', openAddModal);
    document.getElementById('cancelAdd').addEventListener('click', closeAddModal);
    document.getElementById('confirmAdd').addEventListener('click', confirmAdd);
    document.getElementById('closeDetail').addEventListener('click', closeDetail);

    document.getElementById('pwCheckBtn').addEventListener('click', runPasswordCheck);
    document.getElementById('pwInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runPasswordCheck();
    });
    document.getElementById('pwToggle').addEventListener('click', function () {
      var input = document.getElementById('pwInput');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('linkCheckBtn').addEventListener('click', runLinkCheck);
    document.getElementById('linkInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') runLinkCheck();
    });

    wireRemoval();
    renderAll();
    renderNotifyBtn();

    var notifyBtn = document.getElementById('notifyBtn');
    if (notifyBtn) notifyBtn.addEventListener('click', toggleNotify);
    var recheckBtn = document.getElementById('recheckAllBtn');
    if (recheckBtn) recheckBtn.addEventListener('click', function () {
      if (!state.family.length) { showToast('Add a family member first.', true); return; }
      if (!state.breachEnabled) { showToast('Breach checking is unavailable right now.', true); return; }
      showToast('Rechecking everyone…');
      autoRecheckIfDue(true);
    });

    // Wait for the server status, then run any checks that are due (no more guessing with a timeout).
    loadStatus().then(function () { return autoRecheckIfDue(); });

    // Keep checking while the page stays open, and again whenever it comes back to the foreground.
    setInterval(function () { autoRecheckIfDue(); updateAutoNote(); }, AUTO_TICK_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { autoRecheckIfDue(); updateAutoNote(); }
    });
    window.addEventListener('online', function () { autoRecheckIfDue(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
