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

    if (!['approve', 'reject', 'revoke'].includes(action)) return json({ error: 'Unknown action.' }, 400);

    const { data: v } = await admin.from('verifications')
      .select('id, user_id, status, files, submitted_at').eq('id', verification_id).maybeSingle();
    if (!v) return json({ error: 'Submission not found.' }, 404);
    if (action === 'revoke') {
      const why = String(reason ?? '').trim();
      if (why.length < 5) return json({ error: 'Write a short reason (at least 5 characters).' }, 400);
      if (v.status !== 'approved') return json({ error: 'Only an approved verification can be removed.' }, 409);

      // 1. Replace the password first, so if this fails nothing else has changed.
      //    The old password cannot be restored (only a hash is stored), so a random one is set.
      //    The provider signs in again with "Forgot password".
      const randomPw = Array.from(crypto.getRandomValues(new Uint8Array(24)), b => CHARS[b % CHARS.length]).join('');
      const { error: pwErr } = await admin.auth.admin.updateUserById(v.user_id, { password: randomPw });
      if (pwErr) return json({ error: 'Could not change the password: ' + pwErr.message }, 500);

      // 2. Unverify the account, and remove the login code so it cannot be used
      const { error } = await admin.from('verifications').update({
        status: 'rejected', rejection_reason: why, reviewed_by: user.id, reviewed_at: now,
      }).eq('id', v.id).eq('status', 'approved');
      if (error) return json({ error: error.message }, 500);

      logIfError('verification_codes', (await admin.from('verification_codes').delete().eq('user_id', v.user_id)).error);
      logIfError('businesses', (await admin.from('businesses').update({ is_verified: false }).eq('owner_id', v.user_id)).error);
      logIfError('student_verifications', (await admin.from('student_verifications').update({
        status: 'rejected', review_note: why, reviewed_at: now,
      }).eq('user_id', v.user_id)).error);
      logIfError('code_requests', (await admin.from('code_requests').update({ handled_at: now })
        .eq('user_id', v.user_id).is('handled_at', null)).error);

      logIfError('admin_messages', (await admin.from('admin_messages').insert({
        recipient_id: v.user_id, subject: 'Your verification was removed',
        body: `Your verification was removed: ${why} Your login code no longer works. Use "Forgot password" on the login page to set a new password, then fix your form and submit it again.`,
      })).error);
      logIfError('audit_logs', (await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_revoke', target_id: v.user_id, detail: why,
      })).error);
      return json({ ok: true });
    }

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
 * Adds the login-code check and login-code requests.
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


-- Providers cannot approve or reject their own verification. Only the admin
-- (signed in as admin) or the verify-provider function (service role) can change those statuses.
create or replace function public.guard_verification_status()
returns trigger
language plpgsql security definer set search_path = public, auth
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'rejected')
     and coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and not public.is_admin() then
    raise exception 'Only the admin can approve or reject a verification.';
  end if;
  return new;
end $$;

drop trigger if exists guard_verification_status on public.verifications;
create trigger guard_verification_status
  before update on public.verifications
  for each row execute function public.guard_verification_status();

drop trigger if exists guard_student_status on public.student_verifications;
create trigger guard_student_status
  before update on public.student_verifications
  for each row execute function public.guard_verification_status();

-- ============ Remove the  (no longer used) ============
drop function if exists public.admin_list_slots();
drop function if exists public.admin_list_checkins();
drop function if exists public.admin_create_slot(text, text, timestamptz, int);
drop function if exists public.admin_set_checkin(uuid, text);
drop function if exists public.my_path();
drop function if exists public.list_checkin_slots();
drop function if exists public.book_checkin(uuid);
drop function if exists public.my_checkin();
drop function if exists public.cancel_checkin();
drop table if exists public.checkins;
drop table if exists public.checkin_slots;

-- ============ Reference contacts (step 3) ============
-- The references a provider gives on their form. Admins read them when an account is reported.

-- Remove the earlier vouch feature if it was ever run
drop function if exists public.list_vouchable();
drop function if exists public.request_vouch(uuid);
drop function if exists public.my_vouches();
drop function if exists public.vouch_requests_for_me();
drop function if exists public.respond_vouch(uuid, boolean);
drop function if exists public.admin_vouch_summary();
drop table if exists public.vouches;

