import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  diretorioArtefatosExecucao,
  removerDiretoriosTemporariosDaExecucao,
  type ExecucaoCtx,
} from '../../src/automations/base/base-robot.js';
import {
  executarSefazBahia,
  SefazBahiaRobot,
} from '../../src/automations/sites/sefaz-bahia/sefaz-bahia.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';

const CNPJ_DIGITOS = '12345678000195';

const diretorioFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

function baseTemporaria(): string {
  return path.join(tmpdir(), 'api-sefaz-ssa');
}

async function listarRestos(execucaoId: string): Promise<string[]> {
  const entradas = await readdir(baseTemporaria()).catch(() => [] as string[]);
  return entradas.filter((nome) => nome.endsWith(`-${execucaoId}`));
}

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'sefaz-bahia',
    status: 'RUNNING',
    payload: texto,
    payloadBruto: texto,
    resultado: null,
    erro: null,
    attempts: 1,
    apiKeyId: 'key_teste',
    ticket: 1,
    cacheVersion: 1,
    posicaoFila: null,
    criadoEm: new Date().toISOString(),
    iniciadoEm: new Date().toISOString(),
    finalizadoEm: null,
    duracaoMs: null,
  };
}

let navegador: Browser;
let formHtml = '';
let resultadoHtml = '';

