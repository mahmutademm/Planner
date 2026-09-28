-- Mahmut Planner — database schema
-- Timezone for all local dates/times: America/New_York

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ───────── private config (no RLS policies = invisible to app users) ─────────
create table if not exists app_config (
  key   text primary key,
  value text not null
);
alter table app_config enable row level security;
-- keys: owner_email, vapid_public, vapid_private, vapid_subject, dispatch_url, dispatch_secret

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(lower(auth.jwt() ->> 'email') =
         lower((select value from app_config where key = 'owner_email')), false);
$$;

-- public bits the app may read (VAPID public key only)
create or replace function public_config() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('vapid_public', (select value from app_config where key = 'vapid_public'));
$$;

create or replace function touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

-- ───────── planner data ─────────
create table if not exists days (
  date        date primary key,
  mode        text,               -- 'School', 'Work', 'Free', ...
  run         boolean default false,
  headline    text,               -- one-line summary for the day card
  agent_note  text,               -- Claude's note for the day
  updated_at  timestamptz default now()
);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  start_time  time,
  end_time    time,
  title       text not null,
  detail      text,
  kind        text not null default 'task'
              check (kind in ('main','task','big4','bonus','run','habit','prayer','fixed')),
  status      text not null default 'todo'
              check (status in ('todo','done','skipped','moved')),
  moved_count int  not null default 0,
  origin_id   uuid,               -- first version of a carried-over task
  calendar_event_id text,         -- Google Calendar event created by the agent
  updated_by  text not null default 'app',   -- 'app' | 'claude'
  updated_at  timestamptz default now()
);
create index if not exists tasks_date_idx on tasks(date, start_time);

create table if not exists deadlines (
  id        uuid primary key default gen_random_uuid(),
  due_date  date not null,
  due_time  text,                 -- e.g. '23:59', 'in class 09:30'
  course    text,
  item      text not null,
  type      text,                 -- Homework / Quiz / Exam / Honors / Info
  note      text,
  status    text not null default 'open' check (status in ('open','done')),
  updated_at timestamptz default now()
);
create index if not exists deadlines_due_idx on deadlines(due_date);

create table if not exists open_items (
  id        uuid primary key default gen_random_uuid(),
  title     text not null,
  detail    text,
  status    text not null default 'open' check (status in ('open','waiting','done')),
  flag      text check (flag in ('warn','critical')),
  since     date default ((now() at time zone 'America/New_York')::date),
  position  int default 0,
  updated_at timestamptz default now()
);

create table if not exists emails (
  id          text primary key,   -- Gmail message id
  account     text,               -- 'CCM', 'Personal', 'Work'
  received_at timestamptz,
  sender      text,
  subject     text,
  summary     text,
  category    text not null default 'fyi' check (category in ('action','waiting','fyi')),
  link        text,
  done        boolean not null default false,
  created_at  timestamptz default now()
);
create index if not exists emails_received_idx on emails(received_at desc);

create table if not exists notes (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  body       text not null,
  status     text not null default 'new' check (status in ('new','handled')),
  reply      text,
  handled_at timestamptz
);

-- ───────── notifications ─────────
create table if not exists prefs (
  id            int primary key default 1 check (id = 1),
  morning       boolean not null default true,
  task          boolean not null default true,
  prayer        boolean not null default true,
  deadline      boolean not null default true,
  evening       boolean not null default true,
  evening_time  time    not null default '21:30',
  task_lead_min int     not null default 10
);
insert into prefs (id) values (1) on conflict do nothing;

create table if not exists push_subscriptions (
  endpoint   text primary key,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz default now(),
  last_ok_at timestamptz
);

-- ad-hoc queue: morning summary, test pushes, anything Claude wants to send
create table if not exists notifications (
  id       uuid primary key default gen_random_uuid(),
  send_at  timestamptz not null default now(),
  kind     text not null default 'info',   -- 'morning' | 'test' | 'info'
  title    text not null,
  body     text,
  url      text default './',
  sent_at  timestamptz
);

create table if not exists notification_log (
  key     text primary key,
  sent_at timestamptz default now()
);
alter table notification_log enable row level security;

