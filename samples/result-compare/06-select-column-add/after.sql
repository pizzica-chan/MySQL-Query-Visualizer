SELECT
  id,
  name,
  price
FROM products
WHERE deleted_at IS NULL
ORDER BY id;
