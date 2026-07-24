CREATE TABLE plugin_billing_d8ffbbf605.stub_state (
  id integer PRIMARY KEY CHECK (id = 1),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plugin_billing_d8ffbbf605.stub_state (id, state) VALUES (1, '{}'::jsonb);
