// verify-provider: approves or rejects a provider verification submission.
// Approve sets a generated 6-character code as the provider's password and returns it once.
// The code is never stored. Deploy with: supabase functions deploy verify-provider
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';

// Makes a 6-character code that always has a letter, a digit and a symbol
function makeCode(): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let out = '';
    for (const b of bytes) out += CHARS[b % CHARS.length];
    if (/[A-Za-z]/.test(out) && /\d/.test(out) && /[^A-Za-z0-9]/.test(out)) return out;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: 'Not signed in.' }, 401);

    // TODO: replace with the same admin check that ai-proxy uses
    const { data: prof } = await admin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!prof?.is_admin) return json({ error: 'Admins only.' }, 403);

    const { action, verification_id, note, reason } = await req.json();
    const { data: v } = await admin.from('verifications')
      .select('id, user_id, status').eq('id', verification_id).single();
    if (!v) return json({ error: 'Submission not found.' }, 404);
    if (v.status !== 'pending') return json({ error: 'Only pending submissions can be decided.' }, 409);

    const now = new Date().toISOString();

    if (action === 'reject') {
      if (!reason?.trim()) return json({ error: 'A reason is required.' }, 400);
      const { error } = await admin.from('verifications').update({
        status: 'rejected', rejection_reason: reason.trim(), reviewed_by: user.id, reviewed_at: now,
      }).eq('id', v.id);
      if (error) return json({ error: error.message }, 500);
      await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_reject', target_id: v.user_id, detail: reason.trim(),
      });
      return json({ ok: true });
    }

    if (action === 'approve') {
      const code = makeCode();
      const { error: pwErr } = await admin.auth.admin.updateUserById(v.user_id, { password: code });
      if (pwErr) return json({ error: 'Could not set the password: ' + pwErr.message }, 500);

      const { error } = await admin.from('verifications').update({
        status: 'approved', rejection_reason: null, reviewed_by: user.id, reviewed_at: now,
      }).eq('id', v.id);
      if (error) return json({ error: error.message }, 500);
      await admin.from('audit_logs').insert({
        admin_id: user.id, action: 'verification_approve', target_id: v.user_id, detail: note || null,
      });
      return json({ ok: true, code });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
