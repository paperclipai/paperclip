CREATE TABLE IF NOT EXISTS crewbrief_waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  organization text,
  source text NOT NULL DEFAULT 'direct',
  referral_code text NOT NULL,
  queue_position integer NOT NULL,
  referral_count integer NOT NULL DEFAULT 0,
  tier text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'waitlisted',
  hubspot_contact_id text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  beta_activated_at timestamp with time zone,
  invited_at timestamp with time zone,
  converted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cb_waitlist_email_idx ON crewbrief_waitlist_entries (email);
CREATE INDEX IF NOT EXISTS cb_waitlist_status_idx ON crewbrief_waitlist_entries (status);
CREATE UNIQUE INDEX IF NOT EXISTS cb_waitlist_ref_code_idx ON crewbrief_waitlist_entries (referral_code);

CREATE TABLE IF NOT EXISTS crewbrief_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES crewbrief_waitlist_entries(id),
  referee_email text NOT NULL,
  referee_id uuid REFERENCES crewbrief_waitlist_entries(id),
  referral_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  converted_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS cb_ref_referrer_idx ON crewbrief_referrals (referrer_id);
CREATE INDEX IF NOT EXISTS cb_ref_referee_email_idx ON crewbrief_referrals (referee_email);

CREATE TABLE IF NOT EXISTS crewbrief_email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waitlist_entry_id uuid REFERENCES crewbrief_waitlist_entries(id),
  email text NOT NULL,
  template_name text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  provider_message_id text,
  error_message text,
  sent_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cb_email_email_idx ON crewbrief_email_log (email);
CREATE INDEX IF NOT EXISTS cb_email_template_idx ON crewbrief_email_log (template_name, email);

CREATE TABLE IF NOT EXISTS crewbrief_hubspot_sync (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  hubspot_id text NOT NULL,
  last_synced_at timestamp with time zone NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  sync_payload text
);

CREATE INDEX IF NOT EXISTS cb_hs_entity_idx ON crewbrief_hubspot_sync (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS cb_hs_hubspot_idx ON crewbrief_hubspot_sync (hubspot_id);
