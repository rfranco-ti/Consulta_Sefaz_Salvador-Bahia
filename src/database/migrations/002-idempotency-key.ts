export const MIGRACAO_IDEMPOTENCY_KEY = {
  nome: '002-idempotency-key',
  sql: `
ALTER TABLE execucoes ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_execucoes_idempotencia ON execucoes(api_key_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_execucoes_chave_status ON execucoes(api_key_id, status);
`,
};
