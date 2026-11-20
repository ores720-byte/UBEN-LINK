// verify-provider: approves, rejects and reissues login codes for provider verification.
// A login code is the provider's password. It is saved to verification_codes so the provider
// sees it on their Profile and the admin can look it up. Creating or reissuing a code changes
// the password, so any older code or password stops working.
//
// Actions:
//   approve, reject, reissue   admin only
//   sync_code                  a verified provider, after they set a new password with the reset email

import { createClient } from 'npm:@supabase/supabase-js@2';

const ADMIN_EMAIL = 'ores720@gmail.com'; // same admin rule as ai-proxy
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// The app runs on a different origin from this function, so browsers need these headers.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';

// A 6-character code that always has a letter, a digit and a symbol
function makeCode(): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let out = '';
    for (const b of bytes) out += CHARS[b % CHARS.length];
    if (/[A-Za-z]/.test(out) && /\d/.test(out) && /[^A-Za-z0-9]/.test(out)) return out;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Background writes that should not fail the request, but should show up in the logs
function logIfError(label: string, error: { message: string } | null) {
  if (error) console.error(label, error.message);
}

// Sets a new code as the password and saves it. Returns the code.
async function issueCode(userId: string, verificationId: string, now: string): Promise<string> {
  const code = makeCode();
  const { error: pwErr } = await admin.auth.admin.updateUserById(userId, { password: code });
  if (pwErr) throw new Error('Could not set the password: ' + pwErr.message);
  const { error } = await admin.from('verification_codes').upsert({
    user_id: userId, verification_id: verificationId, code, issued_at: now,
  });
  if (error) throw new Error('Password changed but the code could not be saved: ' + error.message);
  return code;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: 'Not signed in.' }, 401);

    let body: Record<string, any>;
    try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
    const { action, verification_id, user_id, note, reason, password } = body || {};
    const now = new Date().toISOString();

    // A verified provider has just set a new password. Their login code becomes that password.
    if (action === 'sync_code') {
      const pw = String(password ?? '');
      if (pw.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400);
      const { data: av } = await admin.from('verifications')
        .select('id').eq('user_id', user.id).eq('status', 'approved').maybeSingle();
      if (!av) return json({ error: 'Only verified providers have a login code.' }, 403);
      const { error } = await admin.from('verification_codes').update({ code: pw }).eq('user_id', user.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Everything below is for the admin only
    if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) return json({ error: 'Admin only.' }, 403);

    // Reissue: a verified provider gets a new login code. Their old code and password stop working.
    if (action === 'reissue') {
      if (!user_id) return json({ error: 'Missing provider.' }, 400);
      const { data: av } = await admin.from('verifications')
        .select('id').eq('user_id', user_id).eq('status', 'approved').maybeSingle();
      if (!av) return json({ error: 'This provider is not verified.' }, 404);
      let code: string;
      try { code = await issueCode(user_id, av.id, now); }
      catch (e) { return json({ error: String((e as Error).message || e) }, 500); }

      logIfError('code_requests', (await admin.from('code_requests').update({ handled_at: now })
        .eq('user_id', user_id).is('handled_at', null)).error);
      logIfError('admin_messages', (await admin.from('admin_messages').insert({
        recipient_id: user_id, subject: 'Your login code has changed',
        body: 'The admin issued you a new login code. Your old code and password no longer work. Open Profile to see your new code.',
      })).error);
      logIfError('audit_logs', (await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_reissue', target_id: user_id, detail: null,
      })).error);
      return json({ ok: true, code });
    }

    if (action !== 'approve' && action !== 'reject') return json({ error: 'Unknown action.' }, 400);

    const { data: v } = await admin.from('verifications')
      .select('id, user_id, status, files, submitted_at').eq('id', verification_id).maybeSingle();
    if (!v) return json({ error: 'Submission not found.' }, 404);
    if (v.status !== 'pending') return json({ error: 'Only pending submissions can be decided.' }, 409);

    const documentPath = (v.files && v.files.student_id) || '';
    const submittedAt = v.submitted_at || now;

    if (action === 'reject') {
      if (!reason?.trim()) return json({ error: 'A reason is required.' }, 400);
      const why = reason.trim();

      const { error } = await admin.from('verifications').update({
        status: 'rejected', rejection_reason: why, reviewed_by: user.id, reviewed_at: now,
      }).eq('id', v.id).eq('status', 'pending');
      if (error) return json({ error: error.message }, 500);

      const { error: svErr } = await admin.from('student_verifications').upsert({
        user_id: v.user_id, document_path: documentPath, submitted_at: submittedAt,
        status: 'rejected', review_note: why, reviewed_at: now,
      });
      if (svErr) return json({ error: 'Saved the decision but could not update the ID status: ' + svErr.message }, 500);

      logIfError('admin_messages', (await admin.from('admin_messages').insert({
        recipient_id: v.user_id, subject: 'Verification not approved',
        body: `Your verification was not approved: ${why} Open Profile, fix the form and submit again.`,
      })).error);
      logIfError('audit_logs', (await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_reject', target_id: v.user_id, detail: why,
      })).error);
      return json({ ok: true });
    }

    if (action === 'approve') {
      // Mark the provider approved first. If the code step then fails, the provider is still
      // approved and the admin can use "Issue new code" for them, instead of being left with a
      // changed password and no approval.
      const { error } = await admin.from('verifications').update({
        status: 'approved', rejection_reason: null, reviewed_by: user.id, reviewed_at: now,
      }).eq('id', v.id).eq('status', 'pending');
      if (error) return json({ error: error.message }, 500);

      let code: string;
      try { code = await issueCode(v.user_id, v.id, now); }
      catch (e) {
        return json({
          error: 'Approved, but the login code could not be created. Use "Issue new code" for this provider. ' +
            String((e as Error).message || e),
        }, 500);
      }

      logIfError('code_requests', (await admin.from('code_requests').update({ handled_at: now })
        .eq('user_id', v.user_id).is('handled_at', null)).error);

      const { error: svErr } = await admin.from('student_verifications').upsert({
        user_id: v.user_id, document_path: documentPath, submitted_at: submittedAt,
        status: 'approved', review_note: null, reviewed_at: now,
      });
      if (svErr) return json({ error: 'Approved, but could not update the ID status: ' + svErr.message, code }, 500);

      // Verified tick on listings with an active Pro plan, as the old ID approval did
      logIfError('businesses', (await admin.from('businesses').update({ is_verified: true })
        .eq('owner_id', v.user_id).gt('pro_until', now)).error);

      logIfError('admin_messages', (await admin.from('admin_messages').insert({
        recipient_id: v.user_id, subject: 'Your verification is approved',
        body: 'Your UBEN Link verification is approved. Open Profile to see your login code. That code is now your password, so your old password no longer works.',
      })).error);
      logIfError('audit_logs', (await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_approve', target_id: v.user_id, detail: note || null,
      })).error);
      return json({ ok: true, code });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('verify-provider', e);
    return json({ error: 'Server error. Check the function logs.' }, 500);
  }
});

