SELECT
  u.id,
  u.name,
  o.id AS order_id,
  o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE u.active = 1
  AND o.status = 'paid';
