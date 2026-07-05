-- Phase 2: 初期データ投入
-- plans（free プラン。MVP は全ユーザー free、参加人数上限は実質無制限として扱う想定）

insert into public.plans (id, max_participants)
values ('free', 2)
on conflict (id) do nothing;
