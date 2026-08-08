SELECT u.id, o.id AS order_id
FROM orders o
LEFT JOIN users u ON o.user_id = u.id;
