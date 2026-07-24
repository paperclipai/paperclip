CREATE TABLE plugin_billing_d8ffbbf605.billing_customers (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_id text NOT NULL,
  has_default_payment_method boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, user_id)
);

CREATE TABLE plugin_billing_d8ffbbf605.subscriptions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  customer_id uuid REFERENCES plugin_billing_d8ffbbf605.billing_customers(id),
  status text NOT NULL CHECK (status IN ('trialing','awaiting_payment','active','grace','blocked','canceled','complimentary')),
  trial_ends_at timestamptz,
  grace_since timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  price_cents_override integer,
  provider_subscription_id text,
  open_checkout_session_ref text,
  open_checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_provider_sub_idx
  ON plugin_billing_d8ffbbf605.subscriptions (provider_subscription_id);

CREATE INDEX subscriptions_open_session_idx
  ON plugin_billing_d8ffbbf605.subscriptions (open_checkout_session_ref);

CREATE TABLE plugin_billing_d8ffbbf605.billing_events (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  type text NOT NULL,
  subscription_id uuid REFERENCES plugin_billing_d8ffbbf605.subscriptions(id),
  company_id uuid,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_events_company_idx
  ON plugin_billing_d8ffbbf605.billing_events (company_id, created_at DESC);

CREATE INDEX billing_events_unapplied_idx
  ON plugin_billing_d8ffbbf605.billing_events (created_at)
  WHERE applied_at IS NULL;

CREATE INDEX billing_events_trial_owner_idx
  ON plugin_billing_d8ffbbf605.billing_events ((raw_payload->>'ownerUserId'))
  WHERE type = 'trial.started';
