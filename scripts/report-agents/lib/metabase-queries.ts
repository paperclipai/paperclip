import Database from "better-sqlite3";

export interface TokenRow {
  token_symbol: string;
  network_name: string;
  total_volume_incl_offer: number;
  num_old_wallets_24h: number;
  num_new_wallets_24h: number;
  total_value_24h: number;
  total_value_all: number;
  pct_growth_24h_vs_all: number;
  total_traded_wallets_all_time: number;
  pct_24h_vs_total_users: number;
  total_exit_volume_24h: number;
  total_exit_volume_filled_24h: number;
  total_exit_volume_filling_24h: number;
  total_value_filled_exit_position_all_time: number;
  total_value_exit_position_all_time: number;
}

export function fetchPlatformMetrics(dbPath: string): TokenRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      WITH
      orders_all AS (
          SELECT
              u.address,
              t2.symbol AS token_symbol,
              nc2.id AS network_id,
              nc2.name AS network_name,
              o.amount AS token_amount,
              (o.amount * 1.0 / OF2.total_amount * OF2.value * t.price) AS order_value_usd
          FROM [order] o
          JOIN offer  OF2 ON o.offer_id = OF2.id
          JOIN token  t  ON OF2.ex_token_id = t.id
          JOIN token  t2 ON OF2.token_id = t2.id
          JOIN users  u  ON (o.buyer_id = u.id OR o.seller_id = u.id)
          LEFT JOIN network_chains nc2 ON t2.network_id = nc2.id
          WHERE o.deleted_at IS NULL AND OF2.deleted_at IS NULL
            AND (
              (t2.symbol = 'PUMP' AND o.created_at >= '2025-07-01')
              OR (t2.symbol <> 'PUMP')
            )
      ),

      wallet_type AS (
          SELECT
              address,
              network_id,
              network_name,
              CASE
                  WHEN COUNT(DISTINCT token_symbol) > 1 THEN 'old'
                  ELSE 'new'
              END AS wallet_type
          FROM orders_all
          GROUP BY address, network_id, network_name
      ),

      total_value_all AS (
          SELECT
              token_symbol,
              network_id,
              network_name,
              SUM(order_value_usd) AS total_value_all
          FROM orders_all
          GROUP BY token_symbol, network_id, network_name
      ),

      total_wallets_all_time AS (
          SELECT
              token_symbol,
              network_id,
              network_name,
              COUNT(DISTINCT address) AS total_traded_wallets_all_time
          FROM orders_all
          GROUP BY token_symbol, network_id, network_name
      ),

      orders_24h AS (
          SELECT
              u.address,
              t2.symbol AS token_symbol,
              nc2.id AS network_id,
              nc2.name AS network_name,
              o.amount AS token_amount,
              (o.amount * 1.0 / OF2.total_amount * OF2.value * t.price) AS order_value_usd
          FROM [order] o
          JOIN offer  OF2 ON o.offer_id = OF2.id
          JOIN token  t  ON OF2.ex_token_id = t.id
          JOIN token  t2 ON OF2.token_id = t2.id
          JOIN users  u  ON (o.buyer_id = u.id OR o.seller_id = u.id)
          LEFT JOIN network_chains nc2 ON t2.network_id = nc2.id
          WHERE o.deleted_at IS NULL AND OF2.deleted_at IS NULL
            AND o.created_at >= datetime('now', '-24 hours')
            AND (
              (t2.symbol = 'PUMP' AND o.created_at >= '2025-07-01')
              OR (t2.symbol <> 'PUMP')
            )
      ),

      orders_24h_with_type AS (
          SELECT
              o24.token_symbol,
              o24.network_id,
              o24.network_name,
              o24.address,
              o24.token_amount,
              o24.order_value_usd,
              wt.wallet_type
          FROM orders_24h o24
          LEFT JOIN wallet_type wt
              ON o24.address = wt.address
              AND o24.network_id = wt.network_id
              AND o24.network_name = wt.network_name
      ),

      agg_24h AS (
          SELECT
              o24.token_symbol,
              o24.network_id,
              o24.network_name,
              SUM(o24.order_value_usd) AS total_value_24h,
              tva.total_value_all,
              SUM(o24.order_value_usd) / NULLIF(SUM(o24.token_amount), 0) AS avg_trading_price_24h,
              COUNT(DISTINCT CASE WHEN o24.wallet_type = 'old' THEN o24.address END) AS num_old_wallets_24h,
              COUNT(DISTINCT CASE WHEN o24.wallet_type = 'new' THEN o24.address END) AS num_new_wallets_24h,
              twa.total_traded_wallets_all_time
          FROM orders_24h_with_type o24
          LEFT JOIN total_value_all tva
              ON o24.token_symbol = tva.token_symbol
              AND o24.network_id = tva.network_id
              AND o24.network_name = tva.network_name
          LEFT JOIN total_wallets_all_time twa
              ON o24.token_symbol = twa.token_symbol
              AND o24.network_id = twa.network_id
              AND o24.network_name = twa.network_name
          GROUP BY o24.token_symbol, o24.network_id, o24.network_name, tva.total_value_all, twa.total_traded_wallets_all_time
      ),

      token_total_volume AS (
          SELECT
              t.id AS token_id,
              t.symbol AS token_symbol,
              nc.id AS network_id,
              nc.name AS network_name,
              COALESCE(t.total_volume_ask, 0) + COALESCE(t.total_volume_bid, 0) AS total_volume_incl_offer
          FROM token t
          LEFT JOIN network_chains nc ON t.network_id = nc.id
          WHERE t.deleted_at IS NULL
      ),

      exit_position_summary AS (
          SELECT
              t.symbol AS token_symbol,
              nc.id AS network_id,
              nc.name AS network_name,
              SUM(o.value) AS total_exit_volume_24h,
              SUM(CASE WHEN o.total_amount = o.filled_amount THEN o.value ELSE 0 END) AS total_exit_volume_filled_24h,
              SUM(CASE WHEN o.total_amount > o.filled_amount THEN o.value ELSE 0 END) AS total_exit_volume_filling_24h
          FROM offer o
          LEFT JOIN token t ON o.token_id = t.id
          LEFT JOIN network_chains nc ON t.network_id = nc.id
          WHERE o.is_exit_position = 1
            AND o.deleted_at IS NULL
            AND o.created_at >= datetime('now', '-24 hours')
          GROUP BY t.symbol, nc.id, nc.name
      ),

      exit_position_filled_all_time AS (
          SELECT
              t.symbol AS token_symbol,
              nc.id AS network_id,
              nc.name AS network_name,
              SUM(o.value) AS total_value_filled_exit_position_all_time
          FROM offer o
          LEFT JOIN token t ON o.token_id = t.id
          LEFT JOIN network_chains nc ON t.network_id = nc.id
          WHERE o.is_exit_position = 1
            AND o.deleted_at IS NULL
            AND o.total_amount = o.filled_amount
          GROUP BY t.symbol, nc.id, nc.name
      ),

      exit_position_all_time AS (
          SELECT
              t.symbol AS token_symbol,
              nc.id AS network_id,
              nc.name AS network_name,
              SUM(o.value) AS total_value_exit_position_all_time
          FROM offer o
          LEFT JOIN token t ON o.token_id = t.id
          LEFT JOIN network_chains nc ON t.network_id = nc.id
          WHERE o.is_exit_position = 1
            AND o.deleted_at IS NULL
          GROUP BY t.symbol, nc.id, nc.name
      )

      SELECT
          agg_24h.token_symbol,
          agg_24h.network_name,
          COALESCE(ttv.total_volume_incl_offer, 0) AS total_volume_incl_offer,
          agg_24h.num_old_wallets_24h,
          agg_24h.num_new_wallets_24h,
          ROUND(agg_24h.total_value_24h, 2) AS total_value_24h,
          ROUND(agg_24h.total_value_all, 2) AS total_value_all,
          ROUND((agg_24h.total_value_24h * 1.0 / NULLIF(agg_24h.total_value_all, 0)) * 100, 2) AS pct_growth_24h_vs_all,
          agg_24h.total_traded_wallets_all_time,
          ROUND((agg_24h.num_new_wallets_24h * 1.0 / NULLIF(agg_24h.total_traded_wallets_all_time, 0)) * 100, 2) AS pct_24h_vs_total_users,
          COALESCE(eps.total_exit_volume_24h, 0) AS total_exit_volume_24h,
          COALESCE(eps.total_exit_volume_filled_24h, 0) AS total_exit_volume_filled_24h,
          COALESCE(eps.total_exit_volume_filling_24h, 0) AS total_exit_volume_filling_24h,
          COALESCE(epfa.total_value_filled_exit_position_all_time, 0) AS total_value_filled_exit_position_all_time,
          COALESCE(epa.total_value_exit_position_all_time, 0) AS total_value_exit_position_all_time
      FROM agg_24h
      LEFT JOIN token_total_volume ttv
          ON agg_24h.token_symbol = ttv.token_symbol
          AND agg_24h.network_id = ttv.network_id
      LEFT JOIN exit_position_summary eps
          ON agg_24h.token_symbol = eps.token_symbol
          AND agg_24h.network_id = eps.network_id
      LEFT JOIN exit_position_filled_all_time epfa
          ON agg_24h.token_symbol = epfa.token_symbol
          AND agg_24h.network_id = epfa.network_id
      LEFT JOIN exit_position_all_time epa
          ON agg_24h.token_symbol = epa.token_symbol
          AND agg_24h.network_id = epa.network_id
      ORDER BY agg_24h.total_value_24h DESC
    `).all() as TokenRow[];

    return rows;
  } finally {
    db.close();
  }
}
