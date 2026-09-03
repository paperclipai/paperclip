-- Trust distributions: track disbursements from trusts to beneficiaries
CREATE TYPE distribution_type AS ENUM ('income', 'principal', 'discretionary', 'mandatory');

CREATE TABLE estate_trust_distributions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  trust_id        uuid         NOT NULL REFERENCES estate_trusts(id) ON DELETE CASCADE,
  company_id      uuid         NOT NULL REFERENCES companies(id),
  beneficiary_id  uuid         REFERENCES estate_beneficiaries(id) ON DELETE SET NULL,
  beneficiary_name text,
  amount_cents    integer      NOT NULL CHECK (amount_cents > 0),
  distribution_date date       NOT NULL,
  distribution_type distribution_type NOT NULL DEFAULT 'discretionary',
  description     text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX estate_trust_distributions_trust_idx
  ON estate_trust_distributions (trust_id);

CREATE INDEX estate_trust_distributions_company_idx
  ON estate_trust_distributions (company_id);
