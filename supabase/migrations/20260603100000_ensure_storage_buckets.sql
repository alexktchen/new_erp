-- ============================================================
-- 確保 products / member-avatars buckets 已建立
-- 先前 20260424120002 / 20260425140000 雖記錄為 applied,
-- 但 Supabase managed DB 上 storage.buckets 沒實際 row
-- (可能是 schema 權限導致 INSERT 被靜默 skip)
-- 這個 migration 補建。
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'products', 'products', TRUE, 5242880,
  ARRAY['image/png','image/jpeg','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'member-avatars', 'member-avatars', TRUE, 2097152,  -- 2 MB
  ARRAY['image/png','image/jpeg','image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
