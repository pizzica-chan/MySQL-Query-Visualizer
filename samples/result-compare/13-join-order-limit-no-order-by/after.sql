SELECT
  o.id,
  u.name,
  p.amount
FROM users u
INNER JOIN orders o ON o.user_id = u.id
INNER JOIN payments p ON p.order_id = o.id
WHERE o.status = 'paid'
LIMIT 10;
