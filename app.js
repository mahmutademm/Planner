import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const TZ = "America/New_York";
const cfg = window.PLANNER_CONFIG || {};
const $app = document.getElementById("app");
const $tabs = document.getElementById("tabs");

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

if (!cfg.url || !cfg.anonKey) {
  $app.innerHTML = `<div class="boot">App not configured yet.</div>`;
  throw new Error("missing config");
}
const sb = createClient(cfg.url, cfg.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ───────── helpers ─────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayName = (iso, style = "short") => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: style, timeZone: "UTC" });
const dayNum = (iso) => Number(iso.slice(8, 10));
const longDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const hm = (t) => (t ? t.slice(0, 5) : "");
const ago = (ts) => {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
};
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
             set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
const KIND_LABEL = { main: "Main", task: "Task", big4: "Big 4", bonus: "Bonus", run: "Run", habit: "Habit", fixed: "Fixed", prayer: "Prayer" };
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

// ───────── state ─────────
const S = {
  session: null, tab: "week", day: nyToday(),
  days: {}, tasks: [], deadlines: [], open: [], emails: [], notes: [], prefs: null,
  inboxFilter: ls.get("inboxFilter", "action"), loaded: false,
};

// ───────── data ─────────
async function loadAll() {
  const today = nyToday(), end = addDays(today, 6);
  const [days, tasks, deadlines, open, emails, notes, prefs] = await Promise.all([
    sb.from("days").select("*").gte("date", today).lte("date", end),
    sb.from("tasks").select("*").gte("date", today).lte("date", end).order("date").order("start_time", { nullsFirst: false }),
    sb.from("deadlines").select("*").gte("due_date", addDays(today, -1)).lte("due_date", addDays(today, 30)).order("due_date"),
    sb.from("open_items").select("*").order("position").order("since"),
    sb.from("emails").select("*").order("received_at", { ascending: false }).limit(150),
    sb.from("notes").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("prefs").select("*").eq("id", 1).maybeSingle(),
  ]);
  const err = [days, tasks, deadlines, open, emails, notes, prefs].find((r) => r.error);
  if (err) { toast("Couldn't load: " + err.error.message); return; }
  S.days = Object.fromEntries(days.data.map((d) => [d.date, d]));
  S.tasks = tasks.data; S.deadlines = deadlines.data; S.open = open.data;
  S.emails = emails.data; S.notes = notes.data; S.prefs = prefs.data;
  S.loaded = true;
  if (S.day < today || S.day > end) S.day = today;
  render();
}

let reloadTimer;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 400); }
let channel;
function subscribeLive() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("planner-live");
  for (const table of ["days", "tasks", "deadlines", "open_items", "emails", "notes"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleReload);
  }
  channel.subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.session) loadAll(); });

async function patch(table, id, values, key = "id") {
  const { error } = await sb.from(table).update(values).eq(key, id);
  if (error) { toast("Save failed: " + error.message); loadAll(); return false; }
  return true;
}

// ───────── routing ─────────
function route() {
  const h = (location.hash || "#week").slice(1);
  S.tab = ["week", "inbox", "notes", "lists", "settings", "deadlines"].includes(h) ? h : "week";
  if (S.tab === "deadlines") S.tab = "lists";
  render();
}
window.addEventListener("hashchange", route);

function render() {
  if (!S.session) return renderAuth();
  $tabs.hidden = false;
  for (const a of $tabs.querySelectorAll("a")) a.classList.toggle("on", a.dataset.tab === S.tab);
  updateBadges();
  if (!S.loaded) { $app.innerHTML = `<div class="boot">Loading…</div>`; return; }
  ({ week: renderWeek, inbox: renderInbox, notes: renderNotes, lists: renderLists, settings: renderSettings })[S.tab]();
}

