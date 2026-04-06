ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS invited_by UUID;
ALTER TABLE company_memberships ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS user_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_activity_company ON user_activity_log(company_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_user ON user_activity_log(user_id);
