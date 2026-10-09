import { describe, expect, it } from 'vitest';
import {
  executarConsultaInscricoes,
} from '../../src/automations/sites/consulta-inscricoes/consulta-inscricoes.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { limparExecutores, obterExecutor, registrarExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import type {
  DepsExecutor,
  Executor,
  ResultadoExecutor,
} from '../../src/modules/jobs/job.types.js';
import {
  BrowserError,
  EtapaError,
  InternalError,
  TimeoutError,
  ValidationError,
} from '../../src/shared/errors/index.js';

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

function montarDeps(): {
  deps: DepsExecutor;
  portais: string[];
  sessoes: BrowserSession[];
  totalLiberadas(): number;
} {
  const portais: string[] = [];
  const sessoes: BrowserSession[] = [];
  let liberadas = 0;
  const deps: DepsExecutor = {
    criarSessao: async (portal: string) => {
      portais.push(portal);
      const sessaoFilha = {
        portal,
        liberar: async () => {
          liberadas += 1;
        },
      } as unknown as BrowserSession;
      sessoes.push(sessaoFilha);
      return sessaoFilha;
    },
  };
  return { deps, portais, sessoes, totalLiberadas: () => liberadas };
}

function montarDepsMunicipalComPagina(conteudo = '<html><body>form</body></html>'): {
  deps: DepsExecutor;
  responderMunicipal(status: number, url: string): void;
} {
  const ouvintes: Record<string, Array<(carga: unknown) => void>> = {};
  const pagina = {
    on: (evento: string, ouvinte: (carga: unknown) => void): void => {
      const lista = ouvintes[evento] ?? [];
      lista.push(ouvinte);
      ouvintes[evento] = lista;
    },
    off: (evento: string, ouvinte: (carga: unknown) => void): void => {
      const lista = ouvintes[evento] ?? [];
      ouvintes[evento] = lista.filter((atual) => atual !== ouvinte);
    },
    content: async (): Promise<string> => conteudo,
    url: (): string =>
      'https://servicosweb.sefaz.salvador.ba.gov.br/WebsiteV2/Sistemas/AlvaraCgaInternet/Modulos/Principal/AlvaraCgaEmissaoFichaResumidaFrm.aspx',
  };
  const deps: DepsExecutor = {
    criarSessao: async (portal: string) => {
      if (portal === 'PREF_SALVADOR') {
        return { portal, page: pagina, liberar: async () => undefined } as unknown as BrowserSession;
      }
      return { portal, liberar: async () => undefined } as unknown as BrowserSession;
    },
  };
  return {
    deps,
    responderMunicipal: (status: number, url: string) => {
      for (const ouvinte of ouvintes['response'] ?? []) {
        ouvinte({ status: () => status, url: () => url });
      }
    },
  };
}

