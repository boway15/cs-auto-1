-- Raise outbound-attachments bucket per-object limit to 35MB

UPDATE storage.buckets
SET file_size_limit = 36700160
WHERE id = 'outbound-attachments';
