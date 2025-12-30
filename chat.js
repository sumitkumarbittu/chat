const api_base = "https://chat-d8ex.onrender.com";

(function () {
  const launcher = document.getElementById('chat-launcher');
  const popup = document.getElementById('chat-popup');
  const closeBtn = document.getElementById('chat-close');
  const messagesEl = document.getElementById('chat-messages');
  const welcomeEl = document.getElementById('chat-welcome');
  const launcherLabelEl = document.getElementById('chat-launcher-label');
  const launcherBadgeEl = document.getElementById('chat-launcher-badge');

  const form = document.getElementById('chat-form');
  const textInput = document.getElementById('chat-text');
  const fileInput = document.getElementById('chat-file');
  const fileHint = document.getElementById('chat-file-hint');

  const allowedExt = ['png', 'jpg', 'jpeg', 'pdf'];

  function getOrCreateUserIdentifier() {
    const key = 'chat_user_identifier';
    const existing = localStorage.getItem(key);
    if (existing) return existing;

    const rand = Math.floor(100000 + Math.random() * 900000);
    const id = `USER${rand}`;
    localStorage.setItem(key, id);
    return id;
  }

  const userIdentifier = getOrCreateUserIdentifier();
  let lastId = 0;
  let pollTimer = null;
  let hasMessages = false;
  let pollInFlight = false;
  let initialHistoryLoaded = false;
  const messageElByKey = new Map();
  let timeRefreshTimer = null;
  let unreadAdminCount = 0;
  let unreadSeparatorEl = null;
  const bufferedAdminMessages = [];
  const ackedClientIdByServerId = new Map();

  const userDisplayName = (function () {
    const key = 'chat_user_display_name';
    const existing = (localStorage.getItem(key) || '').trim();
    if (existing) return existing;
    return 'User';
  })();

  function cacheKey() {
    return `chat_cache_${String(userIdentifier)}`;
  }

  function readMessageCache() {
    try {
      const raw = localStorage.getItem(cacheKey());
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_e) {
      return [];
    }
  }

  function writeMessageCache(items) {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify(items));
    } catch (_e) {
      // ignore quota errors
    }
  }

  function upsertCachedMessage(msg) {
    if (!msg || msg.id === undefined || msg.id === null) return;
    const item = {
      id: msg.id,
      sender: msg.sender,
      admin_name: msg.admin_name || null,
      message: msg.message || '',
      has_file: Boolean(msg.has_file),
      created_at: msg.created_at || null,
    };

    const cache = readMessageCache();
    const idx = cache.findIndex((x) => x && x.id === item.id);
    if (idx >= 0) {
      cache[idx] = item;
    } else {
      cache.push(item);
    }
    cache.sort((a, b) => (a.id || 0) - (b.id || 0));
    const trimmed = cache.slice(Math.max(0, cache.length - 500));
    writeMessageCache(trimmed);
  }

  function hydrateFromCache() {
    const cache = readMessageCache();
    if (!cache || cache.length === 0) return;
    cache.forEach((m) => renderMessage(m, { animate: false }));
    const maxId = cache.reduce((acc, m) => Math.max(acc, m && m.id ? m.id : 0), 0);
    if (maxId > lastId) lastId = maxId;
    initialHistoryLoaded = true;
    scrollToBottom();
  }

  function isPopupOpen() {
    return !popup.classList.contains('hidden');
  }

  function setLauncherLabel() {
    if (!launcherLabelEl) return;
    if (!isPopupOpen() && unreadAdminCount <= 0) {
      launcherLabelEl.textContent = `Hi, ${userDisplayName}!`;
      return;
    }
    launcherLabelEl.textContent = 'Ask us';
  }

  function setUnreadCount(n) {
    unreadAdminCount = Math.max(0, Number(n) || 0);
    if (!launcherBadgeEl) return;
    if (unreadAdminCount <= 0) {
      launcherBadgeEl.classList.add('hidden');
      launcherBadgeEl.textContent = '';
      setLauncherLabel();
      return;
    }
    launcherBadgeEl.classList.remove('hidden');
    launcherBadgeEl.textContent = unreadAdminCount > 99 ? '99+' : String(unreadAdminCount);
    setLauncherLabel();
  }

  function clearUnreadSeparator() {
    if (unreadSeparatorEl && unreadSeparatorEl.parentNode) {
      unreadSeparatorEl.parentNode.removeChild(unreadSeparatorEl);
    }
    unreadSeparatorEl = null;
  }

  function showUnreadSeparatorIfNeeded() {
    clearUnreadSeparator();
    if (unreadAdminCount <= 0) return;

    unreadSeparatorEl = document.createElement('div');
    unreadSeparatorEl.className = 'chat-unread-separator';
    unreadSeparatorEl.textContent = `${unreadAdminCount} new messages`;
    messagesEl.appendChild(unreadSeparatorEl);
  }

  function togglePopup(open) {
    if (open) {
      popup.classList.remove('hidden');
      launcher.classList.add('open');
      textInput.focus();
      // Flush any unread admin messages accumulated while closed
      if (bufferedAdminMessages.length > 0) {
        showUnreadSeparatorIfNeeded();
        bufferedAdminMessages.splice(0).forEach((m) => renderMessage(m, { animate: true }));
        scrollToBottom();
      }

      setUnreadCount(0);
      clearUnreadSeparator();

      setLauncherLabel();

      startPolling();
    } else {
      popup.classList.add('hidden');
      launcher.classList.remove('open');
      // Keep polling so we can maintain unread counts while closed
      setLauncherLabel();
      startPolling();
    }
  }

  launcher.addEventListener('click', function () {
    const isOpen = !popup.classList.contains('hidden');
    togglePopup(!isOpen);
  });

  closeBtn.addEventListener('click', function () {
    togglePopup(false);
  });

  function escapeHtml(s) {
    return (s || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function hideWelcome() {
    if (welcomeEl && !hasMessages) {
      welcomeEl.style.display = 'none';
      hasMessages = true;
    }
  }

  function parseCreatedAt(createdAt) {
    if (!createdAt) return null;

    const raw = String(createdAt);
    // If backend returns GMT/UTC timestamps without timezone, treat as UTC.
    // e.g. "2025-12-27T12:34:56" should be interpreted as UTC, not local.
    const hasTz = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const d = new Date(hasTz ? raw : `${raw}Z`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function formatTimeLabel(createdAt) {
    const d = parseCreatedAt(createdAt);
    if (!d) return '';

    const now = Date.now();
    const diffMs = Math.max(0, now - d.getTime());
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${Math.max(1, diffMin)}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;

    return d.toLocaleString();
  }

  function refreshAllTimeLabels() {
    const els = messagesEl.querySelectorAll('[data-created-at][data-role="chat-time"]');
    els.forEach((el) => {
      const createdAt = el.getAttribute('data-created-at');
      el.textContent = formatTimeLabel(createdAt);
    });
  }

  function startTimeRefresh() {
    if (timeRefreshTimer) return;
    refreshAllTimeLabels();
    timeRefreshTimer = setInterval(refreshAllTimeLabels, 60000);
  }

  function stopTimeRefresh() {
    if (!timeRefreshTimer) return;
    clearInterval(timeRefreshTimer);
    timeRefreshTimer = null;
  }

  function msgKey(msg) {
    if (msg && (msg.id !== undefined && msg.id !== null)) return `id:${String(msg.id)}`;
    if (msg && msg.client_id) return `client:${String(msg.client_id)}`;
    return `hash:${String(msg.sender || '')}:${String(msg.created_at || '')}:${String(msg.message || '')}`;
  }

  function markPendingResolved(clientId, serverId) {
    const key = `client:${String(clientId)}`;
    const el = messageElByKey.get(key);
    if (!el) return;
    el.classList.remove('is-pending');
    if (serverId !== undefined && serverId !== null) {
      el.setAttribute('data-message-id', String(serverId));
    }

    const statusEl = el.querySelector('[data-role="msg-status"]');
    if (statusEl) {
      statusEl.innerHTML = getStatusIconSvg('sent');
    }
  }

  function getStatusIconSvg(kind) {
    if (kind === 'pending') {
      // WhatsApp-like clock
      return `
        <svg class="chat-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Sending">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 7v6l3 2"></path>
        </svg>
      `;
    }
    // double tick
    return `
      <svg class="chat-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Sent">
        <path d="M1 12l5 5L16 7"></path>
        <path d="M8 12l5 5L23 7"></path>
      </svg>
    `;
  }

  function reconcileServerMessageWithPending(serverMsg) {
    if (!serverMsg || serverMsg.id === undefined || serverMsg.id === null) return false;
    const clientId = ackedClientIdByServerId.get(serverMsg.id);
    if (!clientId) return false;

    const pendingKey = `client:${String(clientId)}`;
    const pendingEl = messageElByKey.get(pendingKey);
    if (!pendingEl) return false;

    const idKey = `id:${String(serverMsg.id)}`;
    messageElByKey.delete(pendingKey);
    pendingEl.setAttribute('data-message-key', idKey);
    pendingEl.setAttribute('data-message-id', String(serverMsg.id));
    messageElByKey.set(idKey, pendingEl);

    const timeEl = pendingEl.querySelector('[data-role="chat-time"]');
    if (timeEl && serverMsg.created_at) {
      timeEl.setAttribute('data-created-at', String(serverMsg.created_at));
      timeEl.textContent = formatTimeLabel(serverMsg.created_at);
    }

    pendingEl.classList.remove('is-pending');
    const statusEl = pendingEl.querySelector('[data-role="msg-status"]');
    if (statusEl) {
      statusEl.innerHTML = getStatusIconSvg('sent');
    }

    ackedClientIdByServerId.delete(serverMsg.id);
    return true;
  }

  function reconcileServerMessageWithAnyPendingByContent(serverMsg) {
    if (!serverMsg || serverMsg.sender !== 'user') return false;
    if (serverMsg.id === undefined || serverMsg.id === null) return false;

    const serverText = (serverMsg.message || '').trim();
    if (!serverText) return false;

    const serverCreatedAt = parseCreatedAt(serverMsg.created_at);
    const serverTs = serverCreatedAt ? serverCreatedAt.getTime() : null;

    const pendingEls = messagesEl.querySelectorAll('.chat-row.from-user.is-pending');
    for (const el of pendingEls) {
      const bodyEl = el.querySelector('.chat-body');
      const pendingText = (bodyEl ? bodyEl.textContent : '').trim();
      if (!pendingText) continue;
      if (pendingText !== serverText) continue;

      if (serverTs !== null) {
        const pendingCreatedAt = parseCreatedAt(el.getAttribute('data-created-at'));
        const pendingTs = pendingCreatedAt ? pendingCreatedAt.getTime() : null;
        // If timestamps are far apart, avoid accidental merges
        if (pendingTs !== null && Math.abs(serverTs - pendingTs) > 2 * 60 * 1000) {
          continue;
        }
      }

      const idKey = `id:${String(serverMsg.id)}`;
      const oldKey = el.getAttribute('data-message-key');
      if (oldKey) messageElByKey.delete(oldKey);

      el.setAttribute('data-message-key', idKey);
      el.setAttribute('data-message-id', String(serverMsg.id));
      if (serverMsg.created_at) el.setAttribute('data-created-at', String(serverMsg.created_at));
      messageElByKey.set(idKey, el);

      el.classList.remove('is-pending');

      const timeEl = el.querySelector('[data-role="chat-time"]');
      if (timeEl && serverMsg.created_at) {
        timeEl.setAttribute('data-created-at', String(serverMsg.created_at));
        timeEl.textContent = formatTimeLabel(serverMsg.created_at);
      }

      const statusEl = el.querySelector('[data-role="msg-status"]');
      if (statusEl) {
        statusEl.innerHTML = getStatusIconSvg('sent');
      }

      return true;
    }

    return false;
  }

  function renderMessage(msg, opts) {
    const options = opts || {};
    const key = msgKey(msg);
    if (messageElByKey.has(key)) {
      return;
    }

    hideWelcome();
    
    const row = document.createElement('div');
    row.className = 'chat-row ' + (msg.sender === 'user' ? 'from-user' : 'from-admin');

    row.setAttribute('data-message-key', key);
    if (msg.id !== undefined && msg.id !== null) {
      row.setAttribute('data-message-id', String(msg.id));
    }
    if (msg.client_id) {
      row.setAttribute('data-client-id', String(msg.client_id));
    }
    if (msg.created_at) {
      row.setAttribute('data-created-at', String(msg.created_at));
    }

    if (options.animate && msg.sender === 'admin') {
      row.classList.add('is-new');
    }
    if (options.pending) {
      row.classList.add('is-pending');
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';

    if (msg.sender === 'admin') {
      const rawName = (msg.admin_name && msg.admin_name.trim()) ? msg.admin_name.trim() : '';
      const name = rawName ? (rawName.charAt(0).toUpperCase() + rawName.slice(1)) : '';
      meta.textContent = name ? `Admin • ${name}` : 'Admin';
    } else {
      meta.textContent = 'You';
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'chat-time';
    timeEl.setAttribute('data-role', 'chat-time');
    if (msg.created_at) {
      timeEl.setAttribute('data-created-at', String(msg.created_at));
      timeEl.textContent = formatTimeLabel(msg.created_at);
    }
    meta.appendChild(timeEl);

    if (msg.sender === 'user') {
      const statusEl = document.createElement('span');
      statusEl.className = 'chat-status';
      statusEl.setAttribute('data-role', 'msg-status');
      statusEl.innerHTML = options.pending ? getStatusIconSvg('pending') : getStatusIconSvg('sent');
      meta.appendChild(statusEl);
    }

    const body = document.createElement('div');
    body.className = 'chat-body';
    body.innerHTML = escapeHtml(msg.message);

    bubble.appendChild(meta);
    bubble.appendChild(body);

    // pending indicator is represented by the WhatsApp-like clock in meta

    if (msg.has_file && (msg.id !== undefined && msg.id !== null)) {
      const a = document.createElement('a');
      a.className = 'chat-attachment';
      a.href = `${api_base}/api/messages/${msg.id}/file?user_identifier=${encodeURIComponent(userIdentifier)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Download attachment
      `;
      bubble.appendChild(a);
    }

    row.appendChild(bubble);
    messagesEl.appendChild(row);

    messageElByKey.set(key, row);
    startTimeRefresh();

    if (msg && msg.id !== undefined && msg.id !== null) {
      upsertCachedMessage(msg);
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const url = `${api_base}/api/messages?user_identifier=${encodeURIComponent(userIdentifier)}&after_id=${encodeURIComponent(String(lastId))}`;

      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) return;

      const data = await res.json();
      const msgs = data.messages || [];

      if (msgs.length > 0) {
        const animate = initialHistoryLoaded;
        msgs.forEach((m) => {
          if (!isPopupOpen() && m && m.sender === 'admin') {
            bufferedAdminMessages.push(m);
            upsertCachedMessage(m);
            setUnreadCount(unreadAdminCount + 1);
            return;
          }
          if (m && m.sender === 'user' && reconcileServerMessageWithPending(m)) {
            upsertCachedMessage(m);
            return;
          }
          if (m && m.sender === 'user' && reconcileServerMessageWithAnyPendingByContent(m)) {
            upsertCachedMessage(m);
            return;
          }
          renderMessage(m, { animate });
        });
        lastId = data.last_id || lastId;
        if (isPopupOpen()) {
          scrollToBottom();
        }
      }

      if (!initialHistoryLoaded) {
        initialHistoryLoaded = true;
      }
    } catch (_e) {
      // ignore transient network errors while polling
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    hydrateFromCache();
    setLauncherLabel();
    pollOnce();
    pollTimer = setInterval(pollOnce, 1000);
    startTimeRefresh();
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    stopTimeRefresh();
  }

  function validateFile(file) {
    if (!file) return null;
    const name = file.name || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!allowedExt.includes(ext)) return 'Only .png, .jpg, .jpeg, .pdf files are allowed.';
    return null;
  }

  fileInput.addEventListener('change', function () {
    const f = fileInput.files && fileInput.files[0];
    if (!f) {
      fileHint.textContent = '';
      return;
    }

    const err = validateFile(f);
    if (err) {
      fileHint.textContent = err;
      fileInput.value = '';
      return;
    }

    fileHint.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
      </svg>
      ${f.name}
    `;
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const text = (textInput.value || '').trim();
    const file = fileInput.files && fileInput.files[0];

    const err = validateFile(file);
    if (err) {
      fileHint.textContent = err;
      return;
    }

    if (!text && !file) return;

    // Sending a message marks admin messages as read
    setUnreadCount(0);
    bufferedAdminMessages.splice(0);
    clearUnreadSeparator();
    setLauncherLabel();

    const clientId = `c_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const createdAt = new Date().toISOString();

    // Clear UI immediately
    textInput.value = '';
    fileInput.value = '';
    fileHint.textContent = '';

    renderMessage(
      {
        client_id: clientId,
        sender: 'user',
        admin_name: null,
        message: text || (file ? file.name : ''),
        has_file: Boolean(file),
        created_at: createdAt,
      },
      { pending: true, animate: false }
    );
    scrollToBottom();

    try {
      const fd = new FormData();
      fd.append('user_identifier', userIdentifier);
      fd.append('message', text);
      if (file) fd.append('file', file, file.name);

      const res = await fetch(`${api_base}/api/messages`, {
        method: 'POST',
        body: fd,
      });

      if (!res.ok) {
        return;
      }

      const ack = await res.json().catch(() => ({}));
      if (ack && ack.id !== undefined && ack.id !== null) {
        ackedClientIdByServerId.set(ack.id, clientId);
      }
      markPendingResolved(clientId, ack && ack.id);
      await pollOnce();
    } catch (_e) {
      // keep pending if network fails; polling may resolve later
    }
  });

  // initial label
  setLauncherLabel();

  // Close on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !popup.classList.contains('hidden')) {
      togglePopup(false);
    }
  });
})();
