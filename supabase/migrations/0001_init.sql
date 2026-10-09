-- Aangan Studio phone-enquiry system — Supabase schema (ADDITIVE ONLY).
--
-- This project is SHARED with other apps (a movie-picker app and a "kargo" recruiting app). This migration:
--   * only CREATEs new tables, all named aangan_*   (no existing table is altered, renamed, dropped or read)
--   * names every column with an `aan_` prefix, so no column name matches any existing column in the database
--   * touches privileges/RLS ONLY on its own aangan_* tables
-- Safe to re-run (IF NOT EXISTS everywhere). To undo: drop table public.aangan_calls, ... (list at the bottom).
--
-- Design: each table keeps the full record as JSONB in aan_data (the application owns the shape and it will change),
-- plus a few typed columns you can filter/sort on in the Supabase table editor or SQL.
--
-- SECURITY: these tables hold caller phone numbers and conversation transcripts (personal data).
--   * Row Level Security is ENABLED with NO policies → the public anon/publishable key and logged-in users can read/write NOTHING.
--   * Only the server, using the SECRET / service-role key (which bypasses RLS), can access them.
--   * NEVER put the secret key in a browser, a front-end, or a public repo. Keep it in .env on the server only.

create table if not exists public.aangan_calls (
  aan_id            text primary key,
  aan_source        text not null check (aan_source in ('live', 'seed')),
  aan_vani_call_id  text,
  aan_phone         text,
  aan_status        text,
  aan_tier          text,
  aan_started_at    timestamptz,
  aan_data          jsonb not null,
  aan_updated_at    timestamptz not null default now()
);

create table if not exists public.aangan_enquiries (
  aan_id            text primary key,
  aan_source        text not null check (aan_source in ('live', 'seed')),
  aan_phone         text,
  aan_tier          text check (aan_tier in ('green', 'amber', 'red', 'escalate')),
  aan_status        text,
  aan_created_at    timestamptz,
  aan_data          jsonb not null,
  aan_updated_at    timestamptz not null default now()
);

create table if not exists public.aangan_events (
  aan_id            text primary key,
  aan_type          text not null,
  aan_at            timestamptz,
  aan_data          jsonb not null
);

create table if not exists public.aangan_outbox (        -- every Telegram / email / HubSpot / Vani action (dry-run or live)
  aan_id            text primary key,
  aan_channel       text not null,
  aan_enquiry_id    text,
  aan_at            timestamptz,
  aan_data          jsonb not null
);

create table if not exists public.aangan_callbacks (
  aan_id            text primary key,
  aan_enquiry_id    text,
  aan_due_at        timestamptz,
  aan_status        text,
  aan_data          jsonb not null
);

create table if not exists public.aangan_reviews (       -- Red spot-check verdicts from the dashboard
  aan_enquiry_id    text primary key,
  aan_verdict       text not null check (aan_verdict in ('ok', 'too_strict')),
  aan_at            timestamptz,
  aan_data          jsonb not null
);

create index if not exists aangan_calls_phone_idx       on public.aangan_calls (aan_phone);
create index if not exists aangan_calls_vaani_idx       on public.aangan_calls (aan_vani_call_id);
create index if not exists aangan_calls_started_idx     on public.aangan_calls (aan_started_at desc);
create index if not exists aangan_enquiries_phone_idx   on public.aangan_enquiries (aan_phone);
create index if not exists aangan_enquiries_tier_idx    on public.aangan_enquiries (aan_tier, aan_updated_at desc);
create index if not exists aangan_events_type_idx       on public.aangan_events (aan_type, aan_at desc);
create index if not exists aangan_callbacks_due_idx     on public.aangan_callbacks (aan_status, aan_due_at);

alter table public.aangan_calls      enable row level security;
alter table public.aangan_enquiries  enable row level security;
alter table public.aangan_events     enable row level security;
alter table public.aangan_outbox     enable row level security;
alter table public.aangan_callbacks  enable row level security;
alter table public.aangan_reviews    enable row level security;

-- Belt and braces: even if someone later adds a permissive policy by mistake, anon/authenticated have no privileges on OUR tables.
revoke all on public.aangan_calls, public.aangan_enquiries, public.aangan_events,
              public.aangan_outbox, public.aangan_callbacks, public.aangan_reviews
  from anon, authenticated;

-- Make the REST API pick up the new tables immediately.
notify pgrst, 'reload schema';

-- UNDO (only our objects):
--   drop table if exists public.aangan_calls, public.aangan_enquiries, public.aangan_events,
--                        public.aangan_outbox, public.aangan_callbacks, public.aangan_reviews;