-- ───────── triggers ─────────
do $$ declare t text; begin
  foreach t in array array['days','tasks','deadlines','open_items'] loop
    execute format('drop trigger if exists trg_touch on %I', t);
    execute format('create trigger trg_touch before update on %I for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- ───────── row level security: only the owner, from the app ─────────
do $$ declare t text; begin
  foreach t in array array['days','tasks','deadlines','open_items','emails','notes',
                           'prefs','push_subscriptions','notifications'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists owner_all on %I', t);
    execute format('create policy owner_all on %I for all to authenticated using ((select is_owner())) with check ((select is_owner()))', t);
  end loop;
end $$;

-- live updates in the app when Claude writes
do $$ declare t text; begin
  foreach t in array array['days','tasks','deadlines','open_items','emails','notes'] loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ───────── what should be pushed right now ─────────
create or replace function due_notifications()
returns table (key text, title text, body text, url text, tag text, queue_id uuid)
language sql stable security definer set search_path = public as $$
with p as (select * from prefs where id = 1),
     tz as (select 'America/New_York'::text as z),
     today as (select (now() at time zone (select z from tz))::date as d),
cands as (
  -- task reminders (N minutes before start)
  select 'task:' || t.id || ':' || t.date || ':' || t.start_time as key,
         '⏰ ' || to_char(t.start_time, 'HH24:MI') || ' · ' || t.title as title,
         coalesce(t.detail, '') as body, './#week' as url, 'task' as tag, null::uuid as queue_id,
         ((t.date + t.start_time) at time zone (select z from tz))
           - make_interval(mins => (select task_lead_min from p)) as fire_at
  from tasks t
  where (select task from p) and t.status = 'todo' and t.start_time is not null
    and t.kind not in ('prayer','fixed')
  union all
  -- prayer times
  select 'prayer:' || t.id || ':' || t.date || ':' || t.start_time,
         '🕌 ' || t.title || ' · ' || to_char(t.start_time, 'HH24:MI'),
         coalesce(t.detail, ''), './#week', 'prayer', null,
         (t.date + t.start_time) at time zone (select z from tz)
  from tasks t
  where (select prayer from p) and t.kind = 'prayer' and t.start_time is not null
  union all
  -- deadline: 2 days before, 08:00
  select 'dl48:' || d.id || ':' || d.due_date,
         '⏳ In 2 days: ' || coalesce(d.course || ' — ', '') || d.item,
         coalesce('Due ' || d.due_time, ''), './#deadlines', 'deadline', null,
         ((d.due_date - 2) + time '08:00') at time zone (select z from tz)
  from deadlines d where (select deadline from p) and d.status = 'open'
  union all
  -- deadline: morning of, 07:00
  select 'dl0:' || d.id || ':' || d.due_date,
         '🚨 Due today: ' || coalesce(d.course || ' — ', '') || d.item,
         coalesce('Due ' || d.due_time, ''), './#deadlines', 'deadline', null,
         (d.due_date + time '07:00') at time zone (select z from tz)
  from deadlines d where (select deadline from p) and d.status = 'open'
  union all
  -- evening check-in, only if something is still unmarked
  select 'eve:' || (select d from today),
         '🌙 Mark today''s tasks',
         n || ' task(s) still unmarked. Tap to check them off.', './#week', 'evening', null,
         ((select d from today) + (select evening_time from p)) at time zone (select z from tz)
  from (select count(*) as n from tasks
        where date = (select d from today) and status = 'todo'
          and kind not in ('prayer','fixed')) c
  where (select evening from p) and c.n > 0
  union all
  -- queued (morning summary / test / info)
  select 'q:' || q.id, q.title, coalesce(q.body, ''), coalesce(q.url, './'), q.kind, q.id,
         q.send_at
  from notifications q
  where q.sent_at is null and (q.kind <> 'morning' or (select morning from p))
)
select c.key, c.title, c.body, c.url, c.tag, c.queue_id
from cands c
where c.fire_at <= now()
  and c.fire_at > now() - case when c.queue_id is null then interval '15 minutes' else interval '6 hours' end
  and not exists (select 1 from notification_log l where l.key = c.key);
$$;
revoke all on function due_notifications() from public, anon, authenticated;
grant execute on function due_notifications() to service_role;
revoke execute on function is_owner() from public, anon;
revoke execute on function public_config() from public, anon;
grant execute on function is_owner() to authenticated;
grant execute on function public_config() to authenticated;

-- run the dispatcher every minute
select cron.unschedule(jobid) from cron.job where jobname = 'push-dispatch';
select cron.schedule('push-dispatch', '* * * * *', $$
  select net.http_post(
    url     := (select value from public.app_config where key = 'dispatch_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
               'x-dispatch-secret', (select value from public.app_config where key = 'dispatch_secret')),
    body    := '{}'::jsonb)
  where exists (select 1 from public.app_config where key = 'dispatch_url');
$$);

-- housekeeping: drop old log entries and sent queue rows weekly
select cron.unschedule(jobid) from cron.job where jobname = 'push-cleanup';
select cron.schedule('push-cleanup', '0 4 * * 0', $$
  delete from public.notification_log where sent_at < now() - interval '30 days';
  delete from public.notifications where sent_at < now() - interval '30 days';
$$);
