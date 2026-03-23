-- Token Optimization Migration — 2026-03-23
-- Çalıştırma: psql "postgres://paperclip:paperclip@localhost:54329/paperclip" -f scripts/token-optimization-migration.sql
-- ÖNEMLİ: Server açıkken çalıştırılmalı (DB bağlantısı gerekli)

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FAZ 2C: Timer heartbeat'lerde ucuz model kullan (Haiku)
-- CEO/CTO hariç tüm Claude agent'lar timer heartbeat'te Haiku kullanacak
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'model', 'claude-haiku-4-5-20251001'
  )
)
WHERE adapter_type = 'claude_local'
  AND role NOT IN ('ceo', 'cto', 'coo', 'security');

-- ═══════════════════════════════════════════════════════════════════════════════
-- FAZ 3A: Agent Tiering — Heartbeat interval'leri güncelle
-- ═══════════════════════════════════════════════════════════════════════════════

-- Tier: Kritik (10 dakika) — CEO, CTO, COO, güvenlik
UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'intervalSec', 600
  )
)
WHERE adapter_type = 'claude_local'
  AND role IN ('ceo', 'cto', 'coo', 'security');

-- Tier: Standart (1 saat) — aktif developer'lar
UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'intervalSec', 3600
  )
)
WHERE adapter_type = 'claude_local'
  AND role NOT IN ('ceo', 'cto', 'coo', 'security')
  AND (last_heartbeat_at IS NULL OR last_heartbeat_at > NOW() - INTERVAL '7 days');

-- Tier: Düşük (24 saat) — 7+ gün inaktif
UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'intervalSec', 86400
  )
)
WHERE adapter_type = 'claude_local'
  AND role NOT IN ('ceo', 'cto', 'coo', 'security')
  AND last_heartbeat_at IS NOT NULL
  AND last_heartbeat_at < NOW() - INTERVAL '7 days'
  AND last_heartbeat_at > NOW() - INTERVAL '30 days';

-- Tier: Duraklat — 30+ gün inaktif
UPDATE agents
SET status = 'paused', pause_reason = 'budget'
WHERE adapter_type = 'claude_local'
  AND last_heartbeat_at IS NOT NULL
  AND last_heartbeat_at < NOW() - INTERVAL '30 days'
  AND status != 'paused';

-- ═══════════════════════════════════════════════════════════════════════════════
-- FAZ 4A: Pending-task skip — tüm Claude agent'larda aktifleştir
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'skipIfNoPendingTasks', true
  )
)
WHERE adapter_type = 'claude_local';

-- ═══════════════════════════════════════════════════════════════════════════════
-- CEO agent'a vault injection izni ver
-- ═══════════════════════════════════════════════════════════════════════════════

UPDATE agents
SET runtime_config = COALESCE(runtime_config, '{}'::jsonb) || jsonb_build_object(
  'heartbeat', COALESCE(runtime_config->'heartbeat', '{}'::jsonb) || jsonb_build_object(
    'injectVaultSnapshot', true
  )
)
WHERE role IN ('ceo', 'cto');

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROL BAZLI SKILL ALLOWLIST — 14+ firma, 225+ agent
-- Her rolün sadece ihtiyacı olan skill'lere erişimi olacak
-- ═══════════════════════════════════════════════════════════════════════════════

-- CEO: core + create-agent + para-memory
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent","paperclipai/paperclip/para-memory-files"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent","paperclipai/paperclip/para-memory-files"]'::jsonb
  )
WHERE role = 'ceo' AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- CTO: core + create-agent + create-plugin
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent","paperclipai/paperclip/paperclip-create-plugin"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent","paperclipai/paperclip/paperclip-create-plugin"]'::jsonb
  )
WHERE role = 'cto' AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- COO: core + create-agent
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-agent"]'::jsonb
  )
WHERE role IN ('coo','project_lead') AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- Engineer: core + create-plugin
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-plugin"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-plugin"]'::jsonb
  )
WHERE role IN ('engineer','backend_engineer','frontend_engineer','lead_engineer','mobile_engineer','security')
  AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- DevOps: core + create-plugin
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-plugin"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/paperclip-create-plugin"]'::jsonb
  )
WHERE role = 'devops' AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- Researcher: core + para-memory
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip","paperclipai/paperclip/para-memory-files"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip","paperclipai/paperclip/para-memory-files"]'::jsonb
  )
WHERE role = 'researcher' AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- Diğer tüm roller (cmo, cfo, designer, pm, qa, general) — sadece core
UPDATE agents SET
  runtime_config = jsonb_set(
    COALESCE(runtime_config, '{}'::jsonb),
    '{skillAllowlist}',
    '{"enabled":true,"allowed":["paperclipai/paperclip/paperclip"],"blocked":[]}'::jsonb
  ),
  adapter_config = jsonb_set(
    COALESCE(adapter_config, '{}'::jsonb),
    '{paperclipSkillSync,desiredSkills}',
    '["paperclipai/paperclip/paperclip"]'::jsonb
  )
WHERE role NOT IN ('ceo','cto','coo','project_lead','engineer','backend_engineer','frontend_engineer','lead_engineer','mobile_engineer','security','devops','researcher')
  AND adapter_type IN ('claude_local','gemini_local','codex_local');

-- ═══════════════════════════════════════════════════════════════════════════════
-- Doğrulama sorguları
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT 'TIER DAĞILIMI' AS report;
SELECT
  CASE
    WHEN role IN ('ceo','cto','coo','security') THEN 'Kritik (10dk)'
    WHEN status = 'paused' AND pause_reason = 'budget' THEN 'Duraklatılmış'
    WHEN (runtime_config->'heartbeat'->>'intervalSec')::int = 86400 THEN 'Düşük (24h)'
    ELSE 'Standart (1h)'
  END AS tier,
  COUNT(*) AS agent_count
FROM agents
WHERE adapter_type = 'claude_local'
GROUP BY 1
ORDER BY 2 DESC;

SELECT 'HAIKU MODEL SAYISI' AS report;
SELECT COUNT(*) AS haiku_timer_agents
FROM agents
WHERE adapter_type = 'claude_local'
  AND runtime_config->'heartbeat'->>'model' = 'claude-haiku-4-5-20251001';

SELECT 'ROL BAZLI SKILL DAĞILIMI' AS report;
SELECT
  role,
  runtime_config->'skillAllowlist'->>'allowed' AS allowed_skills,
  COUNT(*) AS agent_count
FROM agents
WHERE adapter_type IN ('claude_local','gemini_local','codex_local')
  AND runtime_config->'skillAllowlist' IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC;

COMMIT;
