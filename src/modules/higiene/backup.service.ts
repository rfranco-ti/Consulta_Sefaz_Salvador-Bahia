import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

export const PREFIXO_BACKUP = 'app-';
export const RETENCAO_PADRAO_BACKUPS = 5;

export interface OpcoesBackup {
  origem: string;
  diretorioDestino: string;
  reter?: number;
  agora?: () => Date;
}

export interface ResultadoBackup {
  arquivo: string;
  removidos: string[];
}

export function gerarNomeBackup(referencia: Date): string {
  const semMillis = referencia.toISOString().slice(0, 19);
  const compacto = semMillis.replaceAll('-', '').replaceAll(':', '') + 'Z';
  return `${PREFIXO_BACKUP}${compacto}.sqlite`;
}

export async function executarBackup(opcoes: OpcoesBackup): Promise<ResultadoBackup> {
  if (!existsSync(opcoes.origem)) {
    throw new Error(`arquivo do banco de dados não encontrado: ${opcoes.origem}`);
  }
  const destinoDir = resolve(opcoes.diretorioDestino);
  mkdirSync(destinoDir, { recursive: true });
  const referencia = opcoes.agora?.() ?? new Date();
  const destino = join(destinoDir, gerarNomeBackup(referencia));
  const origem = new Database(opcoes.origem, { readonly: true });
  try {
    await origem.backup(destino);
  } finally {
    origem.close();
  }
  const reter = opcoes.reter ?? RETENCAO_PADRAO_BACKUPS;
  const removidos = aplicarRetencao(destinoDir, reter);
  return { arquivo: destino, removidos };
}

function aplicarRetencao(diretorio: string, reter: number): string[] {
  const arquivos = readdirSync(diretorio)
    .filter((nome) => nome.startsWith(PREFIXO_BACKUP) && nome.endsWith('.sqlite'))
    .sort();
  const excedentes = arquivos.slice(0, Math.max(0, arquivos.length - reter));
  const removidos: string[] = [];
  for (const nome of excedentes) {
    const caminho = join(diretorio, nome);
    try {
      unlinkSync(caminho);
      removidos.push(caminho);
    } catch {
      continue;
    }
  }
  return removidos;
}
