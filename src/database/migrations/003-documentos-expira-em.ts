export const MIGRACAO_DOCUMENTOS_EXPIRA_EM = {
  nome: '003-documentos-expira-em',
  sql: `
ALTER TABLE documentos ADD COLUMN expira_em TEXT;
UPDATE documentos SET expira_em = datetime(criado_em, '+7 day') WHERE expira_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_documentos_expira_em ON documentos(expira_em);
`,
};
