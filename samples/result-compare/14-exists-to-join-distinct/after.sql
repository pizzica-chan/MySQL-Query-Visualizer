SELECT DISTINCT
  u.id,
  u.name
FROM users u
INNER JOIN orders o ON o.user_id = u.id
WHERE u.active = 1
  AND o.status = 'paid';
