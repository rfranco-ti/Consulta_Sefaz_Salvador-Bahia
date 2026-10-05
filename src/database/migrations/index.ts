import type Database from 'better-sqlite3';
import { DatabaseError } from '../../shared/errors/index.js';
import { MIGRACAO_SCHEMA_INICIAL } from './001-schema-inicial.js';

export interface Migracao {
  nome: string;
  sql: string;
}

const MIGRACOES: Migracao[] = [MIGRACAO_SCHEMA_INICIAL];

export function listarMigrationsAplicadas(banco: Database.Database): string[] {
  try {
    banco.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (nome TEXT PRIMARY KEY, aplicado_em TEXT NOT NULL)',
    );
    const linhas = banco.prepare<[], { nome: string }>(
      'SELECT nome FROM schema_migrations ORDER BY nome ASC',
    ).all();
    return linhas.map((linha) => linha.nome);
  } catch (erro) {
    throw new DatabaseError('Falha ao listar migrações aplicadas', { cause: erro });
  }
}

export function aplicarMigrations(banco: Database.Database): string[] {
  const aplicadas = new Set(listarMigrationsAplicadas(banco));
  const novas: string[] = [];
  for (const migracao of MIGRACOES) {
    if (aplicadas.has(migracao.nome)) {
      continue;
    }
    try {
      const aplicar = banco.transaction(() => {
        banco.exec(migracao.sql);
        banco
          .prepare<[string, string]>(
            'INSERT INTO schema_migrations (nome, aplicado_em) VALUES (?, ?)',
          )
          .run(migracao.nome, new Date().toISOString());
      });
      aplicar();
      novas.push(migracao.nome);
    } catch (erro) {
      throw new DatabaseError(`Falha ao aplicar migração ${migracao.nome}`, { cause: erro });
    }
  }
  return novas;
}
