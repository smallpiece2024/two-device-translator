-- 招待トークンの単回消費化（bd-1oy）
--
-- 背景: invites は expires_at（24h）のみで再利用可能だった。元ゲストが切断した後、
-- 招待URL/QRを入手した第三者が別 participantId でゲスト枠に参加できてしまう
-- （1対1のプライベート会話の前提を崩す）。
--
-- 対策: `used_at` を追加し、`POST /api/guest/join` で
-- `update ... where token = ? and used_at is null and expires_at > now() ...`
-- を1文で実行することで「未使用確認」と「使用済みマーク」を原子化する
-- （src/app/api/guest/join/route.ts 参照）。
--
-- 注記: 同一ゲスト本人の再入室は `gtt_guest` 署名付きクッキー
-- （docs/design/supabase-design.md#ゲストのクッキー識別との連携）で行われ、
-- invite を再度消費しないため、単回消費化による影響はない。
--
-- インデックスは追加しない。`token` は既に unique 制約があり、
-- `used_at is null` の絞り込みはこの unique インデックスで十分高速。
alter table public.invites
  add column used_at timestamptz;

comment on column public.invites.used_at is
  '招待トークンが消費された日時（null = 未使用）。単回消費化のためnull以外は再利用不可（bd-1oy）。';