function updateBadges() {
  const inboxN = S.emails.filter((e) => e.category === "action" && !e.done).length;
  const seen = ls.get("notesSeen", 0);
  const notesN = S.notes.filter((n) => n.reply && new Date(n.handled_at || 0).getTime() > seen).length;
  const bi = document.getElementById("b-inbox"), bn = document.getElementById("b-notes");
  bi.hidden = !inboxN; bi.textContent = inboxN;
  bn.hidden = !notesN; bn.textContent = notesN;
  if ("setAppBadge" in navigator) {
    const n = inboxN + S.tasks.filter((t) => t.date === nyToday() && t.status === "todo" && !["prayer", "fixed"].includes(t.kind)).length;
    (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch?.(() => {});
  }
}

// ───────── auth ─────────
function renderAuth(mode = "signin") {
  $tabs.hidden = true;
  $app.innerHTML = `
    <h1>Planner</h1>
    <p class="sub">${mode === "signin" ? "Sign in to your planner." : "Create your account (one time)."}</p>
    ${isIOS() && !isStandalone() ? installHint() : ""}
    <form id="auth" class="card">
      <div class="field"><label for="em">Email</label><input id="em" type="email" autocomplete="email" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="${mode === "signin" ? "current-password" : "new-password"}" minlength="8" required></div>
      <button class="btn primary block" type="submit">${mode === "signin" ? "Sign in" : "Create account"}</button>
    </form>
    <p class="small muted" style="text-align:center">
      <button class="btn link" id="swap">${mode === "signin" ? "First time? Create account" : "Have an account? Sign in"}</button>
    </p>`;
  document.getElementById("swap").onclick = () => renderAuth(mode === "signin" ? "signup" : "signin");
  document.getElementById("auth").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("em").value.trim(), password = document.getElementById("pw").value;
    const btn = e.target.querySelector("button"); btn.disabled = true;
    const res = mode === "signin"
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password });
    btn.disabled = false;
    if (res.error) return toast(res.error.message);
    if (mode === "signup" && !res.data.session) {
      toast("Check your email to confirm, then sign in here.");
      renderAuth("signin");
    }
  };
}

function installHint() {
  return `<div class="card hint" style="margin-bottom:12px">
    <b>Install on iPhone:</b> tap <b>Share</b> ⬆︎ in Safari → <b>Add to Home Screen</b>, then open Planner from your home screen.
    Notifications only work from the home-screen app.</div>`;
}

// ───────── WEEK ─────────
function renderWeek() {
  const today = nyToday();
  const dates = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const counted = (t) => !["prayer", "fixed"].includes(t.kind);
  const strip = dates.map((d) => {
    const ts = S.tasks.filter((t) => t.date === d && counted(t));
    const done = ts.filter((t) => t.status === "done").length;
    const pct = ts.length ? Math.round((done / ts.length) * 100) : 0;
    return `<button class="day-chip ${d === S.day ? "on" : ""} ${d === today ? "today" : ""}" data-day="${d}">
      <span class="dn">${d === today ? "Today" : dayName(d)}</span><span class="dd">${dayNum(d)}</span>
      <span class="dp"><i style="width:${pct}%"></i></span></button>`;
  }).join("");

  const d = S.day, info = S.days[d] || {};
  const all = S.tasks.filter((t) => t.date === d);
  const prayers = all.filter((t) => t.kind === "prayer");
  const fixed = all.filter((t) => t.kind === "fixed");
  const tasks = all.filter(counted);
  const dueHere = S.deadlines.filter((x) => x.due_date === d);

  const weekTasks = S.tasks.filter(counted);
  const weekDone = weekTasks.filter((t) => t.status === "done").length;

  $app.innerHTML = `
    <h1>${d === today ? "Today" : dayName(d, "long")}</h1>
    <p class="sub">${longDate(d)}${info.mode ? " · " + esc(info.mode) : ""}${info.run ? " · Run" : ""} · week ${weekDone}/${weekTasks.length} done</p>
    <div class="strip">${strip}</div>

    ${info.headline || info.agent_note ? `<div class="card agent dayhead"><div class="who">Claude</div>
      ${info.headline ? `<div style="font-weight:600;margin-top:2px">${esc(info.headline)}</div>` : ""}
      ${info.agent_note ? `<div class="small" style="margin-top:4px;white-space:pre-wrap">${esc(info.agent_note)}</div>` : ""}</div>` : ""}

    ${dueHere.length ? `<h2>Due this day</h2><div class="stack">${dueHere.map(deadlineRow).join("")}</div>` : ""}

    ${prayers.length ? `<h2>Prayer</h2><div class="prayers">${prayers.map((p) => `
      <button class="prayer st-${p.status}" data-prayer="${p.id}" aria-pressed="${p.status === "done"}">
        ${esc(p.title)}<b>${hm(p.start_time)}</b>${p.detail ? `<span class="warn">${esc(p.detail)}</span>` : ""}
      </button>`).join("")}</div>` : ""}

    <h2>Tasks</h2>
    <div class="stack">${tasks.length ? tasks.map(taskRow).join("") : `<div class="empty">No tasks planned yet for this day.</div>`}</div>
    <button class="btn block" id="add-task" style="margin-top:10px">＋ Add task</button>

    ${fixed.length ? `<h2>Fixed</h2><div class="stack">${fixed.map((f) => `
      <div class="card task k-fixed"><div class="time">${hm(f.start_time)}${f.end_time ? `<br><span class="small">${hm(f.end_time)}</span>` : ""}</div>
      <div class="body"><div class="title">${esc(f.title)}</div>${f.detail ? `<div class="detail">${esc(f.detail)}</div>` : ""}</div></div>`).join("")}</div>` : ""}
  `;

  $app.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { S.day = b.dataset.day; renderWeek(); }));
  $app.querySelectorAll("[data-prayer]").forEach((b) => (b.onclick = () => {
    const t = S.tasks.find((x) => x.id === b.dataset.prayer);
    setTaskStatus(t, t.status === "done" ? "todo" : "done");
  }));
  $app.querySelectorAll("[data-set]").forEach((b) => (b.onclick = () => {
    const t = S.tasks.find((x) => x.id === b.dataset.id);
    setTaskStatus(t, t.status === b.dataset.set ? "todo" : b.dataset.set);
  }));
  $app.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => toggleDeadline(b.dataset.dl)));
  document.getElementById("add-task").onclick = () => addTaskDialog(d);
}

