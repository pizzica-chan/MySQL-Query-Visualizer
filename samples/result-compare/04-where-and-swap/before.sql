SELECT id, email
FROM users
WHERE active = 1
  AND role = 'admin'
  AND created_at >= '2024-01-01';
