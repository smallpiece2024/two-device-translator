-- bd-e3p コードレビュー指摘（must-fix 2）対応:
-- owner participantId 解決（server/auth/verifyParticipant.ts の
-- resolveOwnerParticipantId）は「select→無ければinsert」の2段階で行うため、
-- 同一 (room_id, user_id, role='owner') に対して短時間に複数の join リクエスト
-- （多重タブでの再接続・ネットワーク再送等）が競合すると、両方が select で
-- 「該当行なし」を確認したうえで、それぞれ insert してしまう TOCTOU
-- （Time-Of-Check-Time-Of-Use）競合が起こり得る。
--
-- その場合 owner の participants 行が room_id+user_id の組で複数存在してしまい、
-- 以後の select が maybeSingle() で「複数行ヒット」エラーとなって owner が
-- 恒久的に join できなくなる（アプリ側の再試行では解消しない）。
--
-- 対策として DB 側に部分一意インデックスを追加し、INSERT 時点で一意制約違反
-- （Postgres エラーコード 23505）として検知できるようにする。アプリ側
-- （resolveOwnerParticipantId）は「insert を試みる→23505 なら select で
-- 既存行を取得し直す」というアトミックなフォールバックに変更する
-- （server/auth/verifyParticipant.ts 参照）。
--
-- guest は participants.user_id が常に NULL のため、この部分インデックス
-- （where role = 'owner'）はguest行には影響しない
-- （db-design.md「role='guest' は guest_cookie_id 非NULL・user_id NULL」）。
create unique index if not exists participants_room_owner_unique_idx
  on public.participants (room_id, user_id)
  where role = 'owner';
