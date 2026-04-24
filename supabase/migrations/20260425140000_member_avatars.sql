-- ============================================================================
-- 會員大頭照：從 LINE OAuth 抓下來存 Supabase Storage
-- ============================================================================

-- 1) members 加 avatar_url 欄位
ALTER TABLE members ADD COLUMN IF NOT EXISTS avatar_url TEXT;
COMMENT ON COLUMN members.avatar_url IS '大頭照永久 URL（Supabase Storage 或外部 URL）';

-- 2) 建 storage bucket（public 讀、內部寫）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'member-avatars',
  'member-avatars',
  TRUE,  -- 公開可讀（會員大頭照、無隱私問題）
  2 * 1024 * 1024,  -- 2MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3) 公開可讀
DROP POLICY IF EXISTS member_avatars_public_read ON storage.objects;
CREATE POLICY member_avatars_public_read ON storage.objects
  FOR SELECT USING (bucket_id = 'member-avatars');

-- 4) 只有 service_role 能寫（Edge Function 做）
DROP POLICY IF EXISTS member_avatars_service_write ON storage.objects;
CREATE POLICY member_avatars_service_write ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'member-avatars' AND auth.role() = 'service_role');

DROP POLICY IF EXISTS member_avatars_service_update ON storage.objects;
CREATE POLICY member_avatars_service_update ON storage.objects
  FOR UPDATE USING (bucket_id = 'member-avatars' AND auth.role() = 'service_role');