function taskRow(t) {
  const btn = (st, icon, label) =>
    `<button class="act ${st} ${t.status === st ? "on" : ""}" data-set="${st}" data-id="${t.id}" aria-label="${label}" aria-pressed="${t.status === st}">${icon}&nbsp;${label}</button>`;
  return `<div class="card task k-${t.kind} st-${t.status}">
    <div class="time">${hm(t.start_time) || "—"}${t.end_time ? `<br><span class="small">${hm(t.end_time)}</span>` : ""}</div>
    <div class="body">
      <span class="kind">${KIND_LABEL[t.kind] || t.kind}</span>
      <div class="title">${esc(t.title)}</div>
      ${t.detail ? `<div class="detail">${esc(t.detail)}</div>` : ""}
      ${t.moved_count ? `<div class="moved">↻ moved ${t.moved_count}×</div>` : ""}
    </div>
    <div class="acts">${btn("done", "✓", "Done")}${btn("skipped", "✕", "Missed")}${btn("moved", "→", "Move")}</div>
  </div>`;
}

async function setTaskStatus(t, status) {
  const prev = t.status; t.status = status; render();
  const ok = await patch("tasks", t.id, { status, updated_by: "app" });
  if (!ok) t.status = prev;
  else if (status === "moved") toast("Marked to move — Claude will reschedule it.");
}

function addTaskDialog(date) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog" id="tf">
    <h2 style="margin-top:0">Add task · ${dayName(date)} ${dayNum(date)}</h2>
    <div class="field"><label>Title</label><input type="text" name="title" required></div>
    <div class="row"><div class="field grow"><label>Start</label><input type="time" name="start"></div>
      <div class="field grow"><label>End</label><input type="time" name="end"></div></div>
    <div class="field"><label>Type</label><select name="kind">
      <option value="task">Task</option><option value="main">Main</option><option value="big4">Big 4</option>
      <option value="bonus">Bonus</option><option value="run">Run</option><option value="habit">Habit</option><option value="fixed">Fixed (class/work/meeting)</option></select></div>
    <div class="field"><label>Note (optional)</label><input type="text" name="detail"></div>
    <div class="row"><button class="btn grow" value="cancel" formnovalidate>Cancel</button><button class="btn primary grow" value="ok">Add</button></div>
  </form>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.addEventListener("close", async () => {
    const f = new FormData(dlg.querySelector("form"));
    dlg.remove();
    if (dlg.returnValue !== "ok") return;
    const row = { date, title: f.get("title"), kind: f.get("kind"), detail: f.get("detail") || null,
      start_time: f.get("start") || null, end_time: f.get("end") || null, updated_by: "app" };
    const { error } = await sb.from("tasks").insert(row);
    if (error) return toast(error.message);
    toast("Added"); loadAll();
  });
}

