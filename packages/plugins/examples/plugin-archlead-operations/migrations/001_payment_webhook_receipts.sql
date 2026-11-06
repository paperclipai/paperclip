CREATE TABLE plugin_archlead_operations_2da229a791.payment_webhook_receipts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  provider text NOT NULL,
  resource_id text NOT NULL,
  payment_status text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_id)
);

CREATE INDEX payment_webhook_receipts_company_received_idx
  ON plugin_archlead_operations_2da229a791.payment_webhook_receipts (company_id, received_at DESC);
