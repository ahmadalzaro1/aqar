-- 0000_extensions: required Postgres extensions.
--
-- pgvector provides the `vector` type + HNSW/IVFFlat indexes used by
-- ticket_embeddings (dimension 384 = Xenova/multilingual-e5-small).
-- NOTE: money is INTEGER fils (1 JOD = 1000 fils); no extension is needed for that.
CREATE EXTENSION IF NOT EXISTS vector;
