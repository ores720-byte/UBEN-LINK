// ai-chat.js: the UBEN Link AI Assistant page.
// index.html loads this after its main script. The page opens at #/assistant from the menu.
// Uses the main app's globals: sb, state, $, esc, go, hasProAccount.
(function () {
  const STYLE = `
    .ua-b{animation:uaIn .3s ease both;max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
    .ua-u{align-self:flex-end;background:#4b1049;color:#fff;border-bottom-right-radius:4px}
    .ua-a{align-self:flex-start;background:#fff;color:#111827;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(17,24,39,.06)}
    .ua-card{display:flex;flex-direction:column;gap:8px}
    .ua-btns{display:flex;gap:8px}
    .ua-btns button{border:1px solid #4b1049;border-radius:10px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;background:#4b1049;color:#fff}
    .ua-btns .ua-no{background:#fff;color:#4b1049}
    .ua-note{align-self:center;font-size:12px;color:#6d28d9;background:#f1e9fd;border-radius:999px;padding:4px 12px;text-align:center}
    #uaMsgs{display:flex;flex-direction:column;gap:8px;min-height:260px;max-height:58vh;overflow-y:auto;padding:14px;background:#f6eef5;border-radius:18px}
    html.dark #uaMsgs{background:#14171d}
    html.dark .ua-a{background:#20242d;color:#e5e7eb}
    html.dark .ua-btns .ua-no{background:#1a1d24;color:#d1d5db}
    html.dark .ua-note{background:#2a2140;color:#c4b5fd}
    .uw-dots{display:inline-flex;gap:4px;align-items:center;vertical-align:middle}
    .uw-dots i{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;animation:uwDot 1.2s infinite ease-in-out}
    .uw-dots i:nth-child(2){animation-delay:.15s}
    .uw-dots i:nth-child(3){animation-delay:.3s}
    @keyframes uwDot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-4px)}}
    @keyframes uaIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  `;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const CHIPS = {
    free: ['How do I find a service?', 'How do I list my service?', 'What is Pro?'],
    pro: ['Book a service', 'Show my bookings', 'Pin my listing this month'],
  };
  const LABEL = { pending: 'Proposed: ', running: 'Working on: ', done: '✓ ', failed: '✕ ', cancelled: 'Cancelled: ' };
  const WELCOME_FREE = 'Hi! I can answer questions about UBEN Link, help you find a service, or explain the plans. Pro listings can also let me act for them, such as booking, editing and pinning. I will pass anything I cannot handle to the UBEN Link team.';
  const WELCOME_PRO = 'Hi! I can answer questions about UBEN Link. Because you have a Pro listing, I can also act for you: book a service, handle booking requests, edit your listing, add a price, or pin it. I always ask you to press Confirm first.';

  const isPro = () => typeof hasProAccount === 'function' && hasProAccount();

  // The conversation is kept while the app stays open, and is reset when a different person logs in
  let store = null; // { uid, entries, busy }
  function getStore() {
    const uid = state.user && state.user.id;
    if (!store || store.uid !== uid) store = { uid, entries: [], busy: false };
    if (!store.entries.length) store.entries.push({ role: 'assistant', text: isPro() ? WELCOME_PRO : WELCOME_FREE });
    return store;
  }

  function shell(pro) {
    const chips = pro ? CHIPS.pro : CHIPS.free;
    return `
      <div class="fade-in max-w-2xl mx-auto space-y-4">
        <div class="card p-5 flex items-center gap-4">
          <div class="tile-icon flex-shrink-0"><i class="fa-solid fa-robot"></i></div>
          <div class="min-w-0 flex-1">
            <h1 class="text-xl font-bold leading-tight">UBEN Link AI Assistant</h1>
            <p class="text-sm text-gray-500">${pro ? 'Pro: can act for you. It always asks you to confirm first.' : 'Free plan: answers questions. Pro listings can also let it act for them.'}</p>
          </div>
        </div>
        <div id="uaChips" class="flex gap-2 overflow-x-auto scroll-x">
          ${chips.map((c) => `<button type="button" class="chip" data-q="${esc(c)}">${esc(c)}</button>`).join('')}
        </div>
        <div id="uaMsgs"></div>
        <form id="uaForm" class="flex gap-2 items-center">
          <input id="uaInput" class="input !rounded-full" maxlength="600" placeholder="Ask about services, listings or plans" autocomplete="off">
          <button class="btn !rounded-full w-12 h-12 p-0 flex-shrink-0" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button>
        </form>
        <p class="text-xs text-gray-400 text-center">The assistant never takes payment. Plans are paid by bank transfer on the Subscription page.</p>
      </div>`;
  }

  function entryHTML(e, i) {
    if (e.wait) return '<div class="ua-b ua-a"><span class="uw-dots"><i></i><i></i><i></i></span></div>';
    if (e.role === 'note') return `<div class="ua-note">${esc(e.text)}</div>`;
    if (e.role === 'proposal') {
      const btns = e.state === 'pending'
        ? `<div class="ua-btns"><button type="button" data-ua="ok" data-i="${i}">Confirm</button><button type="button" class="ua-no" data-ua="no" data-i="${i}">Not now</button></div>`
        : '';
      return `<div class="ua-b ua-a ua-card"><div>${LABEL[e.state] || ''}${esc(e.summary)}</div>${btns}</div>`;
    }
    return `<div class="ua-b ${e.role === 'user' ? 'ua-u' : 'ua-a'}">${esc(e.text)}</div>`;
  }

  function paint() {
    const box = $('uaMsgs');
    if (!box || !store) return; // the admin has moved to another screen
    box.innerHTML = store.entries.map(entryHTML).join('');
    box.scrollTop = box.scrollHeight;
  }

  // Confirm or Not now on a proposed action
  async function onAction(e) {
    const b = e.target.closest('[data-ua]');
    if (!b || !store) return;
    const entry = store.entries[Number(b.dataset.i)];
    if (!entry || entry.role !== 'proposal' || entry.state !== 'pending') return;
    if (b.dataset.ua === 'no') {
      entry.state = 'cancelled';
      paint();
      sb.functions.invoke('ai-proxy', { body: { action: 'cancel-action', id: entry.id } });
      return;
    }
    entry.state = 'running';
    paint();
    const { data, error } = await sb.functions.invoke('ai-proxy', { body: { action: 'confirm', id: entry.id } });
    const ok = !error && !!(data && data.ok);
    entry.state = ok ? 'done' : 'failed';
    store.entries.push({ role: 'note', text: ok ? data.message : ((data && data.error) || 'Could not do that. Please try again.') });
    paint();
  }

  async function ask(text) {
    text = (text || '').trim();
    if (!text || !store || store.busy) return;
    const input = $('uaInput');
    if (input) input.value = '';

    const userEntry = { role: 'user', text };
    const waiting = { role: 'assistant', text: '…', wait: true };
    store.entries.push(userEntry, waiting);
    store.busy = true;
    paint();

    // Send the conversation so far. The model needs the first message to come from the user.
    const messages = store.entries
      .filter((x) => (x.role === 'user' || x.role === 'assistant') && !x.wait)
      .slice(-12)
      .map((x) => ({ role: x.role, content: x.text }));
    while (messages.length && messages[0].role === 'assistant') messages.shift();

    try {
      const { data, error } = await sb.functions.invoke('ai-proxy', { body: { action: 'chat', messages } });
      if (error) {
        let m = error.message;
        try { m = (await error.context.json()).error || m; } catch (_) {}
        throw new Error(m);
      }
      if (data && data.error) throw new Error(data.error);
      Object.assign(waiting, { text: data.reply || 'Here is what I can do:', wait: false });
      if (data.escalated) store.entries.push({ role: 'note', text: 'Passed to the UBEN Link team. Their reply will appear in Notifications.' });
      if (data.proposal) store.entries.push({ role: 'proposal', id: data.proposal.id, summary: data.proposal.summary, state: 'pending' });
      if (data.navigate) go(data.navigate);
    } catch (_) {
      // Remove the question as well, so the person can simply send it again
      store.entries = store.entries.filter((x) => x !== userEntry && x !== waiting);
      store.entries.push({ role: 'note', text: 'The assistant is unavailable right now. Please try again shortly.' });
    } finally {
      store.busy = false;
      paint();
    }
  }

  // Called by index.html when the menu opens #/assistant
  function renderAssistant() {
    if (!state.user) return;
    getStore();
    $('view').innerHTML = shell(isPro());
    paint();
    $('uaMsgs').onclick = onAction;
    $('uaChips').onclick = (e) => {
      const b = e.target.closest('[data-q]');
      if (b) ask(b.dataset.q);
    };
    $('uaForm').onsubmit = (e) => {
      e.preventDefault();
      ask($('uaInput').value);
    };
  }
  window.renderAssistant = renderAssistant;

  // Three moving dots, used by the messages screen while a draft is being written
  window.uwTypingDots = () => '<span class="uw-dots"><i></i><i></i><i></i></span>';

  // Messages screen: the AI writes a draft that the person reads, edits and sends themselves
  window.uwDraft = async function (btn, ctx) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const label = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Writing ' + window.uwTypingDots();
    try {
      const messages = [
        { role: 'user', content: 'Recent chat with ' + ctx.to + ':\n' + (ctx.recent || '(no messages yet)') },
        { role: 'user', content: 'Write one short, polite message I can send to ' + ctx.to + ' on UBEN Link. Their services: ' + (ctx.services || 'not listed') + '. Write only the message text, with no quotes and no explanation, under 280 characters.' },
      ];
      const { data, error } = await sb.functions.invoke('ai-proxy', { body: { action: 'chat', messages } });
      if (error || !data || !data.reply) throw new Error('no reply');
      ctx.input.value = data.reply.replace(/^["']+|["']+$/g, '').trim().slice(0, 280);
      ctx.input.focus();
    } catch (_) {
      toast('The AI could not write a draft right now. Please try again shortly.');
    } finally {
      btn.innerHTML = label;
      delete btn.dataset.busy;
    }
  };
})();
