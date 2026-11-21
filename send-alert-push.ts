// send-alert-push: sends a Web Push notification to every admin device when a new admin alert is added.
// Called by a Supabase Database Webhook on INSERT into admin_alerts (not by the browser).
//
// Secrets to set (Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY   the public key, the same one the admin page uses
//   VAPID_PRIVATE_KEY  the private key that matches it
//   WEBHOOK_SECRET     any long random text; the webhook sends it in the x-webhook-secret header

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

webpush.setVapidDetails(
  'mailto:ores720@gmail.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Use POST.', { status: 405 });
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) {
    return new Response('Forbidden.', { status: 403 });
  }

  let alert: Record<string, any>;
  try {
    const body = await req.json();
    alert = body.record;
  } catch {
    return new Response('Bad request.', { status: 400 });
  }
  if (!alert?.title) return new Response('No alert.', { status: 400 });

  // Every admin's saved devices
  const { data: admins, error: aErr } = await admin.from('admins').select('user_id');
  if (aErr) return Response.json({ error: aErr.message }, { status: 500 });
  const ids = (admins || []).map((a) => a.user_id);
  if (!ids.length) return Response.json({ sent: 0, note: 'No admins.' });

  const { data: subs, error: sErr } = await admin
    .from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', ids);
  if (sErr) return Response.json({ error: sErr.message }, { status: 500 });

  const payload = JSON.stringify({
    title: 'UBEN Link: ' + alert.title,
    body: alert.body || '',
    url: '/admin.html#alerts',
    tag: 'admin-alert-' + alert.id,
  });

  let sent = 0;
  let removed = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (e: any) {
      // The device unsubscribed or the subscription expired: forget it
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        removed++;
      } else {
        console.error('push failed', e?.statusCode, e?.body);
      }
    }
  }
  return Response.json({ sent, removed });
});