describe('executor consulta-inscricoes', () => {  it('registra seu executor no carregamento do módulo', () => {
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
      executarConsultaInscricoes(
        montarExecucao('exe_ci_invalido', { cnpj: '123' }),
        sessao,
        montarDeps().deps,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      executarConsultaInscricoes(
        montarExecucao('exe_ci_payload', 'não-json{'),
        sessao,
        montarDeps().deps,
      ),
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
        montarDeps().deps,
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
      montarDeps().deps,
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
      montarDeps().deps,
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
        montarDeps().deps,
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
        montarDeps().deps,
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
      montarDeps().deps,
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
      montarDeps().deps,
    );
    expect(comArtefatos['pdfEstadualBase64']).toBe('cGRmLWJh');
    expect(comArtefatos['pdfMunicipalBase64']).toBe('cGRmLWZpY2hh');
    expect(comArtefatos['printEstadualBase64']).toBe('cHJpbnQtYmE=');
    expect(comArtefatos['printMunicipalBase64']).toBe('cHJpbnQtZmljaGE=');
    const semArtefatos: ResultadoExecutor = await executarConsultaInscricoes(
      montarExecucao('exe_ci_sem_art', { cnpj: CNPJ_DIGITOS }),
      sessao,
      montarDeps().deps,
    );
    expect(semArtefatos['pdfEstadualBase64']).toBeUndefined();
    expect(semArtefatos['pdfMunicipalBase64']).toBeUndefined();
    expect(semArtefatos['printEstadualBase64']).toBeUndefined();
    expect(semArtefatos['printMunicipalBase64']).toBeUndefined();
  });

  it('abre uma sessão por portal e entrega a sessão própria a cada filho', async () => {
    const sessoesFilhas: Record<string, BrowserSession | undefined> = {};
    registrarExecutor('sefaz-bahia', async (_execucao, sessaoFilha) => {
      sessoesFilhas['estadual'] = sessaoFilha;
      return { sucesso: true, dados: { inscricaoEstadual: '123456789' } };
    });
    registrarExecutor('ficha-cadastral', async (_execucao, sessaoFilha) => {
      sessoesFilhas['municipal'] = sessaoFilha;
      return { sucesso: true, dados: { inscricaoMunicipal: '7654321' } };
    });
    const fabricadas = montarDeps();
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_sessoes', { cnpj: CNPJ_DIGITOS }),
      sessao,
      fabricadas.deps,
    );
    expect(resultado['sucesso']).toBe(true);
    expect(fabricadas.portais).toEqual(['SEFAZ_BA', 'PREF_SALVADOR']);
    expect(fabricadas.sessoes).toHaveLength(2);
    expect(sessoesFilhas['estadual']).toBe(fabricadas.sessoes[0]);
    expect(sessoesFilhas['municipal']).toBe(fabricadas.sessoes[1]);
    expect(sessoesFilhas['estadual']).not.toBe(sessoesFilhas['municipal']);
    expect(sessoesFilhas['estadual']).not.toBe(sessao);
    expect(sessoesFilhas['municipal']).not.toBe(sessao);
    expect(fabricadas.totalLiberadas()).toBe(2);
  });

  it('fecha as duas sessões quando um filho falha', async () => {
    registrarExecutor('sefaz-bahia', async () => {
      throw new Error('portal fora do ar');
    });
    registrarExecutor('ficha-cadastral', async () => ({
      sucesso: true,
      dados: { inscricaoMunicipal: '7654321' },
    }));
    const fabricadas = montarDeps();
    await expect(
      executarConsultaInscricoes(
        montarExecucao('exe_ci_fecha_erro', { cnpj: CNPJ_DIGITOS }),
        sessao,
        fabricadas.deps,
      ),
    ).rejects.toBeInstanceOf(EtapaError);
    expect(fabricadas.portais).toEqual(['SEFAZ_BA', 'PREF_SALVADOR']);
    expect(fabricadas.totalLiberadas()).toBe(2);
  });

  it('fecha a sessão criada quando a segunda criação falha', async () => {
    let estaduais = 0;
    let liberadasEstadual = 0;
    const deps: DepsExecutor = {
      criarSessao: async (portal: string) => {
        if (portal === 'PREF_SALVADOR') {
          throw new BrowserError('Navegador falhou ao iniciar');
        }
        estaduais += 1;
        return {
          liberar: async () => {
            liberadasEstadual += 1;
          },
        } as unknown as BrowserSession;
      },
    };
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
      executarConsultaInscricoes(
        montarExecucao('exe_ci_criacao_falha', { cnpj: CNPJ_DIGITOS }),
        sessao,
        deps,
      ),
    ).rejects.toBeInstanceOf(BrowserError);
    expect(estaduais).toBe(1);
    expect(liberadasEstadual).toBe(1);
    expect(chamadasEstadual).toBe(0);
    expect(chamadasMunicipal).toBe(0);
  });

  it('exige fábrica de sessões e não aciona os filhos sem ela', async () => {
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
      executarConsultaInscricoes(montarExecucao('exe_ci_sem_deps', { cnpj: CNPJ_DIGITOS }), sessao),
    ).rejects.toBeInstanceOf(InternalError);
    expect(chamadasEstadual).toBe(0);
    expect(chamadasMunicipal).toBe(0);
  });

  it('mantém compatível executor de dois parâmetros', async () => {
    const executorDuas: Executor = async (execucao) => ({ eco: execucao.id });
    registrarExecutor('sefaz-bahia', executorDuas);
    const executor = obterExecutor('sefaz-bahia');
    const resultado = await executor(
      montarExecucao('exe_ci_compativel', { cnpj: CNPJ_DIGITOS }),
      sessao,
      montarDeps().deps,
    );
    expect(resultado).toEqual({ eco: 'exe_ci_compativel' });
  });

  it('degrada para sucesso parcial com aviso quando a ficha cai por HTTP 500', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: {
        inscricaoEstadual: '123456789',
        situacaoCadastral: 'ATIVO',
        dataSituacaoCadastral: '01/02/2024',
      },
    }));
    registrarExecutor('ficha-cadastral', async () => {
      throw new EtapaError(
        'aguardar-download',
        'HTTP 500 do portal: Crystal Reports falhou ao gerar o relatório oficial',
      );
    });
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_ficha_500', { cnpj: CNPJ_DIGITOS }),
      sessao,
      montarDeps().deps,
    );
    expect(resultado['sucesso']).toBe(true);
    const dados = resultado['dados'] as Record<string, unknown>;
    expect(dados['cnpj']).toBe(CNPJ_DIGITOS);
    expect(dados['inscricaoEstadual']).toBe('123456789');
    expect(dados['situacaoEstadual']).toBe('ATIVO');
    expect(dados['inscricaoMunicipal']).toBeUndefined();
    expect(String(resultado['mensagem'])).toMatch(/parcial/i);
    expect(String(resultado['mensagem'])).toContain('Ficha Cadastral');
    expect(String(resultado['mensagem'])).toMatch(/indisponível/i);
  });

  it('degrada para sucesso parcial com aviso quando a ficha estoura o tempo', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: {
        inscricaoEstadual: '123456789',
        situacaoCadastral: 'ATIVO',
        dataSituacaoCadastral: '01/02/2024',
      },
    }));
    registrarExecutor('ficha-cadastral', async () => {
      throw new TimeoutError('Tempo esgotado durante navegar-portal');
    });
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_ficha_tempo', { cnpj: CNPJ_DIGITOS }),
      sessao,
      montarDeps().deps,
    );
    expect(resultado['sucesso']).toBe(true);
    const dados = resultado['dados'] as Record<string, unknown>;
    expect(dados['inscricaoEstadual']).toBe('123456789');
    expect(dados['inscricaoMunicipal']).toBeUndefined();
    expect(String(resultado['mensagem'])).toMatch(/parcial/i);
    expect(String(resultado['mensagem'])).toMatch(/indisponível/i);
  });

  it('degrada por resposta HTTP 500 observada mesmo sem marcador no texto do erro', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: {
        inscricaoEstadual: '123456789',
        situacaoCadastral: 'ATIVO',
        dataSituacaoCadastral: '01/02/2024',
      },
    }));
    const armadilha = montarDepsMunicipalComPagina();
    registrarExecutor('ficha-cadastral', async () => {
      armadilha.responderMunicipal(
        500,
        'https://servicosweb.sefaz.salvador.ba.gov.br/WebsiteV2/Sistemas/AlvaraCgaInternet/Modulos/Principal/AlvaraCgaEmissaoFichaResumidaFrm.aspx',
      );
      throw new EtapaError(
        'aguardar-download',
        'PDF oficial não baixado e nenhuma mensagem do portal foi encontrada.',
      );
    });
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_ficha_sinal_http', { cnpj: CNPJ_DIGITOS }),
      sessao,
      armadilha.deps,
    );
    expect(resultado['sucesso']).toBe(true);
    const dados = resultado['dados'] as Record<string, unknown>;
    expect(dados['inscricaoEstadual']).toBe('123456789');
    expect(String(resultado['mensagem'])).toMatch(/parcial/i);
    expect(String(resultado['mensagem'])).toMatch(/indisponível/i);
  });

  it('degrada por página de erro do portal mesmo sem marcador no texto do erro', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: {
        inscricaoEstadual: '123456789',
        situacaoCadastral: 'ATIVO',
        dataSituacaoCadastral: '01/02/2024',
      },
    }));
    const armadilha = montarDepsMunicipalComPagina(
      '<html><head><title>Server Error</title></head><body><h1>Server Error in \'/\' Application.</h1><p>Runtime Error: Crystal Reports.</p></body></html>',
    );
    registrarExecutor('ficha-cadastral', async () => {
      throw new EtapaError(
        'aguardar-download',
        'PDF oficial não baixado e nenhuma mensagem do portal foi encontrada.',
      );
    });
    const resultado = await executarConsultaInscricoes(
      montarExecucao('exe_ci_ficha_ysod', { cnpj: CNPJ_DIGITOS }),
      sessao,
      armadilha.deps,
    );
    expect(resultado['sucesso']).toBe(true);
    const dados = resultado['dados'] as Record<string, unknown>;
    expect(dados['inscricaoEstadual']).toBe('123456789');
    expect(String(resultado['mensagem'])).toMatch(/parcial/i);
    expect(String(resultado['mensagem'])).toMatch(/indisponível/i);
  });

  it('mantém falha honesta quando o PDF não baixa sem sinal de portal fora', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: { inscricaoEstadual: '123456789' },
    }));
    registrarExecutor('ficha-cadastral', async () => {
      throw new EtapaError(
        'aguardar-download',
        'PDF oficial não baixado e nenhuma mensagem do portal foi encontrada.',
      );
    });
    let erro: unknown = null;
    try {
      await executarConsultaInscricoes(
        montarExecucao('exe_ci_pdf_ausente', { cnpj: CNPJ_DIGITOS }),
        sessao,
        montarDeps().deps,
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(EtapaError);
    expect((erro as EtapaError).etapa).toBe('consultar-municipal');
  });

  it('mantém falha honesta quando o filho municipal rejeita a entrada', async () => {
    registrarExecutor('sefaz-bahia', async () => ({
      sucesso: true,
      dados: { inscricaoEstadual: '123456789' },
    }));
    registrarExecutor('ficha-cadastral', async () => {
      throw new ValidationError('CNPJ inválido: deve conter 14 dígitos');
    });
    let erro: unknown = null;
    try {
      await executarConsultaInscricoes(
        montarExecucao('exe_ci_mun_invalido', { cnpj: CNPJ_DIGITOS }),
        sessao,
        montarDeps().deps,
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(EtapaError);
    expect((erro as EtapaError).etapa).toBe('consultar-municipal');
  });
});
