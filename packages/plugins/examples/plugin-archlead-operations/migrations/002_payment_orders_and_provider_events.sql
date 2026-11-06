CREATE TABLE plugin_archlead_operations_2da229a791.payment_orders (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('cashfree', 'paddle')),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  plan_id text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'past_due', 'refunded')),
  provider_order_id text,
  latest_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, external_id)
);

CREATE UNIQUE INDEX payment_orders_provider_order_idx
  ON plugin_archlead_operations_2da229a791.payment_orders (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE plugin_archlead_operations_2da229a791.payment_event_receipts (
  provider text NOT NULL CHECK (provider IN ('cashfree', 'paddle')),
  event_id text NOT NULL,
  company_id uuid NOT NULL,
  order_external_id text NOT NULL,
  provider_resource_id text NOT NULL,
  payment_status text NOT NULL
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'canceled', 'past_due', 'refunded')),
  occurred_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id),
  FOREIGN KEY (company_id, order_external_id)
    REFERENCES plugin_archlead_operations_2da229a791.payment_orders(company_id, external_id)
    ON DELETE CASCADE
);

CREATE INDEX payment_event_receipts_company_received_idx
  ON plugin_archlead_operations_2da229a791.payment_event_receipts (company_id, received_at DESC);
