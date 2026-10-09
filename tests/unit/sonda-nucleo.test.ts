import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  calcularExitCodeSonda,
  carregarPortalSonda,
  chavesPreInteracao,
  descobrirPortais,
  montarRelatorioSonda,
  type LinhaSonda,
  type PortalSonda,
} from '../../scripts/sonda-nucleo.js';

const diretorioRaiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const portalSefaz = path.join(
  diretorioRaiz,
  'src',
  'automations',
  'sites',
  'sefaz-bahia',
  'sefaz-bahia.portal.json',
);
const diretorioFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

function portalTunel(): PortalSonda {
  return {
    nome: 'tunel-exemplo',
    navegacao: { url: 'https:', timeout: 30000, waitUntil: 'domcontentloaded' },
    seletores: {
      campo_cga: { seletores: ['a'] },
      campo_exercicio: { seletores: ['b'] },
      campo_captcha: { seletores: ['c'] },
      botao_consultar: { seletores: ['d'] },
      sinal_resultado: { seletores: ['e'] },
      botao_emitir_boleto: { seletores: ['f'] },
    },
    steps: [
      { id: 'navegar-portal', descricao: 'abre', acao: 'navegar' },
      { id: 'preencher-cga', descricao: 'cga', acao: 'preencher', chaveSeletor: 'campo_cga' },
      {
        id: 'selecionar-exercicio',
        descricao: 'exercicio',
        acao: 'selecionar',
        chaveSeletor: 'campo_exercicio',
      },
      {
        id: 'resolver-captcha',
        descricao: 'captcha',
        acao: 'preencher',
        chaveSeletor: 'campo_captcha',
      },
      {
        id: 'submeter-consulta',
        descricao: 'consulta',
        acao: 'clicar',
        chaveSeletor: 'botao_consultar',
      },
      {
        id: 'aguardar-resultado',
        descricao: 'resultado',
        acao: 'esperar',
        chaveSeletor: 'sinal_resultado',
      },
      { id: 'extrair-dados', descricao: 'extrai', acao: 'avaliar' },
      {
        id: 'emitir-boletos',
        descricao: 'boletos',
        acao: 'clicar',
        chaveSeletor: 'botao_emitir_boleto',
      },
    ],
  };
}

function linha(robot: string, seletor: string, pass: boolean): LinhaSonda {
  return {
    robot,
    seletor,
    situacao: pass ? 'PASS' : 'FAIL',
    detalhe: pass ? 'encontrado no formulário inicial' : 'ausente no formulário inicial',
  };
}

describe('chavesPreInteracao', () => {
  it('coleta campo e botão do formulário inicial e para antes do resultado', () => {
    expect(chavesPreInteracao(portalTunel())).toEqual([
      'campo_cga',
      'campo_exercicio',
      'campo_captcha',
      'botao_consultar',
    ]);
  });

  it('exclui o seletor de resultado do sefaz-bahia real', async () => {
    const portal = await carregarPortalSonda(portalSefaz);
    expect(chavesPreInteracao(portal)).toEqual(['campo_cnpj', 'botao_consultar']);
  });

  it('remove repetidos preservando a ordem do formulário', () => {
    const portal = portalTunel();
    portal.steps.unshift({
      id: 'repetir-cga',
      descricao: 'repete',
      acao: 'preencher',
      chaveSeletor: 'campo_cga',
    });
    expect(chavesPreInteracao(portal)).toEqual([
      'campo_cga',
      'campo_exercicio',
      'campo_captcha',
      'botao_consultar',
    ]);
  });
});

describe('carregarPortalSonda', () => {
  it('descobre os oito portais dos robots em ordem', async () => {
    const caminhos = await descobrirPortais(
      path.join(diretorioRaiz, 'src', 'automations', 'sites'),
    );
    expect(caminhos).toHaveLength(8);
    expect(caminhos).toEqual([...caminhos].sort());
    for (const caminho of caminhos) {
      expect(caminho.endsWith('.portal.json')).toBe(true);
    }
  });
  it('lê o portal real com navegação e cadeias de seletores', async () => {
    const portal = await carregarPortalSonda(portalSefaz);
    expect(portal.navegacao.url).toContain('consultaBa.asp');
    expect(Object.keys(portal.seletores)).toContain('campo_cnpj');
    expect(portal.steps.length).toBeGreaterThan(0);
  });

  it('arquivo inexistente rejeita em português', async () => {
    await expect(
      carregarPortalSonda(path.join(diretorioFixtures, 'portal-que-nao-existe.portal.json')),
    ).rejects.toThrow('não encontrado');
  });

  it('JSON inválido rejeita em português', async () => {
    await expect(
      carregarPortalSonda(path.join(diretorioFixtures, 'portal-json-invalido.portal.json')),
    ).rejects.toThrow('JSON inválido');
  });

  it('portal sem navegação rejeita em português', async () => {
    const portal = portalTunel();
    const semUrl = { ...portal, navegacao: { ...portal.navegacao, url: '' } };
    const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'sonda-'));
    try {
      const arquivo = path.join(dir, 'quebrado.portal.json');
      await writeFile(arquivo, JSON.stringify(semUrl));
      await expect(carregarPortalSonda(arquivo)).rejects.toThrow('navegação');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('relatório da sonda', () => {
  it('exit 0 quando todos os seletores passam', () => {
    const linhas = [linha('sefaz-bahia', 'campo_cnpj', true), linha('sefaz-bahia', 'botao_consultar', true)];
    expect(calcularExitCodeSonda(linhas)).toBe(0);
    const relatorio = montarRelatorioSonda(linhas);
    expect(relatorio.exitCode).toBe(0);
    expect(relatorio.texto).toContain('ROBOT | SELETOR | RESULTADO | DETALHE');
    expect(relatorio.texto).toContain('sefaz-bahia | campo_cnpj | PASS');
    expect(relatorio.texto).toContain('Resumo: 1 robot sondado, 2 seletores verificados, 0 ausentes');
  });

  it('exit 1 quando algum seletor falta', () => {
    const linhas = [linha('sefaz-bahia', 'campo_cnpj', false), linha('sefaz-bahia', 'botao_consultar', true)];
    expect(calcularExitCodeSonda(linhas)).toBe(1);
    const relatorio = montarRelatorioSonda(linhas);
    expect(relatorio.exitCode).toBe(1);
    expect(relatorio.texto).toContain('sefaz-bahia | campo_cnpj | FAIL');
    expect(relatorio.texto).toContain('Resumo: 1 robot sondado, 2 seletores verificados, 1 ausente');
  });

  it('pluraliza o resumo com vários robots', () => {
    const linhas = [linha('sefaz-bahia', 'campo_cnpj', false), linha('iptu-salvador', 'campo_inscricao', true)];
    const relatorio = montarRelatorioSonda(linhas);
    expect(relatorio.texto).toContain('Resumo: 2 robots sondados, 2 seletores verificados, 1 ausente');
  });
});