-- Admin: the reference for a provider who has been reported
create or replace function public.admin_provider_reference(p_user uuid)
returns table(name text, phone text, relation text)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select coalesce(r->>'name', ''), coalesce(r->>'phone', ''), coalesce(r->>'relationship', '')
    from public.verifications v,
         jsonb_array_elements(coalesce((v.form_data->'references')::jsonb, '[]'::jsonb)) r
    where v.user_id = p_user;
end $$;

grant execute on function public.admin_provider_reference(uuid) to authenticated;

-- ============ Verification upkeep: duplicates, re-verification, suspension ============

-- Suspension fields sit beside the existing ban fields
alter table public.provider_admin add column if not exists suspended_until date;
alter table public.provider_admin add column if not exists suspend_reason text;
alter table public.provider_admin add column if not exists suspended_listing_ids uuid[] not null default '{}';

-- Only the admin, the server, or a scheduled job can change suspension fields
create or replace function public.guard_suspension()
returns trigger
language plpgsql security definer set search_path = public, auth
as $$
begin
  if (new.suspended_until is distinct from old.suspended_until
      or new.suspend_reason is distinct from old.suspend_reason)
     and coalesce(auth.role(), '') <> 'service_role'
     and session_user <> 'postgres'
     and not public.is_admin() then
    raise exception 'Only the admin can suspend or lift a suspension.';
  end if;
  return new;
end $$;

drop trigger if exists guard_suspension on public.provider_admin;
create trigger guard_suspension
  before update on public.provider_admin
  for each row execute function public.guard_suspension();

-- Approval sets the re-verification date to 3 months later
create or replace function public.set_reverify_due()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    insert into public.provider_admin (user_id, reverify_due)
    values (new.user_id, current_date + interval '3 months')
    on conflict (user_id) do update set reverify_due = excluded.reverify_due;
  end if;
  return new;
end $$;

drop trigger if exists set_reverify_due on public.verifications;
create trigger set_reverify_due
  after update on public.verifications
  for each row execute function public.set_reverify_due();

