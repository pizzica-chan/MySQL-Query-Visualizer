SELECT
  u.id,
  u.name,
  o.id AS order_id,
  o.total
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE o.status = 'paid'
  AND o.total >= 1000;