/*
 * ===================================================================
 * SQL: run once in the Supabase SQL Editor, after the earlier setup.
 * Adds the login-code check and the login-code request functions.
 * ===================================================================

-- Run once in the Supabase SQL Editor.
-- Tells the login page whether an email belongs to an approved provider, so it can ask for the
-- login code instead of a password. Returns only true or false, and never reveals the code.
create or replace function public.is_verified_provider(p_email text)
returns boolean
language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.verifications v on v.user_id = u.id
    join public.verification_codes c on c.user_id = u.id
    where lower(u.email) = lower(trim(p_email))
      and v.status = 'approved'
  );
$$;

grant execute on function public.is_verified_provider(text) to anon, authenticated;

-- Run once in the Supabase SQL Editor. Safe to run again.
-- Lets a verified provider who lost their login code send a request to the admin panel.

create table if not exists public.code_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);

create unique index if not exists code_requests_one_open
  on public.code_requests (user_id) where handled_at is null;

-- Nobody reads or writes this table directly; the functions below do
alter table public.code_requests enable row level security;

-- Called from the login page. Returns a short status the page can show:
--   sent | already_open | too_many | not_verified
drop function if exists public.request_login_code(text);
create or replace function public.request_login_code(p_email text)
returns text
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  select u.id into v_uid
  from auth.users u
  join public.verifications v on v.user_id = u.id
  where lower(u.email) = lower(trim(p_email))
    and v.status = 'approved'
  limit 1;

  if v_uid is null then return 'not_verified'; end if;

  if exists (select 1 from public.code_requests r where r.user_id = v_uid and r.handled_at is null) then
    return 'already_open';
  end if;

  if (select count(*) from public.code_requests r
      where r.user_id = v_uid and r.created_at > now() - interval '1 hour') >= 3 then
    return 'too_many';
  end if;

  insert into public.code_requests (user_id, email) values (v_uid, lower(trim(p_email)));
  return 'sent';
end $$;

grant execute on function public.request_login_code(text) to anon, authenticated;

-- Admin: open requests. Raises an error for non-admins, so the admin page shows the problem
-- instead of an empty list.
drop function if exists public.list_code_requests();
create or replace function public.list_code_requests()
returns table(id uuid, user_id uuid, email text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select r.id, r.user_id, r.email, r.created_at
    from public.code_requests r
    where r.handled_at is null
    order by r.created_at;
end $$;

grant execute on function public.list_code_requests() to authenticated;

-- Admin: close a request without issuing a code
create or replace function public.dismiss_code_request(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.code_requests set handled_at = now() where id = p_id;
end $$;

grant execute on function public.dismiss_code_request(uuid) to authenticated;

-- Lets the admin page update live when a request arrives (skip if already added)
do $$ begin
  alter publication supabase_realtime add table public.code_requests;
exception when duplicate_object then null;
end $$;

*/
