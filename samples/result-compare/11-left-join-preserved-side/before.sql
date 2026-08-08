SELECT u.id, o.id AS order_id
FROM users u
LEFT JOIN orders o ON u.id = o.user_id;