// ───────── INBOX ─────────
function renderInbox() {
  const cats = [["action", "Needs you"], ["waiting", "Waiting"], ["fyi", "FYI"], ["all", "All"]];
  const f = S.inboxFilter;
  const list = S.emails.filter((e) => f === "all" || e.category === f).filter((e) => f === "all" || !e.done || isRecent(e));
  $app.innerHTML = `
    <h1>Inbox</h1><p class="sub">Claude's digest of your email accounts, refreshed every morning.</p>
    <div class="chips">${cats.map(([k, l]) => {
      const n = k === "all" ? "" : S.emails.filter((e) => e.category === k && !e.done).length;
      return `<button class="chip ${f === k ? "on" : ""}" data-f="${k}">${l}${n ? ` · ${n}` : ""}</button>`;
    }).join("")}</div>
    <div class="stack" style="margin-top:12px">${list.length ? list.map(mailRow).join("") : `<div class="empty">Nothing here.</div>`}</div>`;
  $app.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { S.inboxFilter = b.dataset.f; ls.set("inboxFilter", S.inboxFilter); renderInbox(); }));
  $app.querySelectorAll("[data-mail]").forEach((b) => (b.onclick = async () => {
    const e = S.emails.find((x) => x.id === b.dataset.mail);
    e.done = !e.done; render(); await patch("emails", e.id, { done: e.done });
  }));
}
const isRecent = (e) => Date.now() - new Date(e.received_at || e.created_at) < 86400000;
function mailRow(e) {
  return `<div class="card mail ${e.done ? "done" : ""}">
    <div class="row"><span class="pill">${esc(e.account || "Mail")}</span>
      <span class="from grow">${esc(e.sender || "")}</span><span class="small muted">${e.received_at ? ago(e.received_at) : ""}</span></div>
    <div class="subj">${esc(e.subject || "(no subject)")}</div>
    ${e.summary ? `<div class="sum">${esc(e.summary)}</div>` : ""}
    <div class="row" style="margin-top:8px">
      ${e.link ? `<a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Open</a>` : ""}
      <span class="grow"></span>
      <button class="btn" data-mail="${esc(e.id)}">${e.done ? "↺ Undo" : "✓ Handled"}</button></div>
  </div>`;
}

// ───────── NOTES ─────────
function renderNotes() {
  ls.set("notesSeen", Date.now());
  updateBadges();
  $app.innerHTML = `
    <h1>Notes to Claude</h1>
    <p class="sub">Leave messages for the 6am run: changes, new info, reminders. For anything urgent, text Claude directly.</p>
    <form id="nf" class="card">
      <textarea name="body" placeholder="e.g. Move Big 4 to Thursday. I have a meeting Friday 3pm with Prof. Miller." required></textarea>
      <button class="btn primary block" style="margin-top:8px">Send to Claude</button>
    </form>
    <h2>History</h2>
    <div class="stack">${S.notes.length ? S.notes.map((n) => `
      <div class="card note">
        <div class="row"><span class="pill ${n.status === "handled" ? "ok" : "warn"}">${n.status === "handled" ? "Handled" : "Waiting for 6am"}</span>
          <span class="grow"></span><span class="small muted">${ago(n.created_at)}</span></div>
        <div class="body" style="margin-top:6px">${esc(n.body)}</div>
        ${n.reply ? `<div class="reply"><b>Claude:</b> ${esc(n.reply)}</div>` : ""}
      </div>`).join("") : `<div class="empty">No notes yet.</div>`}</div>`;
  document.getElementById("nf").onsubmit = async (e) => {
    e.preventDefault();
    const body = new FormData(e.target).get("body").trim();
    if (!body) return;
    const { error } = await sb.from("notes").insert({ body });
    if (error) return toast(error.message);
    toast("Sent — Claude reads it at 6am."); loadAll();
  };
}

