SELECT
  users.id,
  users.name,
  orders.id AS order_id,
  orders.total
FROM users
INNER JOIN orders ON users.id = orders.user_id
WHERE users.active = 1
  AND orders.status = 'paid';
