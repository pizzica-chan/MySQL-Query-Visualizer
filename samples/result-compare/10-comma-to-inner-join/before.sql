SELECT
  u.id,
  u.name,
  o.id AS order_id
FROM users u, orders o
WHERE u.id = o.user_id
  AND u.active = 1
  AND o.status = 'paid';
