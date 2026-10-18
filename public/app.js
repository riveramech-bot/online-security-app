(function () {
  'use strict';

  var STORAGE_KEY = 'fed_family_v1';
  var INTERVAL_KEY = 'fed_interval_days';

  var state = {
    family: [],
    intervalDays: 7,
    breachEnabled: false
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
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.family)); } catch (e) {}
  }
  function saveInterval() {
    try { localStorage.setItem(INTERVAL_KEY, String(state.intervalDays)); } catch (e) {}
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
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (d) {
      state.breachEnabled = !!d.breachCheckEnabled;
      var badge = document.getElementById('statusBadge');
      if (state.breachEnabled) {
        badge.textContent = 'Breach checking: live';
        badge.className = 'status-badge ok';
      } else {
        badge.textContent = 'Breach checking: add HIBP_API_KEY to enable';
        badge.className = 'status-badge warn';
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
          member.status = d.breachCount > 0 ? 'exposed' : 'clean';
          member.breachCount = d.breachCount;
          member.breaches = d.breaches;
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

  function autoRecheckIfDue() {
    var now = Date.now();
    var intervalMs = state.intervalDays * 24 * 60 * 60 * 1000;
    var due = state.family.filter(function (m) {
      return !m.lastChecked || (now - m.lastChecked) > intervalMs;
    });
    due.forEach(function (m) { checkMember(m); });
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
        '<div class="mc-top"><span class="mc-name">' + escapeHtml(m.name) + '</span>' + statusPillHtml(m) + '</div>' +
        '<div class="mc-email">' + escapeHtml(m.email) + '</div>' +
        '<div class="mc-meta">Checked ' + timeAgo(m.lastChecked) + '</div>';
      card.addEventListener('click', function () { openDetail(m.id); });
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
      autoRecheckIfDue();
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

    loadStatus();
    renderAll();
    // give status a moment to resolve before deciding whether to auto-recheck
    setTimeout(autoRecheckIfDue, 600);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
