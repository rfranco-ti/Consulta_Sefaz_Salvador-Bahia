import { describe, expect, it } from 'vitest';
import {
  executarConsultaInscricoes,
} from '../../src/automations/sites/consulta-inscricoes/consulta-inscricoes.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor, registrarExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import type { ResultadoExecutor } from '../../src/modules/jobs/job.types.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CNPJ_MASCARA = '12.345.678/0001-95';
const CNPJ_DIGITOS = '12345678000195';

const sessao = {} as BrowserSession;

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'consulta-inscricoes',
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

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => {
    setTimeout(resolver, ms);
  });
}

describe('executor consulta-inscricoes', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('consulta-inscricoes')).toBe(executarConsultaInscricoes);
  });

  it('rejeita CNPJ inválido com ValidationError antes de acionar os filhos', async () => {
    let chamadasEstadual = 0;
    let chamadasMunicipal = 0;
    registrarExecutor('sefaz-bahia', async () => {
      chamadasEstadual += 1;
      return { sucesso: true, dados: {} };
    });
    registrarExecutor('ficha-cadastral', async () => {
      chamadasMunicipal += 1;
      return { sucesso: true, dados: {} };
    });
    await expect(
      executarConsultaInscricoes(montarExecucao('exe_ci_invalido', { cnpj: '123' }), sessao),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      executarConsultaInscricoes(montarExecucao('exe_ci_payload', 'não-json{'), sessao),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(chamadasEstadual).toBe(0);
    expect(chamadasMunicipal).toBe(0);
  });

  it('compõe IE e IM quando ambos os filhos têm sucesso', async () => {
    const cargasEstadual: unknown[] = [];
    const cargasMunicipal: unknown[] = [];
    registrarExecutor('sefaz-bahia', async (execucao) => {
      cargasEstadual.push(JSON.parse(execucao.payload) as unknown);
      return {
        sucesso: true,
        dados: {
          inscricaoEstadual: '123456789/ME',
          situacaoCadastral: 'ATIVO',
          dataSituacaoCadastral: '01/02/2024',
        },
        mensagem: 'Consulta SEFAZ Bahia realizada com sucesso.',
      };
    });
    registrarExecutor('ficha-cadastral', async (execucao) => {
      cargasMunicipal.push(JSON.parse(execucao.payload) as unknown);
      return {
        sucesso: true,
        dados: {
          inscricaoMunicipal: '7654321',
          situacaoCadastral: 'ATIVA',
          dataInscricaoPrefeitura: '10/05/2010',
        },
        mensagem: 'Consulta Ficha Cadastral realizada com sucesso.',
      };
    });
    const etapas: Array<string | undefined> = [];
    const deixar = obterCanalProgresso().observar('exe_ci_feliz', (evento) => {
      etapas.push(evento.etapa);
    });
    try {
      const resultado = await executarConsultaInscricoes(
        montarExecucao('exe_ci_feliz', { cnpj: CNPJ_MASCARA }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(true);
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['cnpj']).toBe(CNPJ_DIGITOS);
      expect(dados['inscricaoEstadual']).toBe('123456789');
      expect(dados['situacaoEstadual']).toBe('ATIVO');
      expect(dados['dataSituacaoEstadual']).toBe('01/02/2024');
      expect(dados['inscricaoMunicipal']).toBe('7654321');
      expect(dados['situacaoMunicipal']).toBe('ATIVA');
      expect(dados['dataInscricaoPrefeitura']).toBe('10/05/2010');
      expect(String(resultado['mensagem'])).toMatch(/sucesso/);
      expect(cargasEstadual).toEqual([{ cnpj: CNPJ_DIGITOS, artefatos: 'nenhum' }]);
      expect(cargasMunicipal).toEqual([{ cnpj: CNPJ_DIGITOS, artefatos: 'nenhum' }]);
      expect(etapas.some((etapa) => etapa?.includes('SEFAZ Bahia'))).toBe(true);
      expect(etapas.some((etapa) => etapa?.includes('Ficha Cadastral'))).toBe(true);
    } finally {
      deixar();
    }
  });

  it('compõe resposta parcial quando o filho estadual devolve sucesso falso', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: false,
      dados: { cnpjBuscado: CNPJ_DIGITOS },
      mensagem: 'Inscrição Estadual não encontrada para o CNPJ informado.',
    }));
    registrarExecutor('ficha-cadastral', async () => ({
      sucesso: true,
      dados: {
        inscricaoMunicipal: '7654321',
        situacaoCadastral: 'ATIVA',
        dataInscricaoPrefeitura: '10/05/2010',
      },
    }));
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_parcial', { cnpj: CNPJ_DIGITOS }),
      sessao,
    );
    expect(resultado['sucesso']).toBe(true);
    const dados = resultado['dados'] as Record<string, unknown>;
    expect(dados['inscricaoMunicipal']).toBe('7654321');
    expect(dados['inscricaoEstadual']).toBeUndefined();
    expect(String(resultado['mensagem'])).toMatch(/parcial/i);
    expect(String(resultado['mensagem'])).toContain('SEFAZ Bahia');
  });

  it('devolve sucesso falso consistente quando nenhum filho encontra inscrição', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: false,
      dados: { cnpjBuscado: CNPJ_DIGITOS },
      mensagem: 'Inscrição Estadual não encontrada para o CNPJ informado.',
    }));
    registrarExecutor('ficha-cadastral', async () => ({
      sucesso: false,
      dados: { cnpjBuscado: CNPJ_DIGITOS },
      mensagem: 'Ficha cadastral não encontrada para o CNPJ informado.',
    }));
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_vazio', { cnpj: CNPJ_DIGITOS }),
      sessao,
    );
    expect(resultado['sucesso']).toBe(false);
    expect(String(resultado['mensagem'])).toMatch(/Nenhuma inscrição encontrada/);
  });

  it('propaga erro tipado com a etapa quando o filho estadual lança', async () => {
    registrarExecutor('sefaz-bahia', async () => {
      throw new Error('portal fora do ar');
    });
    registrarExecutor('ficha-cadastral', async () => ({
      sucesso: true,
      dados: { inscricaoMunicipal: '7654321' },
    }));
    let erro: unknown = null;
    try {
      await executarConsultaInscricoes(
        montarExecucao('exe_ci_erro', { cnpj: CNPJ_DIGITOS }),
        sessao,
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(EtapaError);
    expect((erro as EtapaError).etapa).toBe('consultar-estadual');
    expect((erro as Error).message).toContain('portal fora do ar');
  });

  it('propaga erro tipado com a etapa quando o filho municipal lança', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: { inscricaoEstadual: '123456789' },
    }));
    registrarExecutor('ficha-cadastral', async () => {
      throw new Error('download do PDF falhou');
    });
    let erro: unknown = null;
    try {
      await executarConsultaInscricoes(
        montarExecucao('exe_ci_erro_mun', { cnpj: CNPJ_DIGITOS }),
        sessao,
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(EtapaError);
    expect((erro as EtapaError).etapa).toBe('consultar-municipal');
    expect((erro as Error).message).toContain('download do PDF falhou');
  });

  it('inicia as sub-etapas em paralelo', async () => {
    const ordem: string[] = [];
    registrarExecutor('sefaz-bahia', async () => {
      ordem.push('estadual-inicio');
      await esperar(60);
      ordem.push('estadual-fim');
      return { sucesso: true, dados: { inscricaoEstadual: '123456789' } };
    });
    registrarExecutor('ficha-cadastral', async () => {
      ordem.push('municipal-inicio');
      await esperar(60);
      ordem.push('municipal-fim');
      return { sucesso: true, dados: { inscricaoMunicipal: '7654321' } };
    });
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_paralelo', { cnpj: CNPJ_DIGITOS }),
      sessao,
    );
    expect(resultado['sucesso']).toBe(true);
    expect(ordem.slice(0, 2).sort()).toEqual(['estadual-inicio', 'municipal-inicio']);
  });

  it('agrega os artefatos devolvidos pelos filhos quando pedidos', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: { inscricaoEstadual: '123456789' },
      pdfBase64: 'cGRmLWJh',
      printBase64: 'cHJpbnQtYmE=',
    }));
    registrarExecutor('ficha-cadastral', async () => ({
      sucesso: true,
      dados: { inscricaoMunicipal: '7654321' },
      pdfBase64: 'cGRmLWZpY2hh',
      printBase64: 'cHJpbnQtZmljaGE=',
    }));
    const comArtefatos = await executarConsultaInscricoes(
      montarExecucao('exe_ci_art', { cnpj: CNPJ_DIGITOS, artefatos: 'ambos' }),
      sessao,
    );
    expect(comArtefatos['pdfEstadualBase64']).toBe('cGRmLWJh');
    expect(comArtefatos['pdfMunicipalBase64']).toBe('cGRmLWZpY2hh');
    expect(comArtefatos['printEstadualBase64']).toBe('cHJpbnQtYmE=');
    expect(comArtefatos['printMunicipalBase64']).toBe('cHJpbnQtZmljaGE=');
    const semArtefatos: ResultadoExecutor = await executarConsultaInscricoes(
      montarExecucao('exe_ci_sem_art', { cnpj: CNPJ_DIGITOS }),
      sessao,
    );
    expect(semArtefatos['pdfEstadualBase64']).toBeUndefined();
    expect(semArtefatos['pdfMunicipalBase64']).toBeUndefined();
    expect(semArtefatos['printEstadualBase64']).toBeUndefined();
    expect(semArtefatos['printMunicipalBase64']).toBeUndefined();
  });
});