// ───────── LISTS (open items + deadlines) ─────────
function renderLists() {
  const today = nyToday();
  const open = S.open.filter((o) => o.status !== "done");
  const doneRecent = S.open.filter((o) => o.status === "done").slice(-5);
  const upcoming = S.deadlines.filter((d) => d.due_date >= today);
  $app.innerHTML = `
    <h1>Lists</h1>
    <h2>Open items</h2>
    <div class="stack">${open.length ? open.map(openRow).join("") : `<div class="empty">Nothing open.</div>`}</div>
    <form id="of" class="row" style="margin-top:8px">
      <input type="text" name="title" placeholder="Add an open item…" class="grow" required>
      <button class="btn primary">Add</button></form>
    ${doneRecent.length ? `<h2>Recently closed</h2><div class="stack">${doneRecent.map(openRow).join("")}</div>` : ""}
    <h2 id="deadlines">Deadlines · next 30 days</h2>
    <div class="stack">${upcoming.length ? upcoming.map(deadlineRow).join("") : `<div class="empty">No deadlines loaded.</div>`}</div>`;
  $app.querySelectorAll("[data-open]").forEach((b) => (b.onclick = async () => {
    const o = S.open.find((x) => x.id === b.dataset.open);
    o.status = b.dataset.st; render(); await patch("open_items", o.id, { status: o.status });
  }));
  $app.querySelectorAll("[data-dl]").forEach((b) => (b.onclick = () => toggleDeadline(b.dataset.dl)));
  document.getElementById("of").onsubmit = async (e) => {
    e.preventDefault();
    const title = new FormData(e.target).get("title").trim();
    const { error } = await sb.from("open_items").insert({ title, position: 999 });
    if (error) return toast(error.message);
    loadAll();
  };
  if (location.hash === "#deadlines") document.getElementById("deadlines").scrollIntoView();
}
function openRow(o) {
  const b = (st, label) => `<button class="chip ${o.status === st ? "on" : ""}" data-open="${o.id}" data-st="${st}">${label}</button>`;
  const days = Math.round((Date.now() - new Date(o.since + "T12:00:00Z")) / 86400000);
  return `<div class="card">
    <div class="row">${o.flag ? `<span class="pill ${o.flag}">${o.flag === "critical" ? "Critical" : "Overdue"}</span>` : ""}
      <span class="small muted">${days > 0 ? `open ${days}d` : "new"}</span></div>
    <div style="font-weight:560;margin-top:4px;overflow-wrap:anywhere">${esc(o.title)}</div>
    ${o.detail ? `<div class="small muted" style="margin-top:2px">${esc(o.detail)}</div>` : ""}
    <div class="chips" style="margin-top:8px">${b("open", "Open")}${b("waiting", "Waiting")}${b("done", "✓ Done")}</div></div>`;
}
function deadlineRow(d) {
  const today = nyToday();
  const diff = Math.round((new Date(d.due_date + "T12:00:00Z") - new Date(today + "T12:00:00Z")) / 86400000);
  const when = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff < 0 ? "Past" : `${dayName(d.due_date)} ${dayNum(d.due_date)} · ${diff}d`;
  const cls = d.status === "done" ? "ok" : diff <= 1 ? "critical" : diff <= 3 ? "warn" : "";
  return `<div class="card row" style="${d.status === "done" ? "opacity:.55" : ""}">
    <div class="grow"><div class="row"><span class="pill ${cls}">${when}</span><span class="small muted">${esc(d.course || "")}</span></div>
      <div style="font-weight:560;margin-top:4px;overflow-wrap:anywhere;${d.status === "done" ? "text-decoration:line-through" : ""}">${esc(d.item)}</div>
      ${d.due_time || d.note ? `<div class="small muted">${esc([d.due_time, d.note].filter(Boolean).join(" · "))}</div>` : ""}</div>
    <button class="act done ${d.status === "done" ? "on" : ""}" data-dl="${d.id}" aria-label="Mark done" aria-pressed="${d.status === "done"}">✓</button></div>`;
}
async function toggleDeadline(id) {
  const d = S.deadlines.find((x) => x.id === id);
  d.status = d.status === "done" ? "open" : "done"; render();
  await patch("deadlines", d.id, { status: d.status });
}

