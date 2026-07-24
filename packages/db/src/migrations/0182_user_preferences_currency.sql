-- Migration: 0182_user_preferences_currency.sql
-- Description: Add user_preferences table with preferredCurrency field

CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    preferred_currency CHAR(3) NOT NULL DEFAULT 'USD',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_preferences_user_id_unique UNIQUE (user_id),
    CONSTRAINT user_preferences_currency_check CHECK (preferred_currency IN ('USD', 'EUR', 'UYU', 'ARS'))
);

CREATE INDEX IF NOT EXISTS user_preferences_user_id_idx ON user_preferences(user_id);