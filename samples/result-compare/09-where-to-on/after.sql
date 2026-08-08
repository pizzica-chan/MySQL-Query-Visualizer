SELECT
  u.id,
  u.name,
  o.id AS order_id,
  o.total
FROM users u
INNER JOIN orders o
  ON u.id = o.user_id
 AND o.status = 'paid'
 AND o.total >= 1000;
