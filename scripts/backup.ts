import { resolve } from 'node:path';
import { env } from '../src/config/env.js';
import { executarBackup } from '../src/modules/higiene/backup.service.js';

const DESTINO_PADRAO = './data/backups';

async function main(): Promise<void> {
  const destino = resolve(DESTINO_PADRAO);
  try {
    const resultado = await executarBackup({
      origem: env.DATABASE_PATH,
      diretorioDestino: destino,
    });
    console.log(`backup do banco de dados concluído: ${resultado.arquivo}`);
    if (resultado.removidos.length > 0) {
      console.log(`backups antigos removidos: ${resultado.removidos.length}`);
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    console.error(`falha no backup do banco de dados: ${mensagem}`);
    process.exitCode = 1;
  }
}

await main();
