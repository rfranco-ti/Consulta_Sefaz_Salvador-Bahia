import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import {
  carregarPortalSonda,
  chavesPreInteracao,
  descobrirPortais,
  montarRelatorioSonda,
  verificarPagina,
  type LinhaSonda,
} from './sonda-nucleo.js';

function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) {
    return erro.message;
  }
  return String(erro);
}

function diretorioSites(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'automations',
    'sites',
  );
}

function nomeRobot(caminho: string): string {
  const base = path.basename(caminho);
  return base.endsWith('.portal.json') ? base.slice(0, -'.portal.json'.length) : base;
}

async function sondarRobot(navegador: Browser, caminho: string): Promise<LinhaSonda[]> {
  const robot = nomeRobot(caminho);
  let portal;
  try {
    portal = await carregarPortalSonda(caminho);
  } catch (erro) {
    return [{ robot, seletor: '(portal)', situacao: 'FAIL', detalhe: mensagemDeErro(erro) }];
  }
  const chaves = chavesPreInteracao(portal);
  if (chaves.length === 0) {
    return [
      {
        robot,
        seletor: '(portal)',
        situacao: 'FAIL',
        detalhe: 'nenhum seletor pré-interação declarado no portal.json',
      },
    ];
  }
  const contexto = await navegador.newContext({ locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  try {
    try {
      await pagina.goto(portal.navegacao.url, {
        waitUntil: portal.navegacao.waitUntil,
        timeout: portal.navegacao.timeout,
      });
    } catch (erro) {
      return [
        { robot, seletor: '(página)', situacao: 'FAIL', detalhe: 'navegação falhou: ' + mensagemDeErro(erro) },
      ];
    }
    const achados = await verificarPagina(pagina, portal, chaves);
    return achados.map((achado) => ({
      robot,
      seletor: achado.chave,
      situacao: achado.presente ? ('PASS' as const) : ('FAIL' as const),
      detalhe: achado.detalhe,
    }));
  } finally {
    await pagina.close().catch(() => undefined);
    await contexto.close().catch(() => undefined);
  }
}

async function principal(): Promise<number> {
  const caminhos = await descobrirPortais(diretorioSites());
  const navegador = await chromium.launch({ headless: true });
  try {
    const linhas: LinhaSonda[] = [];
    for (const caminho of caminhos) {
      const parciais = await sondarRobot(navegador, caminho);
      for (const parcial of parciais) {
        linhas.push(parcial);
      }
    }
    const relatorio = montarRelatorioSonda(linhas);
    await new Promise<void>((resolver) => {
      process.stdout.write(relatorio.texto + '\n', () => resolver());
    });
    return relatorio.exitCode;
  } finally {
    await navegador.close();
  }
}

let codigo = 1;
try {
  codigo = await principal();
} catch (erro: unknown) {
  await new Promise<void>((resolver) => {
    process.stderr.write('sonda falhou: ' + mensagemDeErro(erro) + '\n', () => resolver());
  });
  codigo = 1;
}
process.exit(codigo);
