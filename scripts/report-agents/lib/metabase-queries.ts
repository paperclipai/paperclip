import pg from "pg";

export interface TokenRow {
  token_symbol: string;
  network_name: string;
  total_value_24h: number;
  total_value_all: number;
  pct_growth_24h_vs_all: number;
  num_new_wallets_24h: number;
  num_old_wallets_24h: number;
  total_volume_on_web: number;
  total_value_exit_position_24h: number;
  total_value_filled_exit_position_24h: number;
  total_value_exit_position_all_time: number;
  total_value_filled_exit_position_all_time: number;
}

export async function fetchPlatformMetrics(): Promise<TokenRow[]> {
  const client = new pg.Client(process.env.DATABASE_URL);
  await client.connect();
  try {
    // TODO: Replace with actual SQL from Metabase card 182
    // This query should return token performance metrics matching the Metabase saved question
    const result = await client.query(`
      -- Replicate Metabase card 182 query here
      -- Columns must match TokenRow interface
      SELECT * FROM your_view_or_query
      ORDER BY total_value_24h DESC
    `);
    return result.rows;
  } finally {
    await client.end();
  }
}
