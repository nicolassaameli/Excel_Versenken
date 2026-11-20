-- =====================================================================
--  Zellen versenken – Supabase-Schema
--  Im Supabase-Dashboard unter "SQL Editor" komplett ausführen.
--
--  Sicherheitskonzept:
--   * Die Tabelle "games" ist öffentlich lesbar (nur Namen, Status, Zug).
--     Sie ist für Realtime freigegeben – jede Änderung weckt die Clients.
--   * "players" (Schiffe + geheime Tokens) und "shots" sind NICHT direkt
--     lesbar. Alles läuft über SECURITY-DEFINER-Funktionen, die den
--     Spieler-Token prüfen. So kann niemand die gegnerische Flotte auslesen.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Tabellen
-- ---------------------------------------------------------------------
create table if not exists public.games (
  code        text primary key,
  status      text not null default 'waiting'
              check (status in ('waiting', 'placing', 'playing', 'finished')),
  p1_name     text not null,
  p2_name     text,
  p1_ready    boolean not null default false,
  p2_ready    boolean not null default false,
  turn        smallint check (turn in (1, 2)),
  winner      smallint check (winner in (1, 2)),
  resigned    boolean not null default false,
  shots_count integer not null default 0,
  scans_count integer not null default 0,
  last_scan   jsonb,                                     -- {seat, r, c} der letzten SUCHEN-Formel (ohne Ergebnis)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Für bestehende Installationen (Schema erneut ausführen genügt)
alter table public.games add column if not exists scans_count integer not null default 0;
alter table public.games add column if not exists last_scan jsonb;

create table if not exists public.players (
  code   text not null references public.games(code) on delete cascade,
  seat   smallint not null check (seat in (1, 2)),
  token  uuid not null default gen_random_uuid(),
  ships  jsonb,
  primary key (code, seat)
);

create table if not exists public.shots (
  id         bigserial primary key,
  code       text not null references public.games(code) on delete cascade,
  seat       smallint not null check (seat in (1, 2)),   -- wer geschossen hat
  r          smallint not null check (r between 0 and 9),
  c          smallint not null check (c between 0 and 9),
  hit        boolean not null,
  sunk       text,                                       -- Schiffs-ID, falls versenkt
  created_at timestamptz not null default now(),
  unique (code, seat, r, c)
);

create index if not exists shots_code_idx on public.shots (code);

-- ---------------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------------
alter table public.games   enable row level security;
alter table public.players enable row level security;
alter table public.shots   enable row level security;

drop policy if exists "games sind lesbar" on public.games;
create policy "games sind lesbar" on public.games
  for select to anon, authenticated using (true);
-- players / shots: absichtlich KEINE Policies -> kein direkter Zugriff.

-- Realtime für games aktivieren (Fehler ignorieren, falls schon drin)
do $$
begin
  alter publication supabase_realtime add table public.games;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------
--  Hilfsfunktionen (intern)
-- ---------------------------------------------------------------------
create or replace function public._seat(p_code text, p_token uuid)
returns smallint
language sql stable security definer set search_path = public
as $$
  select seat from public.players where code = upper(p_code) and token = p_token
$$;

create or replace function public._ship_covers(p_ship jsonb, p_r int, p_c int)
returns boolean
language sql immutable
as $$
  select case when p_ship->>'dir' = 'h'
    then p_r = (p_ship->>'r')::int
         and p_c between (p_ship->>'c')::int and (p_ship->>'c')::int + (p_ship->>'len')::int - 1
    else p_c = (p_ship->>'c')::int
         and p_r between (p_ship->>'r')::int and (p_ship->>'r')::int + (p_ship->>'len')::int - 1
  end
$$;

revoke execute on function public._seat(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
--  Spiel erstellen
-- ---------------------------------------------------------------------
create or replace function public.create_game(p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_code  text;
  v_token uuid;
  v_name  text := coalesce(nullif(left(trim(p_name), 24), ''), 'Spieler 1');
  i int;
begin
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;

  insert into public.games (code, p1_name) values (v_code, v_name);
  insert into public.players (code, seat) values (v_code, 1) returning token into v_token;

  return jsonb_build_object('code', v_code, 'token', v_token, 'seat', 1);
end $$;

-- ---------------------------------------------------------------------
--  Spiel beitreten
-- ---------------------------------------------------------------------
create or replace function public.join_game(p_code text, p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  g public.games;
  v_token uuid;
  v_name text := coalesce(nullif(left(trim(p_name), 24), ''), 'Spieler 2');
begin
  select * into g from public.games where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Spiel % nicht gefunden.', upper(trim(p_code)); end if;
  if g.p2_name is not null then raise exception 'Dieses Spiel ist bereits voll.'; end if;

  update public.games
     set p2_name = v_name,
         status = 'placing',
         updated_at = now()
   where code = g.code;
  insert into public.players (code, seat) values (g.code, 2) returning token into v_token;

  return jsonb_build_object('code', g.code, 'token', v_token, 'seat', 2);
end $$;

-- ---------------------------------------------------------------------
--  Flotte abgeben (wird serverseitig geprüft)
-- ---------------------------------------------------------------------
create or replace function public.submit_ships(p_code text, p_token uuid, p_ships jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_seat smallint := public._seat(p_code, p_token);
  g public.games;
  v_ids text[];
  v_bad int;
  v_cells int;
  v_distinct int;
begin
  if v_seat is null then raise exception 'Ungültige Sitzung.'; end if;
  select * into g from public.games where code = upper(p_code) for update;
  if g.status not in ('waiting', 'placing') then raise exception 'Die Flotte kann nicht mehr geändert werden.'; end if;
  if (v_seat = 1 and g.p1_ready) or (v_seat = 2 and g.p2_ready) then raise exception 'Flotte wurde bereits abgegeben.'; end if;

  if jsonb_typeof(p_ships) <> 'array' or jsonb_array_length(p_ships) <> 5 then
    raise exception 'Ungültige Flotte.';
  end if;

  -- genau diese Schiffe mit genau diesen Längen
  select array_agg((s->>'id') || ':' || (s->>'len') order by s->>'id')
    into v_ids from jsonb_array_elements(p_ships) s;
  if v_ids <> array['kreuzer:3', 'schlachtschiff:4', 'traeger:5', 'uboot:3', 'zerstoerer:2'] then
    raise exception 'Ungültige Flotte (Schiffstypen).';
  end if;

  -- Richtung, Grenzen, Überlappung
  select count(*) into v_bad from jsonb_array_elements(p_ships) s
   where s->>'dir' not in ('h', 'v')
      or (s->>'r')::int < 0 or (s->>'c')::int < 0
      or (s->>'dir' = 'h' and ((s->>'r')::int > 9 or (s->>'c')::int + (s->>'len')::int > 10))
      or (s->>'dir' = 'v' and ((s->>'c')::int > 9 or (s->>'r')::int + (s->>'len')::int > 10));
  if v_bad > 0 then raise exception 'Ein Schiff liegt ausserhalb des Spielfelds.'; end if;

  select count(*), count(distinct (rr, cc)) into v_cells, v_distinct from (
    select case when s->>'dir' = 'h' then (s->>'r')::int else (s->>'r')::int + i end as rr,
           case when s->>'dir' = 'h' then (s->>'c')::int + i else (s->>'c')::int end as cc
      from jsonb_array_elements(p_ships) s,
           generate_series(0, (s->>'len')::int - 1) i
  ) x;
  if v_cells <> v_distinct then raise exception 'Schiffe dürfen sich nicht überlappen.'; end if;

  update public.players set ships = p_ships where code = g.code and seat = v_seat;

  if v_seat = 1 then g.p1_ready := true; else g.p2_ready := true; end if;

  update public.games
     set p1_ready = g.p1_ready,
         p2_ready = g.p2_ready,
         status = case when g.p1_ready and g.p2_ready then 'playing' else status end,
         turn   = case when g.p1_ready and g.p2_ready then (1 + floor(random() * 2))::smallint else turn end,
         updated_at = now()
   where code = g.code;

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
--  Schiessen
--  Regel: Bei einem Treffer darf man nochmals schiessen.
-- ---------------------------------------------------------------------
create or replace function public.fire(p_code text, p_token uuid, p_r int, p_c int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_seat smallint := public._seat(p_code, p_token);
  v_opp smallint;
  g public.games;
  v_ships jsonb;
  v_ship jsonb;
  v_hit_ship jsonb;
  v_hit boolean := false;
  v_sunk text;
  v_hits int;
  v_total int;
  v_needed int;
  v_win boolean := false;
begin
  if v_seat is null then raise exception 'Ungültige Sitzung.'; end if;
  select * into g from public.games where code = upper(p_code) for update;
  if g.status <> 'playing' then raise exception 'Das Spiel läuft nicht.'; end if;
  if g.turn <> v_seat then raise exception 'Du bist nicht am Zug.'; end if;
  if p_r not between 0 and 9 or p_c not between 0 and 9 then raise exception 'Ungültige Zelle.'; end if;
  if exists (select 1 from public.shots where code = g.code and seat = v_seat and r = p_r and c = p_c) then
    raise exception 'Auf diese Zelle hast du schon geschossen.';
  end if;

  v_opp := 3 - v_seat;
  select ships into v_ships from public.players where code = g.code and seat = v_opp;

  for v_ship in select * from jsonb_array_elements(v_ships) loop
    if public._ship_covers(v_ship, p_r, p_c) then
      v_hit := true;
      v_hit_ship := v_ship;
      exit;
    end if;
  end loop;

  insert into public.shots (code, seat, r, c, hit) values (g.code, v_seat, p_r, p_c, v_hit);

  if v_hit then
    select count(*) into v_hits from public.shots s
     where s.code = g.code and s.seat = v_seat and s.hit and public._ship_covers(v_hit_ship, s.r, s.c);
    if v_hits = (v_hit_ship->>'len')::int then
      v_sunk := v_hit_ship->>'id';
      update public.shots set sunk = v_sunk
       where code = g.code and seat = v_seat and r = p_r and c = p_c;
    end if;

    select count(*) into v_total from public.shots where code = g.code and seat = v_seat and hit;
    select sum((s->>'len')::int) into v_needed from jsonb_array_elements(v_ships) s;
    v_win := v_total >= v_needed;
  end if;

  update public.games
     set turn = case when v_hit then v_seat else v_opp end,
         status = case when v_win then 'finished' else status end,
         winner = case when v_win then v_seat else winner end,
         shots_count = shots_count + 1,
         updated_at = now()
   where code = g.code;

  return jsonb_build_object('hit', v_hit, 'sunk', v_sunk, 'win', v_win);
end $$;

-- ---------------------------------------------------------------------
--  Suchen: =SUCHEN(Q8:R9) prüft 2x2 Zellen auf Schiffe.
--  Das Ergebnis wird nur zurückgegeben, nicht gespeichert – der Client
--  zeigt es kurz an. Die Suche verbraucht den Zug.
-- ---------------------------------------------------------------------
create or replace function public.scan(p_code text, p_token uuid, p_r int, p_c int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_seat smallint := public._seat(p_code, p_token);
  v_opp smallint;
  g public.games;
  v_ships jsonb;
  v_cells jsonb;
begin
  if v_seat is null then raise exception 'Ungültige Sitzung.'; end if;
  select * into g from public.games where code = upper(p_code) for update;
  if g.status <> 'playing' then raise exception 'Das Spiel läuft nicht.'; end if;
  if g.turn <> v_seat then raise exception 'Du bist nicht am Zug.'; end if;
  if p_r not between 0 and 8 or p_c not between 0 and 8 then raise exception 'Ungültiger Suchbereich.'; end if;

  v_opp := 3 - v_seat;
  select ships into v_ships from public.players where code = g.code and seat = v_opp;

  select jsonb_agg(jsonb_build_object(
           'r', p_r + d.dr, 'c', p_c + d.dc,
           'ship', exists (select 1 from jsonb_array_elements(v_ships) s
                            where public._ship_covers(s, p_r + d.dr, p_c + d.dc))))
    into v_cells
    from (values (0, 0), (0, 1), (1, 0), (1, 1)) as d(dr, dc);

  update public.games
     set turn = v_opp,
         scans_count = scans_count + 1,
         last_scan = jsonb_build_object('seat', v_seat, 'r', p_r, 'c', p_c),
         updated_at = now()
   where code = g.code;

  return jsonb_build_object('cells', v_cells);
end $$;

-- ---------------------------------------------------------------------
--  Aufgeben
-- ---------------------------------------------------------------------
create or replace function public.resign(p_code text, p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_seat smallint := public._seat(p_code, p_token);
begin
  if v_seat is null then raise exception 'Ungültige Sitzung.'; end if;
  update public.games
     set status = 'finished', winner = 3 - v_seat, resigned = true, updated_at = now()
   where code = upper(p_code) and status <> 'finished';
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
--  Spielstand aus Sicht eines Spielers
-- ---------------------------------------------------------------------
create or replace function public.get_state(p_code text, p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_seat smallint := public._seat(p_code, p_token);
  v_opp smallint;
  g public.games;
  v_my jsonb;
  v_opp_ships jsonb;
begin
  if v_seat is null then raise exception 'Ungültige Sitzung.'; end if;
  select * into g from public.games where code = upper(p_code);
  v_opp := 3 - v_seat;
  select ships into v_my        from public.players where code = g.code and seat = v_seat;
  select ships into v_opp_ships from public.players where code = g.code and seat = v_opp;

  return jsonb_build_object(
    'game', to_jsonb(g),
    'seat', v_seat,
    'my_ships', coalesce(v_my, '[]'::jsonb),
    'my_shots', coalesce((
        select jsonb_agg(jsonb_build_object('id', id, 'r', r, 'c', c, 'hit', hit, 'sunk', sunk, 't', created_at) order by id)
          from public.shots where code = g.code and seat = v_seat), '[]'::jsonb),
    'opp_shots', coalesce((
        select jsonb_agg(jsonb_build_object('id', id, 'r', r, 'c', c, 'hit', hit, 'sunk', sunk, 't', created_at) order by id)
          from public.shots where code = g.code and seat = v_opp), '[]'::jsonb),
    -- versenkte gegnerische Schiffe; nach Spielende die ganze Flotte
    'opp_ships', coalesce((
        select jsonb_agg(s) from jsonb_array_elements(coalesce(v_opp_ships, '[]'::jsonb)) s
         where g.status = 'finished'
            or (s->>'id') in (select sunk from public.shots
                               where code = g.code and seat = v_seat and sunk is not null)), '[]'::jsonb)
  );
end $$;

grant execute on function public.create_game(text)              to anon, authenticated;
grant execute on function public.join_game(text, text)          to anon, authenticated;
grant execute on function public.submit_ships(text, uuid, jsonb) to anon, authenticated;
grant execute on function public.fire(text, uuid, int, int)     to anon, authenticated;
grant execute on function public.scan(text, uuid, int, int)     to anon, authenticated;
grant execute on function public.resign(text, uuid)             to anon, authenticated;
grant execute on function public.get_state(text, uuid)          to anon, authenticated;

-- ---------------------------------------------------------------------
--  Optional: alte Spiele aufräumen (z. B. per pg_cron täglich)
--    select cron.schedule('cleanup-games', '0 3 * * *',
--      $$ delete from public.games where updated_at < now() - interval '2 days' $$);
-- ---------------------------------------------------------------------
