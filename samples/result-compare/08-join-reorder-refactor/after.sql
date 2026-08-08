SELECT
  o.id AS order_id,
  u.name AS user_name,
  p.amount,
  i.sku
FROM users u
INNER JOIN orders o ON o.user_id = u.id
INNER JOIN order_items i ON i.order_id = o.id
INNER JOIN payments p ON p.order_id = o.id
WHERE u.active = 1
  AND o.status = 'paid';
