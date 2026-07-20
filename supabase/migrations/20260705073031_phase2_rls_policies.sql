-- Phase 2: RLS policies for auth/room tables (bd-882)
-- Tables were created with RLS enabled (fail-safe deny) in
-- 20260705063916_phase2_auth_room.sql. This migration adds the actual
-- policies per docs/design/supabase-design.md ポリシー方針表.
--
-- Design principle: guest-related writes (participants creation, invites
-- issuance) go through the WS server / Route Handlers using the
-- service_role key, which bypasses RLS. Therefore anon/authenticated
-- roles are NOT granted insert/update/delete on participants/invites here
-- (see docs/design/supabase-design.md §D-11, service_role の使用箇所).
--
-- Note: このプロジェクトの config.toml では `auto_expose_new_tables` が
-- 未設定（= false 相当、クラウドの新デフォルト）のため、RLS ポリシーとは別に
-- テーブルへの GRANT が無いと anon/authenticated から一切アクセスできない
-- （"permission denied for table ..." になる）。ポリシーで許可する操作の
-- GRANT をテーブルごとに明示する。GRANT はテーブルレベルの許可、RLS ポリシーは
-- 行レベルの絞り込みであり、両方が必要。

grant usage on schema public to anon, authenticated;

-- ============================================================
-- user_profiles
-- ============================================================

-- 本人のプロフィールのみ参照可能
create policy "user_profiles_select_own" on public.user_profiles
  for select
  to authenticated
  using (id = auth.uid());

-- 本人のプロフィールのみ更新可能
create policy "user_profiles_update_own" on public.user_profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- insert は handle_new_user トリガー（security definer, RLSバイパス）のみ。
-- anon/authenticated への insert ポリシーは意図的に作成しない。

grant select, update on public.user_profiles to authenticated;

-- ============================================================
-- plans
-- ============================================================

-- 全ユーザー（未ログイン含む）が参照可能。書き込みは不可（seed/service_roleのみ）。
create policy "plans_select_all" on public.plans
  for select
  to anon, authenticated
  using (true);

-- insert/update/delete のポリシーは作成しない（=誰も操作不可。service_roleはRLSバイパスでseed投入可能）。

grant select on public.plans to anon, authenticated;

-- ============================================================
-- rooms
-- ============================================================

-- 自分がオーナーのルームのみ参照可能
create policy "rooms_select_own" on public.rooms
  for select
  to authenticated
  using (owner_user_id = auth.uid());

-- 自分をオーナーとしてのみルーム作成可能
create policy "rooms_insert_own" on public.rooms
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

-- 自分がオーナーのルームのみ更新可能（オーナー変更は不可）
create policy "rooms_update_own" on public.rooms
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- 自分がオーナーのルームのみ削除可能
create policy "rooms_delete_own" on public.rooms
  for delete
  to authenticated
  using (owner_user_id = auth.uid());

grant select, insert, update, delete on public.rooms to authenticated;

-- ============================================================
-- participants
-- ============================================================

-- 所属ルームのオーナー本人のみ参照可能（ゲストはservice_role経由でWSサーバーが参照）
create policy "participants_select_room_owner" on public.participants
  for select
  to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.id = participants.room_id
        and r.owner_user_id = auth.uid()
    )
  );

-- insert/update/delete のポリシーは作成しない
-- （ゲスト参加登録・在室状態更新はすべて service_role 経由、D-11 参照）。

-- select のみ GRANT する（insert/update/delete は GRANT しない。
-- 万一ポリシーを追加し忘れても GRANT が無ければ書き込みは失敗するため、
-- deny-by-default を二重に担保する）。
grant select on public.participants to authenticated;

-- ============================================================
-- invites
-- ============================================================

-- 自分がオーナーのルームに紐づく招待のみ参照可能
create policy "invites_select_room_owner" on public.invites
  for select
  to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.id = invites.room_id
        and r.owner_user_id = auth.uid()
    )
  );

-- 自分がオーナーのルームに対してのみ招待を作成可能
create policy "invites_insert_room_owner" on public.invites
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.rooms r
      where r.id = invites.room_id
        and r.owner_user_id = auth.uid()
    )
  );

-- 自分がオーナーのルームに紐づく招待のみ更新可能
create policy "invites_update_room_owner" on public.invites
  for update
  to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.id = invites.room_id
        and r.owner_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.rooms r
      where r.id = invites.room_id
        and r.owner_user_id = auth.uid()
    )
  );

-- 自分がオーナーのルームに紐づく招待のみ削除可能
create policy "invites_delete_room_owner" on public.invites
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.id = invites.room_id
        and r.owner_user_id = auth.uid()
    )
  );

-- 匿名ロール（/join/[token] の token 照合）は Route Handler / Server Component が
-- service_role 相当で行う方針のため、anon への select ポリシーは付与しない
-- （docs/design/supabase-design.md「invites.token による参照は...匿名ロールに開放しない」）。

grant select, insert, update, delete on public.invites to authenticated;
