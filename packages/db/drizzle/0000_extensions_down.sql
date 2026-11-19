-- 0000_extensions DOWN — remove the pgvector extension.
-- Runs last on a full rollback, after ticket_embeddings has been dropped.
DROP EXTENSION IF EXISTS vector;
