export const MIGRACAO_SCHEMA_INICIAL = {
  nome: '001-schema-inicial',
  sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  nome TEXT PRIMARY KEY,
  aplicado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL,
  ultimo_uso_em TEXT
);
CREATE TABLE IF NOT EXISTS execucoes (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_bruto TEXT NOT NULL,
  resultado TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  ticket INTEGER NOT NULL UNIQUE,
  cache_version INTEGER NOT NULL DEFAULT 1,
  posicao_fila INTEGER,
  criado_em TEXT NOT NULL,
  iniciado_em TEXT,
  finalizado_em TEXT,
  duracao_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execucoes_status_ticket ON execucoes(status, ticket);
CREATE INDEX IF NOT EXISTS idx_execucoes_tipo_status ON execucoes(tipo, status);
CREATE INDEX IF NOT EXISTS idx_execucoes_criado_em ON execucoes(criado_em);
CREATE TABLE IF NOT EXISTS execucoes_participantes (
  execucao_id TEXT NOT NULL REFERENCES execucoes(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  PRIMARY KEY (execucao_id, api_key_id)
);
CREATE TABLE IF NOT EXISTS documentos (
  id TEXT PRIMARY KEY,
  execucao_id TEXT NOT NULL REFERENCES execucoes(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  caminho TEXT NOT NULL,
  content_type TEXT NOT NULL,
  nome_arquivo TEXT NOT NULL,
  tamanho_bytes INTEGER NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache_consultas (
  chave TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  dados TEXT NOT NULL,
  cache_version INTEGER NOT NULL,
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  tamanho_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_expira_em ON cache_consultas(expira_em);
CREATE INDEX IF NOT EXISTS idx_cache_tipo ON cache_consultas(tipo);
`,
};
