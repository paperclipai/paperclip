WITH target(sku) AS (VALUES
 ('1086071'),('117318'),('1324386'),('201314'),('420345'),('420458'),('420460'),('420464'),
 ('420466'),('420469'),('420470'),('420484'),('420488'),('420491'),('420627'),('420630')
), channel_lines AS (
 SELECT TRIM(CAST(p.DealerSKU AS TEXT)) AS sku, p.RetailOrderID AS retail_order_id,
        COALESCE(p.DealerQty, 0) AS dealer_qty
 FROM ORD_ROProduct AS p JOIN ORD_RetailOrder AS o ON o.RetailOrderID = p.RetailOrderID
 JOIN COM_Company AS d ON d.CompanyID = o.DealerCompanyID WHERE d.SalesChannelID = 2
)
SELECT t.sku, COUNT(DISTINCT l.retail_order_id) AS channel2_order_count,
       COALESCE(SUM(l.dealer_qty), 0) AS channel2_sku_units
FROM target AS t LEFT JOIN channel_lines AS l ON l.sku = t.sku
GROUP BY t.sku ORDER BY t.sku;
