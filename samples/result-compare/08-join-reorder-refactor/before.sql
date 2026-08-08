SELECT
  o.id AS order_id,
  u.name AS user_name,
  p.amount,
  i.sku
FROM orders o
INNER JOIN users u ON o.user_id = u.id
INNER JOIN payments p ON p.order_id = o.id
INNER JOIN order_items i ON i.order_id = o.id
WHERE o.status = 'paid'
  AND u.active = 1;
