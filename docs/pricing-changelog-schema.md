# Pricing Changelog Schema

## Overview

This document describes the JSON schema for pricing changelog entries. Each entry captures a price change event for a specific model offered by a vendor.

## Schema Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| vendor | string | Yes | Name of the vendor offering the model (e.g., "OpenAI", "Anthropic") |
| model | string | Yes | The specific model identifier (e.g., "gpt-4", "claude-3-opus") |
| old_price | number \| null | Yes | Previous price before change (null if new model launch) |
| new_price | number \| null | Yes | New price after change (null if model discontinued) |
| delta_percent | number \| null | Yes | Percentage change: `(new_price - old_price) / old_price * 100` (null if old_price is 0 or missing) |
| timestamp | string (ISO8601) | Yes | Timestamp of when the price change occurred |

## Example Fixture

```json
{
  "vendor": "OpenAI",
  "model": "gpt-4-turbo",
  "old_price": 0.03,
  "new_price": 0.01,
  "delta_percent": -66.67,
  "timestamp": "2024-11-15T10:30:00Z"
}
```

This example shows a 66.67% price reduction for OpenAI's gpt-4-turbo model on November 15, 2024.

## Source

Based on pricing data from vendor public APIs and official pricing pages, including but not limited to: [LiteLLM pricing JSON](https://github.com/BerriAI/litellm/blob/main/model_prices.json).
