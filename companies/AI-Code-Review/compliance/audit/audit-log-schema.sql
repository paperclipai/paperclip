-- Immutable audit log for admin actions
-- Stored in dedicated schema to enforce append-only via privileges

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.log (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id        UUID NOT NULL,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key')),
    org_id          UUID NOT NULL,
    action          TEXT NOT NULL,
    resource_type   TEXT NOT NULL,
    resource_id     TEXT,
    details         JSONB,
    ip_address      INET,
    user_agent      TEXT
);

-- Index for common queries
CREATE INDEX idx_audit_log_org_id ON audit.log (org_id, occurred_at DESC);
CREATE INDEX idx_audit_log_actor ON audit.log (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_log_action ON audit.log (action);

-- Revoke all write privileges from application roles
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON audit.log FROM codereview_app;

-- Grant read-only access
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO codereview_app;

-- Function for append-only writes via security definer
CREATE OR REPLACE FUNCTION audit.write_entry(
    p_actor_id UUID,
    p_actor_type TEXT,
    p_org_id UUID,
    p_action TEXT,
    p_resource_type TEXT,
    p_resource_id TEXT DEFAULT NULL,
    p_details JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit
AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO audit.log (
        actor_id, actor_type, org_id, action,
        resource_type, resource_id, details,
        ip_address, user_agent
    ) VALUES (
        p_actor_id, p_actor_type, p_org_id, p_action,
        p_resource_type, p_resource_id, p_details,
        p_ip_address, p_user_agent
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Grant execute on function
GRANT EXECUTE ON FUNCTION audit.write_entry TO codereview_app;
