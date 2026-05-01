-- 儲存 PWA 跨裝置登入用的短效驗證碼
CREATE TABLE IF NOT EXISTS public.pwa_auth_codes (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    code text NOT NULL,
    session_data jsonb NOT NULL, -- 儲存 token, member_id, line_info 等
    tenant_id uuid NOT NULL,
    created_at timestamptz DEFAULT now(),
    expires_at timestamptz NOT NULL
);

-- 建立索引加速查詢
CREATE INDEX IF NOT EXISTS idx_pwa_auth_codes_code ON public.pwa_auth_codes(code);

-- 設定 RLS (只允許 service_role 讀寫)
ALTER TABLE public.pwa_auth_codes ENABLE ROW LEVEL SECURITY;
