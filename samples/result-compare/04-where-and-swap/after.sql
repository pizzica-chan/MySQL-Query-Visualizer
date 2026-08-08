SELECT id, email
FROM users
WHERE created_at >= '2024-01-01'
  AND role = 'admin'
  AND active = 1;
