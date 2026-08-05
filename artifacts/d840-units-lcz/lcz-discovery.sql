SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND
 (lower(name) LIKE '%lcz%' OR lower(name) LIKE '%zone%' OR lower(name) LIKE '%zip%'
  OR lower(name) LIKE '%postal%' OR lower(name) LIKE '%store%' OR lower(name) LIKE '%location%')
ORDER BY name;