async function abrirSessao(): Promise<{ sessao: BrowserSession; fechar: () => Promise<void> }> {
  const contexto = await navegador.newContext({ locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  const sessao: BrowserSession = {
    browser: navegador,
    context: contexto,
    page: pagina,
    liberar: async () => {
      await pagina.close().catch(() => undefined);
      await contexto.close().catch(() => undefined);
    },
  };
  return { sessao, fechar: () => sessao.liberar() };
}

async function servirPortal(sessao: BrowserSession): Promise<void> {
  await sessao.page.route('**/consultaBa.asp', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formHtml }),
  );
  await sessao.page.route(
    (url) => url.href.includes('resultado.asp'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: resultadoHtml }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await readFile(path.join(diretorioFixtures, 'sefaz-bahia-form.html'), 'utf-8');
  resultadoHtml = await readFile(
    path.join(diretorioFixtures, 'sefaz-bahia-resultado.html'),
    'utf-8',
  );
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('isolamento de artefatos por execução', () => {
  it('nomeia o diretório com os parâmetros de negócio e o identificador da execução', () => {
    const dir = diretorioArtefatosExecucao('sefaz-bahia', 'exe_iso_nome', CNPJ_DIGITOS);
    expect(dir).toContain(`sefaz-bahia-${CNPJ_DIGITOS}-exe_iso_nome`);
    expect(path.basename(dir)).toBe(`sefaz-bahia-${CNPJ_DIGITOS}-exe_iso_nome`);
  });

  it('gera diretórios diferentes para a mesma consulta em execuções distintas', () => {
    const a = diretorioArtefatosExecucao('sefaz-bahia', 'exe_iso_a', CNPJ_DIGITOS);
    const b = diretorioArtefatosExecucao('sefaz-bahia', 'exe_iso_b', CNPJ_DIGITOS);
    expect(a).not.toBe(b);
    expect(a).toContain('exe_iso_a');
    expect(b).toContain('exe_iso_b');
  });

  it('escritas concorrentes com os mesmos nomes fixos não se truncam', async () => {
    const dirA = diretorioArtefatosExecucao('isolamento-prova', 'exe_iso_w_a', CNPJ_DIGITOS);
    const dirB = diretorioArtefatosExecucao('isolamento-prova', 'exe_iso_w_b', CNPJ_DIGITOS);
    expect(path.dirname(path.join(dirA, 'print.jpg'))).not.toBe(
      path.dirname(path.join(dirB, 'print.jpg')),
    );
    try {
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });
      await Promise.all([
        writeFile(path.join(dirA, 'print.jpg'), Buffer.from('bytes-da-execucao-a')),
        writeFile(path.join(dirB, 'print.jpg'), Buffer.from('bytes-da-execucao-b')),
      ]);
      const [lidoA, lidoB] = await Promise.all([
        readFile(path.join(dirA, 'print.jpg'), 'utf-8'),
        readFile(path.join(dirB, 'print.jpg'), 'utf-8'),
      ]);
      expect(lidoA).toBe('bytes-da-execucao-a');
      expect(lidoB).toBe('bytes-da-execucao-b');
    } finally {
      await removerDiretoriosTemporariosDaExecucao('exe_iso_w_a', ['isolamento-prova']);
      await removerDiretoriosTemporariosDaExecucao('exe_iso_w_b', ['isolamento-prova']);
    }
  });

  it('limpeza remove só os diretórios do prefixo da execução', async () => {
    const irmao = diretorioArtefatosExecucao('isolamento-prova', 'exe_iso_irmao', CNPJ_DIGITOS);
    const alvo = diretorioArtefatosExecucao('isolamento-prova', 'exe_iso_alvo', CNPJ_DIGITOS);
    // Mesmo execucaoId, prefixo de outro executor (cenário consulta-inscricoes,
    // cujos filhos estadual/municipal partilham o id e rodam em paralelo).
    const outroPrefixo = diretorioArtefatosExecucao('isolamento-outro', 'exe_iso_alvo', CNPJ_DIGITOS);
    try {
      for (const dir of [irmao, alvo, outroPrefixo]) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'print.jpg'), 'x');
      }
      await removerDiretoriosTemporariosDaExecucao('exe_iso_alvo', ['isolamento-prova']);
      expect(await listarRestos('exe_iso_alvo')).toEqual([path.basename(outroPrefixo)]);
      expect(await listarRestos('exe_iso_irmao')).toEqual([path.basename(irmao)]);
    } finally {
      await removerDiretoriosTemporariosDaExecucao('exe_iso_irmao', ['isolamento-prova']);
      await removerDiretoriosTemporariosDaExecucao('exe_iso_alvo', [
        'isolamento-prova',
        'isolamento-outro',
      ]);
    }
  });

  it(
    'duas execuções concorrentes dos mesmos parâmetros usam diretórios distintos e íntegros',
    { timeout: 120000 },
    async () => {
      const { sessao: sessaoA, fechar: fecharA } = await abrirSessao();
      const { sessao: sessaoB, fechar: fecharB } = await abrirSessao();
      const coletadosA: string[] = [];
      const coletadosB: string[] = [];
      const montarCtx = (
        sessao: BrowserSession,
        execucaoId: string,
        coletados: string[],
      ): ExecucaoCtx => ({
        sessao,
        emitir: () => undefined,
        registrarArquivo: (_tipo, caminho) => {
          coletados.push(caminho);
        },
        artefatos: 'ambos',
        signal: AbortSignal.timeout(90000),
        execucaoId,
      });
      try {
        await servirPortal(sessaoA);
        await servirPortal(sessaoB);
        const roboA = new SefazBahiaRobot();
        const roboB = new SefazBahiaRobot();
        const [resultadoA, resultadoB] = await Promise.all([
          roboA.executar({ cnpj: CNPJ_DIGITOS }, montarCtx(sessaoA, 'exe_iso_conc_a', coletadosA)),
          roboB.executar({ cnpj: CNPJ_DIGITOS }, montarCtx(sessaoB, 'exe_iso_conc_b', coletadosB)),
        ]);
        expect(resultadoA.sucesso).toBe(true);
        expect(resultadoB.sucesso).toBe(true);
        expect(coletadosA.length).toBeGreaterThan(0);
        expect(coletadosB.length).toBeGreaterThan(0);
        for (const caminho of coletadosA) {
          expect(caminho).toContain('exe_iso_conc_a');
        }
        for (const caminho of coletadosB) {
          expect(caminho).toContain('exe_iso_conc_b');
        }
        const dirsA = new Set(coletadosA.map((c) => path.dirname(c)));
        const dirsB = new Set(coletadosB.map((c) => path.dirname(c)));
        for (const dir of dirsA) {
          expect(dirsB.has(dir)).toBe(false);
        }
        // Nenhuma execução truncou a outra: todos os arquivos registrados
        // existem no disco com bytes válidos.
        for (const caminho of [...coletadosA, ...coletadosB]) {
          const conteudo = await readFile(caminho);
          expect(conteudo.length).toBeGreaterThan(0);
        }
      } finally {
        await fecharA();
        await fecharB();
        await removerDiretoriosTemporariosDaExecucao('exe_iso_conc_a', ['sefaz-bahia']);
        await removerDiretoriosTemporariosDaExecucao('exe_iso_conc_b', ['sefaz-bahia']);
      }
    },
  );

  it(
    'executor entrega os bytes antes da limpeza (leitura do persistirBlobs preservada)',
    { timeout: 120000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao);
        // O wrapper do executor lê cada arquivo para base64 (o que o
        // AutomationService.persistirBlobs consome depois — ele nunca toca no
        // temporário) e só então remove o diretório no `finally`.
        const resultado = await executarSefazBahia(
          montarExecucao('exe_iso_limpeza', { cnpj: CNPJ_DIGITOS, artefatos: 'ambos' }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        expect(typeof resultado['printBase64']).toBe('string');
        expect((resultado['printBase64'] as string).length).toBeGreaterThan(0);
        expect(typeof resultado['pdfBase64']).toBe('string');
        expect((resultado['pdfBase64'] as string).startsWith('JVBERi')).toBe(true);
        expect(await listarRestos('exe_iso_limpeza')).toEqual([]);
      } finally {
        await fechar();
      }
    },
  );
});
