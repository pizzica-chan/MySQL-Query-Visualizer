SELECT
  u.id,
  u.name
FROM users u
WHERE u.active = 1
  AND EXISTS (
    SELECT 1
    FROM orders o
    WHERE o.user_id = u.id
      AND o.status = 'paid'
  );
