-- Raise outbound-attachments bucket per-object limit to 20MB

UPDATE storage.buckets
SET file_size_limit = 20971520
WHERE id = 'outbound-attachments';
