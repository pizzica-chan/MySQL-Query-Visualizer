SELECT
  id,
  name
FROM products
WHERE deleted_at IS NULL
ORDER BY id;
