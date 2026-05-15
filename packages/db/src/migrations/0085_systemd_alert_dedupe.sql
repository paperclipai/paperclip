-- Anti-dupe alerting: один тикет на systemd unit failure
-- Constraint: уникальный (companyId, originFingerprint) для открытых systemd_alert issues

-- DropIndex: если существует
DROP INDEX IF EXISTS issues_active_systemd_alert_incident_uq;

-- CreateIndex: уникальный индекс для systemd_alert дедупликации
-- Один открытый тикет per unit+service combination
CREATE UNIQUE INDEX issues_active_systemd_alert_incident_uq
  ON issues (company_id, origin_fingerprint)
  WHERE
    origin_kind = 'systemd_alert'
    AND hidden_at IS NULL
    AND status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');

-- Comment для документации
COMMENT ON INDEX issues_active_systemd_alert_incident_uq IS 'Prevents duplicate systemd unit alert issues - one open ticket per unit+service fingerprint';
