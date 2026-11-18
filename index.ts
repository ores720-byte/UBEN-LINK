// Sends a phone/browser push when a new row lands in chat_messages or admin_messages.
// Called by Supabase Database Webhooks (INSERT). Needs these secrets:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_WEBHOOK_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails('mailto:ores720@gmail.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

const clip = (t: unknown, n = 120) => String(t ?? '').slice(0, n);

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('PUSH_WEBHOOK_SECRET')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const { type, table, record } = await req.json();
  if (type !== 'INSERT' || !record?.recipient_id) return new Response('ignored');

  let payload;
  if (table === 'admin_messages') {
    payload = { title: clip(record.subject, 60) || 'Message from UBEN Link', body: clip(record.body), url: './#/notifications', tag: 'admin-' + record.id };
  } else if (table === 'chat_messages') {
    payload = { title: 'New message', body: 'Open UBEN Link to read and reply.', url: './#/notifications', tag: 'chat-' + (record.business_id ?? record.id) };
  } else return new Response('ignored');

  const { data: subs } = await sb.from('push_subscriptions').select('endpoint, p256dh, auth').eq('user_id', record.recipient_id);
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (e) {
      // 404/410 means the phone no longer accepts pushes, so forget it
      if (e?.statusCode === 404 || e?.statusCode === 410) await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
    }
  }));
  return new Response(JSON.stringify({ sent }), { headers: { 'Content-Type': 'application/json' } });
});
