-- Seed subscription tiers for Paperclip billing.
-- These match the Stripe products/prices already configured on the account.
--
-- Monthly prices exist in Stripe live mode; yearly prices are in test mode
-- for the dev environment. In production, replace with live-mode yearly IDs.
--
-- Stripe Products (test mode):
--   Adventurer: prod_V7COtn9lbjldY0
--   Explorer:   prod_V7COvNVJtCzi43
--   Elite:      prod_V7COuXR34Qdjie
--
-- Run via:
--   psql "$DATABASE_URL" -f server/src/seed/002_subscription_tiers.sql
--
-- Or from the paperclip repo root with explicit connection:
--   psql "postgres://user:pass@localhost:5432/paperclip" -f server/src/seed/002_subscription_tiers.sql
--
-- Idempotent: uses WHERE NOT EXISTS to skip tiers that are already seeded.
-- To re-seed after changes, delete rows first or use ON CONFLICT DO UPDATE.

-- Adventurer tier ($29/mo or $290/yr — 20% discount)
INSERT INTO subscription_tiers (name, description, price_monthly_cents, price_yearly_cents, stripe_price_monthly_id, stripe_price_yearly_id, stripe_product_id, included_seats, extra_seat_price_cents, included_agent_runs, extra_agent_run_price_cents, included_storage_gb, extra_storage_gb_price_cents, features, is_active, sort_order)
SELECT 'Adventurer', 'For solo travelers and small teams — get started with AI-powered trip planning.', 2900, 29000, 'price_1U2GjoK6Q827UREsuUxaX8TY', 'price_1U6xztK6Q827UREspGqECp6k', 'prod_V7COtn9lbjldY0', 2, 1000, 500, 10, 5, 500, '["ai_trip_planning", "basic_itinerary", "email_support", "2_agents"]'::jsonb, true, 1
WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'Adventurer');

-- Explorer tier ($79/mo or $790/yr — 20% discount)
INSERT INTO subscription_tiers (name, description, price_monthly_cents, price_yearly_cents, stripe_price_monthly_id, stripe_price_yearly_id, stripe_product_id, included_seats, extra_seat_price_cents, included_agent_runs, extra_agent_run_price_cents, included_storage_gb, extra_storage_gb_price_cents, features, is_active, sort_order)
SELECT 'Explorer', 'For growing teams — unlock advanced features, more agents, and priority support.', 7900, 79000, 'price_1U2GjpK6Q827UREswJuPSKjX', 'price_1U6xzuK6Q827UREsYdA36dl8', 'prod_V7COvNVJtCzi43', 5, 800, 2000, 8, 25, 300, '["ai_trip_planning", "advanced_itinerary", "real_time_collaboration", "priority_support", "5_agents", "custom_templates"]'::jsonb, true, 2
WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'Explorer');

-- Elite tier ($499/mo or $4990/yr — 20% discount)
INSERT INTO subscription_tiers (name, description, price_monthly_cents, price_yearly_cents, stripe_price_monthly_id, stripe_price_yearly_id, stripe_product_id, included_seats, extra_seat_price_cents, included_agent_runs, extra_agent_run_price_cents, included_storage_gb, extra_storage_gb_price_cents, features, is_active, sort_order)
SELECT 'Elite', 'For power users and enterprises — everything unlocked, dedicated support, white-glove onboarding.', 49900, 499000, 'price_1U2GjrK6Q827UREsrWOL9nWy', 'price_1U6xzvK6Q827UREs6PLU0l0I', 'prod_V7COuXR34Qdjie', 20, 500, 10000, 5, 100, 200, '["ai_trip_planning", "premium_itinerary", "real_time_collaboration", "dedicated_support", "unlimited_agents", "custom_templates", "white_glove_onboarding", "api_access", "sso_saml"]'::jsonb, true, 3
WHERE NOT EXISTS (SELECT 1 FROM subscription_tiers WHERE name = 'Elite');
