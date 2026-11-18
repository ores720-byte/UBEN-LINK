// ai-admin.js
// Add <script src="ai-admin.js"></script> to admin.html after its main inline script, before </body>.
// Uses globals from admin.html: sb, PAGES, ACTIONS, $, esc, badge, fmt, empty, toast, audit, route.
(function () {
  const call = async (action, extra = {}) => {
    const { data, error } = await sb.functions.invoke('ai-proxy', { body: { action, ...extra } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  };

  // Connection status shown beside each key name
  const pill = (p) => {
    if (p.source === 'none') return badge('Not set', 'bad');
    if (!p.last_status) return badge('Not tested', '');
    if (p.last_status === 'connected') return badge(`Connected · ${p.last_ms} ms`, 'good') + ` <span class="meta">${fmt(p.last_checked)}</span>`;
    return badge('Disconnected', 'bad') + ` <span class="meta">${esc(p.last_error || '')}</span>`;
  };

  const card = (p) => `
    <div class="sec">
      <div class="grow" style="margin-bottom:10px">
        <div class="name">${esc(p.label)} ${pill(p)}</div>
        <div class="meta mono">${p.masked ? esc(p.masked) : 'No key'} · env: ${esc(p.env)}</div>
        <div class="meta">get key: ${esc(p.keyUrl)}</div>
      </div>
      <div class="form">
        <input id="k-${p.id}" type="password" placeholder="Paste API key" autocomplete="off">
        <button class="btn" data-act="ai-save" data-provider="${p.id}">Save</button>
        <button class="btn ghost" data-act="ai-test" data-provider="${p.id}">Test</button>
        ${p.source === 'saved' ? `<button class="btn bad" data-act="ai-save" data-provider="${p.id}" data-clear="1">Remove</button>` : ''}
      </div>
    </div>`;

  PAGES.ai.fn = async function pgAI() {
    const { providers } = await call('status');
    const connected = providers.filter(p => p.last_status === 'connected').length;
    return `
      <div class="sec">
        <div class="row" style="border:0;padding:0">
          <div class="grow">
            <h2>AI providers</h2>
            <p class="sub">${connected} of ${providers.length} connected. The helper tries them top to bottom and moves on if one fails. Keys stay on the server.</p>
          </div>
          <div class="acts"><button class="btn" data-act="ai-test-all">Check all</button></div>
        </div>
      </div>
      ${providers.map(card).join('')}`;
  };

  // Support inbox: chats the bot could not finish
  PAGES.support = { label: 'Support inbox', icon: 'fa-headset', group: 'Overview', fn: pgSupport };

  async function pgSupport() {
    const { items } = await call('support-list');
    return `
      <div class="sec">
        <h2>Support inbox</h2>
        <p class="sub">Chats the helper passed to you. Reply here and the student gets it in Notifications.</p>
        ${items.map(i => `
          <div class="row" style="display:block">
            <div class="name">${esc(i.name)} ${badge(i.reason === 'keyword' ? 'Flagged word' : 'Helper asked', 'warn')}</div>
            <div class="meta">${esc(i.email)} · ${fmt(i.created_at)}</div>
            <div class="meta" style="margin-top:8px;color:var(--ink)">
              ${(i.transcript || []).slice(-6).map(m => `<div><b>${m.role === 'user' ? 'Student' : 'Helper'}:</b> ${esc(m.content)}</div>`).join('')}
            </div>
            <div class="form">
              <input id="r-${i.id}" placeholder="Type your reply">
              <button class="btn" data-act="support-reply" data-id="${i.id}">Send reply</button>
              <button class="btn ghost" data-act="support-close" data-id="${i.id}">Close</button>
            </div>
          </div>`).join('') || empty('No open chats.')}
      </div>`;
  }

  // Shows the number of open chats next to the sidebar link, checked every minute
  async function updateBadge() {
    try {
      const { items } = await call('support-list');
      const a = document.querySelector('[data-nav="support"]');
      if (a) a.innerHTML = `<i class="fa-solid fa-headset"></i>Support inbox${items.length ? ` <span class="badge warn" style="margin-left:auto">${items.length}</span>` : ''}`;
    } catch (_) {}
  }
  setTimeout(updateBadge, 1500);
  setInterval(updateBadge, 60000);

  Object.assign(ACTIONS, {
    async 'ai-save'({ provider, clear }) {
      const key = clear ? '' : ($('k-' + provider).value || '').trim();
      if (!clear && !key) throw new Error('Paste a key first.');
      await call('save', { provider, key });
      await audit('ai.key.' + (clear ? 'remove' : 'save'), provider, clear ? 'Saved key removed' : 'Key replaced');
      toast(clear ? 'Saved key removed.' : 'Key saved. Check it to confirm the connection.');
      route();
    },
    async 'ai-test'({ provider }) {
      toast('Checking...');
      const r = await call('test', { provider });
      toast(r.ok ? `Connected (${r.ms} ms)` : 'Not connected: ' + r.error);
      route();
    },
    async 'ai-test-all'() {
      toast('Checking all providers...');
      const { results } = await call('test-all');
      const ok = results.filter(r => r.ok).length;
      toast(`${ok} of ${results.length} connected.`);
      route();
    },
    async 'support-reply'({ id }) {
      const text = ($('r-' + id).value || '').trim();
      if (!text) throw new Error('Type a reply first.');
      await call('support-reply', { id, text });
      await audit('support.reply', String(id), text.slice(0, 80));
      toast('Reply sent to the student.');
      route();
      updateBadge();
    },
    async 'support-close'({ id }) {
      await call('support-close', { id });
      await audit('support.close', String(id), '');
      toast('Chat closed.');
      route();
      updateBadge();
    }
  });
})();
