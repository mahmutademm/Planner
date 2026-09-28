// push-dispatch — called every minute by pg_cron.
// Reads due_notifications(), sends Web Push to every saved subscription,
// logs what was sent so nothing is delivered twice.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

async function config(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from("app_config").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

Deno.serve(async (req) => {
  try {
    const cfg = await config();
    if (!cfg.dispatch_secret || req.headers.get("x-dispatch-secret") !== cfg.dispatch_secret) {
      return new Response("forbidden", { status: 403 });
    }
    webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public, cfg.vapid_private);

    // no device registered yet → leave everything queued (don't burn notifications)
    const { data: subs, error: subErr } = await supabase.from("push_subscriptions").select("*");
    if (subErr) throw subErr;
    if (!subs?.length) return Response.json({ sent: 0, reason: "no subscriptions" });

    const { data: due, error: dueErr } = await supabase.rpc("due_notifications");
    if (dueErr) throw dueErr;
    if (!due?.length) return Response.json({ sent: 0 });

    let sent = 0;
    for (const n of due) {
      // claim the key first so a slow run can't double-send
      const { error: logErr } = await supabase.from("notification_log").insert({ key: n.key });
      if (logErr) continue; // already sent by another run

      const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: n.tag });
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 3600, urgency: "high" },
          );
          sent++;
          await supabase.from("push_subscriptions")
            .update({ last_ok_at: new Date().toISOString() }).eq("endpoint", s.endpoint);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            // subscription expired (app removed / permission revoked)
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          } else {
            console.error("push failed", code, (e as Error).message);
          }
        }
      }
      if (n.queue_id) {
        await supabase.from("notifications")
          .update({ sent_at: new Date().toISOString() }).eq("id", n.queue_id);
      }
    }
    return Response.json({ due: due.length, sent });
  } catch (e) {
    console.error(e);
    return new Response(String((e as Error).message ?? e), { status: 500 });
  }
});
