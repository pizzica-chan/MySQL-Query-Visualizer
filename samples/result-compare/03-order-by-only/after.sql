SELECT
  id,
  name,
  created_at
FROM users
WHERE active = 1
ORDER BY name ASC;