// ───────── SETTINGS ─────────
function renderSettings() {
  const p = S.prefs || {};
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const sw = (k, label, sub) => `<label class="switch"><span class="grow"><div>${label}</div><div class="small muted">${sub}</div></span>
    <input type="checkbox" data-pref="${k}" ${p[k] ? "checked" : ""}></label>`;
  $app.innerHTML = `
    <h1>Settings</h1>
    ${isIOS() && !isStandalone() ? installHint() : ""}
    <h2>Notifications on this device</h2>
    <div class="card stack">
      <div class="small muted">Status: <b>${perm === "granted" ? "On" : perm === "denied" ? "Blocked in iPhone Settings" : perm === "unsupported" ? "Open from home screen to enable" : "Off"}</b></div>
      <button class="btn primary block" id="push-on">${perm === "granted" ? "Re-register this device" : "Enable notifications"}</button>
      <button class="btn block" id="push-test">Send a test notification</button>
    </div>
    <h2>What to notify</h2>
    <div class="card list-card">
      ${sw("morning", "Morning plan ready", "After the 6am run")}
      ${sw("task", "Task reminders", `${p.task_lead_min ?? 10} min before each block`)}
      ${sw("prayer", "Prayer times", "Öğle · İkindi · Akşam · Yatsı")}
      ${sw("deadline", "Deadlines", "2 days before (8:00) and morning of (7:00)")}
      ${sw("evening", "Evening check-in", "If today's tasks aren't marked")}
    </div>
    <div class="row" style="margin-top:10px">
      <div class="field grow"><label>Evening check-in time</label><input type="time" id="eve" value="${hm(p.evening_time || "21:30")}"></div>
      <div class="field grow"><label>Reminder lead (min)</label><input type="number" id="lead" min="0" max="120" value="${p.task_lead_min ?? 10}"></div>
    </div>
    <h2>Account</h2>
    <div class="card row"><span class="grow small">${esc(S.session.user.email)}</span><button class="btn" id="out">Sign out</button></div>
    <p class="small muted" style="text-align:center;margin-top:18px">Planner · synced with Claude every morning at 6:00</p>`;

  $app.querySelectorAll("[data-pref]").forEach((i) => (i.onchange = async () => {
    S.prefs[i.dataset.pref] = i.checked; await patch("prefs", 1, { [i.dataset.pref]: i.checked });
  }));
  document.getElementById("eve").onchange = (e) => patch("prefs", 1, { evening_time: e.target.value }).then(loadAll);
  document.getElementById("lead").onchange = (e) => patch("prefs", 1, { task_lead_min: Number(e.target.value) || 0 }).then(loadAll);
  document.getElementById("push-on").onclick = enablePush;
  document.getElementById("push-test").onclick = async () => {
    const { error } = await sb.from("notifications").insert({ title: "Test notification ✅", body: "Push notifications are working.", kind: "test" });
    toast(error ? error.message : "Queued — it should arrive within a minute.");
  };
  document.getElementById("out").onclick = () => sb.auth.signOut();
}

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return toast(isIOS() ? "Add Planner to your Home Screen first, then open it from there." : "This browser doesn't support push.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("Notifications not allowed. You can change this in iPhone Settings → Planner.");
  try {
    const reg = await navigator.serviceWorker.ready;
    const { data, error } = await sb.rpc("public_config");
    if (error || !data?.vapid_public) throw new Error(error?.message || "Missing push key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(data.vapid_public) });
    const j = sub.toJSON();
    const { error: e2 } = await sb.from("push_subscriptions").upsert({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent,
    });
    if (e2) throw e2;
    toast("Notifications on ✅"); renderSettings();
  } catch (e) { toast("Couldn't enable: " + e.message); }
}

// ───────── boot ─────────
sb.auth.onAuthStateChange((_event, session) => {
  const was = S.session?.user?.id;
  S.session = session;
  if (session && was !== session.user.id) { S.loaded = false; route(); loadAll(); subscribeLive(); }
  else if (!session) { S.loaded = false; if (channel) sb.removeChannel(channel); render(); }
});
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.url) location.hash = new URL(e.data.url, location.href).hash || "#week"; });