-- Core removal, used by the admin button and by the renewal job. Not callable from the app.
create or replace function public.unverify_provider(p_verification uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  v record;
  v_random text;
begin
  select id, user_id, status into v from public.verifications where id = p_verification;
  if not found or v.status <> 'approved' then return; end if;

  -- Random password. The old one cannot be restored, so the provider uses "Forgot password".
  v_random := encode(extensions.gen_random_bytes(24), 'hex');
  update auth.users
     set encrypted_password = extensions.crypt(v_random, extensions.gen_salt('bf')), updated_at = now()
   where id = v.user_id;

  update public.verifications
     set status = 'rejected', rejection_reason = p_reason, reviewed_at = now()
   where id = v.id;
  delete from public.verification_codes where user_id = v.user_id;
  update public.businesses set is_verified = false where owner_id = v.user_id;
  update public.student_verifications set status = 'rejected', review_note = p_reason, reviewed_at = now()
   where user_id = v.user_id;
  update public.code_requests set handled_at = now() where user_id = v.user_id and handled_at is null;
  update public.provider_admin set reverify_due = null where user_id = v.user_id;

  insert into public.admin_messages (recipient_id, subject, body) values (
    v.user_id,
    'Your verification was removed',
    'Your verification was removed: ' || p_reason || ' Your login code no longer works. Use "Forgot password" on the login page to set a new password, then fix your form and submit it again.'
  );
end $$;

revoke all on function public.unverify_provider(uuid, text) from public, anon, authenticated;

-- Admin button: remove an approved verification with a reason
create or replace function public.admin_remove_verification(p_verification uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_status text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if length(v_reason) < 5 then raise exception 'Write a short reason (at least 5 characters).'; end if;

  select status into v_status from public.verifications where id = p_verification;
  if not found then raise exception 'That verification no longer exists.'; end if;
  if v_status <> 'approved' then raise exception 'Only an approved verification can be removed.'; end if;

  perform public.unverify_provider(p_verification, v_reason);

  insert into public.audit_logs (admin_id, action, target_id, detail)
  select auth.uid(), 'verification_revoke', v.user_id, v_reason
  from public.verifications v where v.id = p_verification;
end $$;

grant execute on function public.admin_remove_verification(uuid, text) to authenticated;

-- Removes every approved verification whose re-verification date has passed.
-- Run by the daily job, or by the admin button.
create or replace function public.admin_expire_due()
returns int
language plpgsql security definer set search_path = public, auth, extensions
as $$
declare
  r record;
  n int := 0;
begin
  if session_user <> 'postgres' and not public.is_admin() then raise exception 'not authorized'; end if;

  for r in
    select v.id
    from public.verifications v
    join public.provider_admin p on p.user_id = v.user_id
    where v.status = 'approved' and p.reverify_due is not null and p.reverify_due < current_date
  loop
    perform public.unverify_provider(r.id, 'Your verification needs renewing. Please check your details and submit the form again.');
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function public.admin_expire_due() to authenticated;

-- Daily job at 03:00. If pg_cron is not switched on, this does nothing and the admin button still works.
do $$
begin
  execute $cron$select cron.schedule('expire-verifications', '0 3 * * *', 'select public.admin_expire_due()')$cron$;
exception when others then
  raise notice 'pg_cron is not on. Enable it in Database > Extensions, or use the Check re-verification dates button.';
end $$;

-- Suspend: hide listings and block sign-in until the date
create or replace function public.admin_suspend_provider(p_user uuid, p_until date, p_reason text)
returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_ids uuid[];
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if length(v_reason) < 5 then raise exception 'Write a short reason (at least 5 characters).'; end if;
  if p_until is null or p_until < current_date then raise exception 'Pick a date in the future.'; end if;

  insert into public.provider_admin (user_id) values (p_user) on conflict (user_id) do nothing;

  select coalesce(array_agg(b.id), '{}') into v_ids
  from public.businesses b where b.owner_id = p_user and b.is_published;

  update public.businesses set is_published = false where owner_id = p_user and is_published;
  update public.provider_admin
     set suspended_until = p_until, suspend_reason = v_reason, suspended_listing_ids = v_ids
   where user_id = p_user;
  update auth.users set banned_until = p_until::timestamptz, updated_at = now() where id = p_user;

  insert into public.admin_messages (recipient_id, subject, body) values (
    p_user, 'Your account is suspended',
    'Your account is suspended until ' || p_until || ': ' || v_reason || '. Your listings are hidden until then.'
  );
  insert into public.audit_logs (admin_id, action, target_id, detail)
  values (auth.uid(), 'provider_suspend', p_user, v_reason);
end $$;

grant execute on function public.admin_suspend_provider(uuid, date, text) to authenticated;

-- Lift a suspension: sign-in works again and the same listings show again
create or replace function public.admin_lift_suspension(p_user uuid)
returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_until date;
  v_ids uuid[];
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;

  select suspended_until, suspended_listing_ids into v_until, v_ids
  from public.provider_admin where user_id = p_user;
  if v_until is null then raise exception 'This provider is not suspended.'; end if;

  update public.businesses set is_published = true where id = any(v_ids) and owner_id = p_user;
  update public.provider_admin
     set suspended_until = null, suspend_reason = null, suspended_listing_ids = '{}'
   where user_id = p_user;
  -- Only clear the sign-in block if it was set by this suspension, not by a ban
  update auth.users set banned_until = null, updated_at = now()
   where id = p_user and banned_until::date = v_until;

  insert into public.admin_messages (recipient_id, subject, body) values (
    p_user, 'Your suspension has been lifted',
    'Your account is active again. Your listings show again.'
  );
  insert into public.audit_logs (admin_id, action, target_id, detail)
  values (auth.uid(), 'provider_unsuspend', p_user, null);
end $$;

grant execute on function public.admin_lift_suspension(uuid) to authenticated;

-- Possible duplicates: the same phone number on more than one open or approved application
create or replace function public.admin_duplicate_flags()
returns table(flag_type text, match_value text, user_ids uuid[], names text[])
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    with entries as (
      select v.user_id as uid, 'Phone number'::text as ftype,
             v.form_data->>'phone' as mval, coalesce(v.form_data->>'full_name', '') as nm
      from public.verifications v
      where v.status in ('pending', 'approved') and coalesce(v.form_data->>'phone', '') <> ''
      union all
      select v.user_id, 'Reference phone'::text, r->>'phone', coalesce(v.form_data->>'full_name', '')
      from public.verifications v,
           jsonb_array_elements(coalesce((v.form_data->'references')::jsonb, '[]'::jsonb)) r
      where v.status in ('pending', 'approved') and coalesce(r->>'phone', '') <> ''
    )
    select e.ftype, e.mval, array_agg(distinct e.uid), array_agg(distinct e.nm)
    from entries e
    group by e.ftype, e.mval
    having count(distinct e.uid) > 1;
end $$;

grant execute on function public.admin_duplicate_flags() to authenticated;

-- ============ Admin alerts (what users do that needs your attention) ============

create table if not exists public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  title text not null,
  body text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

alter table public.admin_alerts enable row level security;

-- Admins can read alerts (also lets the live feed reach the admin page)
drop policy if exists "admins read alerts" on public.admin_alerts;
create policy "admins read alerts" on public.admin_alerts
  for select to authenticated using (public.is_admin());

-- Name shown in an alert
create or replace function public.person_name(p_uid uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p.full_name from public.profiles p where p.id = p_uid),
    (select v.form_data->>'full_name' from public.verifications v where v.user_id = p_uid limit 1),
    'A user'
  );
$$;

create or replace function public.add_admin_alert(p_kind text, p_title text, p_body text)
returns void
language sql security definer set search_path = public
as $$
  insert into public.admin_alerts (kind, title, body) values (p_kind, p_title, p_body);
$$;

-- Only the triggers below may add alerts, not the app
revoke all on function public.add_admin_alert(text, text, text) from public, anon, authenticated;
revoke all on function public.person_name(uuid) from public, anon, authenticated;

-- Report filed
create or replace function public.alert_report()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.add_admin_alert('report', 'New report',
    'About ' || public.person_name(new.reported_id) || ': ' || coalesce(new.reason, '(no reason given)'));
  return new;
end $$;

drop trigger if exists alert_report on public.reports;
create trigger alert_report after insert on public.reports
  for each row execute function public.alert_report();

-- User blocked someone
create or replace function public.alert_block()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.add_admin_alert('block', 'A user blocked someone',
    public.person_name(new.blocker_id) || ' blocked ' || public.person_name(new.blocked_id) || '.');
  return new;
end $$;

drop trigger if exists alert_block on public.user_blocks;
create trigger alert_block after insert on public.user_blocks
  for each row execute function public.alert_block();

-- Verification form submitted for review
create or replace function public.alert_verification()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    perform public.add_admin_alert('verification', 'New verification application',
      coalesce(new.form_data->>'full_name', public.person_name(new.user_id)) || ' submitted a form for review.');
  end if;
  return new;
end $$;

drop trigger if exists alert_verification on public.verifications;
create trigger alert_verification after insert or update on public.verifications
  for each row execute function public.alert_verification();

-- Lost login code, asked for a new one
create or replace function public.alert_code_request()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.add_admin_alert('code_request', 'Login code requested',
    public.person_name(new.user_id) || ' lost their login code and asked for a new one.');
  return new;
end $$;

drop trigger if exists alert_code_request on public.code_requests;
create trigger alert_code_request after insert on public.code_requests
  for each row execute function public.alert_code_request();

-- Admin: unread alerts (or all of them)
create or replace function public.admin_list_alerts(p_all boolean default false)
returns table(id uuid, kind text, title text, body text, created_at timestamptz, read_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return query
    select a.id, a.kind, a.title, a.body, a.created_at, a.read_at
    from public.admin_alerts a
    where p_all or a.read_at is null
    order by a.created_at desc
    limit 200;
end $$;

-- Admin: mark one alert read, or all of them when no id is given
create or replace function public.admin_mark_alerts_read(p_id uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.admin_alerts set read_at = now()
  where read_at is null and (p_id is null or id = p_id);
end $$;

grant execute on function public.admin_list_alerts(boolean) to authenticated;
grant execute on function public.admin_mark_alerts_read(uuid) to authenticated;

-- Live feed for the admin page
do $$ begin
  alter publication supabase_realtime add table public.admin_alerts;
exception when duplicate_object then null;
end $$;

*/
