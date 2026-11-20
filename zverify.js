// zverify.js: the Get Verified form for providers.
// index.html loads this after ai-chat.js. The form opens at #/verify from the Profile page.
// Uses the main app's globals: sb, state, $, esc, go, toast, ZONE_GROUPS.
(function () {
  const TRADES = ['Electrician', 'Plumber', 'Tailor', 'Phone repair', 'Laptop repair', 'Hair and barbering', 'Laundry',
    'Printing', 'Errands', 'Graphics', 'Food', 'Tutoring', 'Photography', 'Cleaning', 'Events', 'Health', 'Other'];
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const CONTACTS = ['Phone call', 'WhatsApp', 'In-app message'];
  const LOCKED = ['pending', 'approved'];
  const MAX_FILE = 5 * 1024 * 1024;
  const MAX_SAMPLES = 5;

  let row = null;                            // this provider's row in verifications
  let S = { data: {}, files: {} };           // what is in the form and its uploaded files
  let saveTimer = null;

  const digits = s => String(s ?? '').replace(/\D/g, '');
  const isLocked = () => !!row && LOCKED.includes(row.status);
  const v = id => String($(id)?.value ?? '').trim();
  // Writes the provider's row. Existing rows are updated, so the database checks only the
  // rules that apply to changing a row. A missing session is reported as such, not as a database error.
  async function writeRow(fields) {
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) throw new Error('Your session has ended. Sign in again, then save.');
    const q = row
      ? sb.from('verifications').update(fields).eq('user_id', state.user.id).select('id')
      : sb.from('verifications').insert({ user_id: state.user.id, ...fields }).select('id');
    const { data, error } = await q;
    if (error) {
      if (/row-level security/i.test(error.message))
        throw new Error('Could not save. Refresh the page and try again. If it keeps happening, sign out and back in.');
      throw error;
    }
    if (!data || !data.length) throw new Error('This form can no longer be changed. Refresh the page to see its status.');
  }

  const when = ts => ts ? new Date(ts).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  async function loadRow() {
    const { data, error } = await sb.from('verifications').select('*').eq('user_id', state.user.id).maybeSingle();
    if (error) throw error;
    row = data || null;
    S = {
      data: row?.form_data && Object.keys(row.form_data).length
        ? row.form_data
        : { full_name: state.profile?.full_name || '', email: state.user.email || '' },
      files: row?.files || {},
    };
  }

  // ---------- Reading the form ----------
  function collect() {
    const trade = v('vTrade');
    const start = v('vStart'), end = v('vEnd');
    const references = [1, 2, 3]
      .map(n => ({ name: v('vRef' + n + 'Name'), phone: v('vRef' + n + 'Phone'), relationship: v('vRef' + n + 'Rel') }))
      .filter(r => r.name || r.phone || r.relationship);
    return {
      full_name: v('vName'), phone: v('vPhone'), email: v('vEmail'),
      trade, trade_other: trade === 'Other' ? v('vTradeOther') : '',
      years: v('vYears') === '' ? null : Number(v('vYears')),
      description: v('vDesc'), zone: v('vZone'), address: v('vAddress'),
      contact_method: document.querySelector('input[name="vContact"]:checked')?.value || '',
      working_days: [...document.querySelectorAll('.vDay:checked')].map(x => x.value),
      work_start: start, work_end: end,
      working_hours: start && end ? `${start} to ${end}` : '',
      references,
      agreed: !!$('vAgree')?.checked,
    };
  }

  function problems(d, f) {
    const p = [];
    if (d.full_name.length < 2) p.push('Enter your full name.');
    if (!/^0\d{10}$/.test(digits(d.phone))) p.push('Enter an 11-digit phone number that starts with 0.');
    if (!/^\S+@\S+\.\S+$/.test(d.email)) p.push('Enter a valid email address.');
    if (!f.profile_photo) p.push('Upload a clear profile photo.');
    if (!f.student_id) p.push('Upload a photo or PDF of your UNIBEN student ID.');
    if (!f.selfie) p.push('Take a selfie to match your student ID.');
    if (!d.trade) p.push('Choose your trade.');
    if (d.trade === 'Other' && !d.trade_other) p.push('Describe your trade.');
    if (d.years === null || d.years < 0 || d.years > 50) p.push('Years of experience must be between 0 and 50.');
    if (d.description.length < 20 || d.description.length > 300) p.push('The short description must be 20 to 300 characters.');
    if (!(f.samples || []).length) p.push('Add at least one photo of your past work.');
    if (!d.zone) p.push('Choose your campus zone or area.');
    if (!d.contact_method) p.push('Choose a preferred contact method.');
    if (!d.working_days.length) p.push('Choose at least one working day.');
    if (!d.work_start || !d.work_end || d.work_end <= d.work_start) p.push('Working hours must end after they start.');
    if (!d.references.length) p.push('Add at least one reference.');
    d.references.forEach((r, i) => {
      if (!r.name || !/^0\d{10}$/.test(digits(r.phone))) p.push(`Reference ${i + 1}: add a name and an 11-digit phone number.`);
    });
    if (!d.agreed) p.push('Tick the box to confirm your information is true and you accept the rules.');
    return p;
  }

  // ---------- Saving ----------
  let saveChain = Promise.resolve();
  function saveDraft(manual) {
    saveChain = saveChain.then(() => doSaveDraft(manual)).catch(() => {});
    return saveChain;
  }

  async function doSaveDraft(manual) {
    if (isLocked()) return;
    S.data = collect();
    try {
      await writeRow({ status: 'draft', form_data: S.data, files: S.files, updated_at: new Date().toISOString() });
    } catch (err) {
      return toast(err.message);
    }
    row = { ...(row || {}), status: 'draft' };
    const saved = $('vSaved');
    if (saved) saved.textContent = 'Saved ' + new Date().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
    if (manual) toast('Draft saved.');
  }

  function scheduleSave(e) {
    if (e.target.type === 'file' || isLocked()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(false).catch(() => {}), 1500);
  }

  // ---------- Uploads ----------
  async function uploadFile(bucket, field, file) {
    if (file.size > MAX_FILE) throw new Error('That file is over 5 MB. Choose a smaller one.');
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `${state.user.id}/${field}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false,
    });
    if (error) throw error;
    return path;
  }

  async function onFile(e) {
    const input = e.target, field = input.dataset.file, picked = [...input.files];
    input.value = '';
    if (!picked.length || isLocked()) return;
    try {
      toast('Uploading...');
      S.data = collect();                    // keep typed answers
      if (field === 'samples') {
        const current = S.files.samples || [];
        const room = MAX_SAMPLES - current.length;
        if (room <= 0) return toast(`You can add up to ${MAX_SAMPLES} sample photos.`);
        const added = [];
        for (const f of picked.slice(0, room)) added.push(await uploadFile('verification-files', 'sample', f));
        S.files.samples = [...current, ...added];
      } else {
        // The student ID goes in the same bucket the Profile page and the old admin view already use
        const bucket = field === 'student_id' ? 'student-ids' : 'verification-files';
        S.files[field] = await uploadFile(bucket, field, picked[0]);
      }
      await saveDraft(false);
      await window.renderVerify();
      toast('Uploaded.');
    } catch (err) {
      toast(err.message || 'Upload failed.');
    }
  }

  async function removeSample(i) {
    if (isLocked()) return;
    S.data = collect();
    S.files.samples = (S.files.samples || []).filter((_, n) => n !== i);
    await saveDraft(false);
    await window.renderVerify();
  }

  // ---------- Submit ----------
  async function submit(e) {
    e.preventDefault();
    await saveChain;
    if (isLocked()) return;
    const d = collect();
    const box = $('vErrors');
    const p = problems(d, S.files);
    if (p.length) {
      box.innerHTML = `<div class="card p-4 border border-red-200 bg-red-50 text-sm text-red-700">
        <b>Please fix these before submitting:</b>
        <ul class="list-disc pl-5 mt-2 space-y-1">${p.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    box.innerHTML = '';
    S.data = d;
    const now = new Date().toISOString();
    const btn = $('vSubmit');
    btn.disabled = true;
    try {
      if (!row) {                            // new rows can only be created as drafts
        await writeRow({ status: 'draft', form_data: d, files: S.files, updated_at: now });
        row = { status: 'draft' };
      }
      await writeRow({ status: 'pending', form_data: d, files: S.files, submitted_at: now, updated_at: now });
      // Keep the Profile's ID status and the listing check in step with this form
      const { error: svErr } = await sb.from('student_verifications').upsert({
        user_id: state.user.id, document_path: S.files.student_id, submitted_at: now,
        status: 'pending', review_note: null, reviewed_at: null,
      });
      if (svErr) throw svErr;
      toast('Submitted. The admin will review it.');
      await window.renderVerify();
    } catch (err) {
      toast(err.message || 'Could not submit.');
      btn.disabled = false;
    }
  }

  // ---------- Drawing the page ----------
  const card = (icon, title, sub, body) => `
    <section class="card p-6">
      <div class="flex items-start gap-3 mb-4">
        <span class="w-9 h-9 rounded-xl bg-maroon/10 text-maroon flex items-center justify-center shrink-0"><i class="fa-solid ${icon}"></i></span>
        <div><h2 class="font-bold">${title}</h2><p class="text-sm text-gray-500">${sub}</p></div>
      </div>
      <div class="space-y-4">${body}</div>
    </section>`;

  const lbl = (id, text, req = true) => `<label class="lbl" for="${id}">${text}${req ? ' <span class="text-maroon">*</span>' : ''}</label>`;

  const fileBox = (field, title, hint, accept, extra = '') => {
    const has = !!S.files[field];
    return `
      <div>
        <div class="lbl">${title} <span class="text-maroon">*</span></div>
        <p class="text-xs text-gray-500 mb-2">${hint}</p>
        <div class="text-xs mb-2 ${has ? 'text-emerald-700' : 'text-gray-500'}">${has ? '<i class="fa-solid fa-check"></i> Uploaded' : 'Not uploaded yet'}</div>
        <label for="f_${field}" class="btn-ghost w-full cursor-pointer"><i class="fa-solid fa-upload"></i> ${has ? 'Replace' : 'Choose'} file</label>
        <input id="f_${field}" data-file="${field}" type="file" accept="${accept}" ${extra} class="hide">
      </div>`;
  };

  const samplesBox = () => {
    const list = S.files.samples || [];
    const items = list.map((_, i) => `
      <div class="flex items-center justify-between gap-3 text-sm bg-gray-50 rounded-xl px-3 py-2">
        <span>Photo ${i + 1}</span>
        <button type="button" data-remove-sample="${i}" class="text-red-600 text-xs font-semibold">Remove</button>
      </div>`).join('');
    return `
      <div>
        <div class="lbl">Photos of past work <span class="text-maroon">*</span></div>
        <p class="text-xs text-gray-500 mb-2">1 to ${MAX_SAMPLES} photos of work you have done.</p>
        <div class="space-y-2 mb-2">${items}</div>
        ${list.length < MAX_SAMPLES
          ? `<label for="f_samples" class="btn-ghost w-full cursor-pointer"><i class="fa-solid fa-images"></i> Add photos</label>
             <input id="f_samples" data-file="samples" type="file" accept="image/*" multiple class="hide">`
          : ''}
      </div>`;
  };

  function bannerHtml() {
    if (!row) return '';
    const note = (cls, icon, text) => `<div class="card p-4 mb-4 border ${cls}"><div class="flex gap-3 text-sm"><i class="fa-solid ${icon} mt-0.5"></i><div>${text}</div></div></div>`;
    if (row.status === 'pending') return note('border-amber-200 bg-amber-50 text-amber-800', 'fa-hourglass-half',
      `<b>Under review.</b> Submitted ${when(row.submitted_at)}. You cannot change the form until the admin has decided.`);
    if (row.status === 'approved') return note('border-emerald-200 bg-emerald-50 text-emerald-800', 'fa-circle-check',
      '<b>Verified.</b> The admin approved your details. Open Profile to see your login code.');
    if (row.status === 'rejected') return note('border-red-200 bg-red-50 text-red-700', 'fa-circle-xmark',
      `<b>Not approved.</b> ${esc(row.rejection_reason || 'Please check the form.')} Fix it below and submit again.`);
    if (row.rejection_reason) return note('border-red-200 bg-red-50 text-red-700', 'fa-circle-info',
      `<b>Your last submission was not approved.</b> ${esc(row.rejection_reason)}`);
    return '';
  }

  window.renderVerify = async function () {
    const view = $('view');
    view.innerHTML = '<div class="skeleton h-28"></div>';
    try { await loadRow(); }
    catch (e) { view.innerHTML = `<div class="card p-6 text-red-600">${esc(e.message)}</div>`; return; }

    const d = S.data;
    const val = k => esc(d[k] ?? '');
    const sel = (k, opt) => d[k] === opt ? 'selected' : '';
    const chk = (k, opt) => (d[k] || []).includes(opt) ? 'checked' : '';
    const ref = n => (d.references || [])[n - 1] || {};
    const zoneOptions = ZONE_GROUPS.map(g => `<optgroup label="${esc(g.label)}">${g.zones.map(z =>
      `<option value="${esc(z)}" ${sel('zone', z)}>${esc(z)}</option>`).join('')}</optgroup>`).join('');
    const refBlock = n => {
      const r = ref(n), req = n === 1;
      return `<div class="rounded-xl border border-gray-100 p-3 space-y-2">
        <div class="text-xs font-semibold text-gray-600">Reference ${n}${req ? ' <span class="text-maroon">*</span>' : ' (optional)'}</div>
        <input id="vRef${n}Name" class="input" maxlength="60" placeholder="Full name" value="${esc(r.name || '')}">
        <input id="vRef${n}Phone" class="input" inputmode="tel" maxlength="11" placeholder="Phone, e.g. 08012345678" value="${esc(r.phone || '')}">
        <input id="vRef${n}Rel" class="input" maxlength="60" placeholder="Relationship, e.g. student I served" value="${esc(r.relationship || '')}">
      </div>`;
    };

    view.innerHTML = `
      <div class="fade-in max-w-2xl mx-auto">
        <button type="button" id="vBack" class="btn-ghost mb-4"><i class="fa-solid fa-arrow-left"></i> Back to profile</button>
        <h1 class="text-2xl font-bold mb-1">Get verified</h1>
        <p class="text-sm text-gray-500 mb-4">Fill in every field marked <span class="text-maroon">*</span>. You can save a draft and finish later. Only the UBEN Link admin sees these details.</p>
        ${bannerHtml()}
        <form id="vForm" class="space-y-4" novalidate>
          ${card('fa-user', 'Your details', 'Your contact information.', [
            `<div>${lbl('vName', 'Full name')}<input id="vName" class="input" maxlength="60" value="${val('full_name')}"></div>`,
            `<div>${lbl('vPhone', 'Phone number')}<input id="vPhone" class="input" inputmode="tel" maxlength="11" placeholder="08012345678" value="${val('phone')}"></div>`,
            `<div>${lbl('vEmail', 'Email')}<input id="vEmail" type="email" class="input" maxlength="120" value="${val('email')}"></div>`,
            fileBox('profile_photo', 'Profile photo', 'A clear, recent photo of your face. JPG, PNG or WebP, up to 5 MB.', 'image/*'),
          ].join(''))}

          ${card('fa-id-badge', 'Student ID and selfie', 'We check that the selfie matches your ID.', [
            fileBox('student_id', 'UNIBEN student ID', 'A clear photo or PDF of your student ID, up to 5 MB.', 'image/*,application/pdf'),
            fileBox('selfie', 'Selfie', 'Take a selfie now, holding your ID next to your face if you can.', 'image/*', 'capture="user"'),
          ].join(''))}

          ${card('fa-screwdriver-wrench', 'Your services', 'What you do and the work you have done.', [
            `<div>${lbl('vTrade', 'Trade')}<select id="vTrade" class="input"><option value="">Choose one</option>${TRADES.map(t =>
              `<option value="${esc(t)}" ${sel('trade', t)}>${esc(t)}</option>`).join('')}</select></div>`,
            `<div id="vTradeOtherWrap" class="${d.trade === 'Other' ? '' : 'hide'}">${lbl('vTradeOther', 'Describe your trade')}<input id="vTradeOther" class="input" maxlength="60" value="${val('trade_other')}"></div>`,
            `<div>${lbl('vYears', 'Years of experience')}<input id="vYears" type="number" min="0" max="50" class="input" value="${d.years ?? ''}"></div>`,
            `<div>${lbl('vDesc', 'Short description')}<textarea id="vDesc" rows="4" maxlength="300" class="input" placeholder="What you offer, in 20 to 300 characters">${val('description')}</textarea></div>`,
            samplesBox(),
          ].join(''))}

          ${card('fa-location-dot', 'Location', 'Where students can find you.', [
            `<div>${lbl('vZone', 'Campus zone or area')}<select id="vZone" class="input"><option value="">Choose one</option>${zoneOptions}</select></div>`,
            `<div>${lbl('vAddress', 'Home or workshop address (optional)', false)}<input id="vAddress" class="input" maxlength="160" value="${val('address')}"><p class="text-xs text-gray-500 mt-1">Used only for distance. Not shown to students.</p></div>`,
          ].join(''))}

          ${card('fa-clock', 'Contact and availability', 'How and when students can reach you.', [
            `<div><div class="lbl">Preferred contact method <span class="text-maroon">*</span></div><div class="flex flex-wrap gap-4 text-sm">${CONTACTS.map(c =>
              `<label class="flex items-center gap-2"><input type="radio" name="vContact" value="${c}" ${d.contact_method === c ? 'checked' : ''}> ${c}</label>`).join('')}</div></div>`,
            `<div><div class="lbl">Working days <span class="text-maroon">*</span></div><div class="flex flex-wrap gap-3 text-sm">${DAYS.map(x =>
              `<label class="flex items-center gap-2"><input type="checkbox" class="vDay" value="${x}" ${chk('working_days', x)}> ${x}</label>`).join('')}</div></div>`,
            `<div class="grid grid-cols-2 gap-3">
              <div>${lbl('vStart', 'Start time')}<input id="vStart" type="time" class="input" value="${val('work_start')}"></div>
              <div>${lbl('vEnd', 'End time')}<input id="vEnd" type="time" class="input" value="${val('work_end')}"></div>
            </div>`,
          ].join(''))}

          ${card('fa-people-group', 'References', 'At least one person who can vouch for you.', [
            refBlock(1), refBlock(2), refBlock(3),
          ].join(''))}

          ${card('fa-file-signature', 'Agreement', 'Please read before you submit.', `
            <label class="flex items-start gap-3 text-sm">
              <input id="vAgree" type="checkbox" class="w-5 h-5 accent-maroon mt-0.5" ${d.agreed ? 'checked' : ''}>
              <span>I confirm the information I have given is true, and I accept the UBEN Link rules. I understand that my details are checked before I am verified.</span>
            </label>`)}

          <div id="vErrors"></div>
          <div class="flex flex-col sm:flex-row gap-3 items-center">
            <span id="vSaved" class="text-xs text-gray-500 sm:mr-auto">${row?.updated_at ? 'Saved ' + when(row.updated_at) : ''}</span>
            <button type="button" id="vSave" class="btn-ghost">Save draft</button>
            <button type="submit" id="vSubmit" class="btn">Submit for review</button>
          </div>
        </form>
      </div>`;

    const formEl = $('vForm');
    if (isLocked()) formEl.querySelectorAll('input, select, textarea, button').forEach(el => { el.disabled = true; });
    $('vBack').onclick = () => go('profile');
    $('vSave')?.addEventListener('click', () => saveDraft(true));
    formEl.addEventListener('input', scheduleSave);
    formEl.addEventListener('change', e => {
      if (e.target.id === 'vTrade') $('vTradeOtherWrap').classList.toggle('hide', e.target.value !== 'Other');
      scheduleSave(e);
    });
    formEl.querySelectorAll('[data-file]').forEach(el => el.addEventListener('change', onFile));
    formEl.addEventListener('click', e => {
      const b = e.target.closest('[data-remove-sample]');
      if (b) removeSample(Number(b.dataset.removeSample));
    });
    formEl.addEventListener('submit', submit);
    window.scrollTo(0, 0);
  };
})();
