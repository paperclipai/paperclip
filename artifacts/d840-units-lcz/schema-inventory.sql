SELECT m.name AS table_name,
       p.cid AS column_ordinal, p.name AS column_name, p.type AS declared_type,
       p."notnull" AS is_not_null, p.pk AS pk_position
FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS p
WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND (
  lower(m.name) LIKE '%lcz%' OR lower(m.name) LIKE '%zone%' OR lower(m.name) LIKE '%zip%'
  OR lower(m.name) LIKE '%postal%' OR lower(m.name) LIKE '%store%' OR lower(m.name) LIKE '%location%'
  OR lower(m.name) LIKE '%company%' OR lower(m.name) LIKE '%order%' OR lower(p.name) LIKE '%lcz%'
  OR lower(p.name) LIKE '%zone%' OR lower(p.name) LIKE '%zip%' OR lower(p.name) LIKE '%postal%'
  OR lower(p.name) LIKE '%store%' OR lower(p.name) LIKE '%location%' OR lower(p.name) LIKE '%effective%'
  OR lower(p.name) LIKE '%valid%' OR lower(p.name) LIKE '%start%' OR lower(p.name) LIKE '%end%'
  OR lower(p.name) LIKE '%date%' OR lower(p.name) LIKE '%parent%' OR lower(p.name) LIKE '%assigned%'
)
ORDER BY m.name, p.cid;
