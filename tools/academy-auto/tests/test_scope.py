from academy_auto.config import Config
from academy_auto.scope import check_scope


def test_clean_fileset_passes():
    cfg = Config.default()
    res = check_scope(cfg, ["src/App.tsx", "src/lib/util.ts", "tests/util.test.ts"])
    assert res.ok is True
    assert res.violations == []


def test_env_file_is_violation():
    cfg = Config.default()
    res = check_scope(cfg, ["src/App.tsx", ".env"])
    assert res.ok is False
    assert ".env" in res.violations


def test_nested_env_and_secrets_are_violations():
    cfg = Config.default()
    res = check_scope(cfg, ["config/.env.production", "ios/cert.p12", "src/App.tsx"])
    assert res.ok is False
    assert "config/.env.production" in res.violations
    assert "ios/cert.p12" in res.violations
    assert "src/App.tsx" not in res.violations


def test_supabase_migration_is_violation():
    cfg = Config.default()
    res = check_scope(cfg, ["supabase/migrations/003_add_users.sql"])
    assert res.ok is False
    assert "supabase/migrations/003_add_users.sql" in res.violations


def test_config_default_has_denied_globs():
    cfg = Config.default()
    assert ".env" in cfg.denied_globs
    assert "supabase/migrations/*" in cfg.denied_globs
    assert "*.p12" in cfg.denied_globs
