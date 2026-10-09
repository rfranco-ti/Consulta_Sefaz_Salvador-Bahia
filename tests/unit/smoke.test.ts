import { describe, expect, it } from 'vitest';
import { TIPOS_AUTOMACAO } from '../../src/automations/registry.js';
import {
  INTERVALO_POLL_MS,
  ORCAMENTO_POR_ROBOT_MS,
  calcularExitCode,
  deveContinuarPoll,
  ehStatusTerminal,
  estourouOrcamento,
  filtrarPlano,
  formatarDuracao,
  lerPlanoSmoke,
  linhaDeEntradaInvalida,
  linhaDeSkip,
  linhaDeTimeout,
  linhaDoDesfecho,
  montarRelatorio,
  nomeVariavelDoTipo,
  parsearApenas,
  validarPayloadDoTipo,
  type ItemPlano,
  type LinhaRelatorio,
} from '../../scripts/smoke-nucleo.js';

const VARIAVEIS_VALIDAS: Record<string, string> = {
  SMOKE_SEFAZ_BAHIA: JSON.stringify({ cnpj: '12345678000190' }),
  SMOKE_SEFAZ_BAHIA_INSCRICAO: JSON.stringify({ inscricaoEstadual: '123456789' }),
  SMOKE_SEFAZ_BAHIA_SOCIO: JSON.stringify({ cpf: '12345678909' }),
  SMOKE_CONSULTA_INSCRICOES: JSON.stringify({ cnpj: '12345678000190' }),
  SMOKE_IPTU_SALVADOR: JSON.stringify({ numeroIptu: '12345' }),
  SMOKE_FICHA_CADASTRAL: JSON.stringify({ cnpj: '12345678000190' }),
  SMOKE_ALVARA_FUNCIONAMENTO: JSON.stringify({
    cnpj: '12345678000190',
    inscricaoMunicipal: '123456',
  }),
  SMOKE_CADIN_SALVADOR: JSON.stringify({ cnpj: '12345678000190' }),
  SMOKE_DAM_TFF_TLL: JSON.stringify({ cga: '123456', exercicio: '2026' }),
};

function linha(
  tipo: ItemPlano['tipo'],
  resultado: LinhaRelatorio['resultado'],
): LinhaRelatorio {
  return { tipo, resultado, duracaoMs: 1000, observacao: '' };
}

describe('nomeVariavelDoTipo', () => {
  it('converte hífen em sublinhado com caixa alta', () => {
    const esperadas: Record<string, string> = {
      'sefaz-bahia': 'SMOKE_SEFAZ_BAHIA',
      'sefaz-bahia-inscricao': 'SMOKE_SEFAZ_BAHIA_INSCRICAO',
      'sefaz-bahia-socio': 'SMOKE_SEFAZ_BAHIA_SOCIO',
      'consulta-inscricoes': 'SMOKE_CONSULTA_INSCRICOES',
      'iptu-salvador': 'SMOKE_IPTU_SALVADOR',
      'ficha-cadastral': 'SMOKE_FICHA_CADASTRAL',
      'alvara-funcionamento': 'SMOKE_ALVARA_FUNCIONAMENTO',
      'cadin-salvador': 'SMOKE_CADIN_SALVADOR',
      'dam-tff-tll': 'SMOKE_DAM_TFF_TLL',
    };
    for (const tipo of TIPOS_AUTOMACAO) {
      expect(nomeVariavelDoTipo(tipo)).toBe(esperadas[tipo]);
    }
  });
});

describe('lerPlanoSmoke', () => {
  it('sem variáveis marca tudo como pular na ordem de TIPOS_AUTOMACAO', () => {
    const plano = lerPlanoSmoke({});
    expect(plano.map((item) => item.tipo)).toEqual([...TIPOS_AUTOMACAO]);
    expect(plano).toHaveLength(9);
    for (const item of plano) {
      expect(item.acao).toBe('pular');
      expect(item.payload).toBeNull();
    }
  });

  it('variável vazia ou só espaços também pula', () => {
    const plano = lerPlanoSmoke({ SMOKE_SEFAZ_BAHIA: '   ', SMOKE_IPTU_SALVADOR: '' });
    const sefaz = plano.find((item) => item.tipo === 'sefaz-bahia');
    const iptu = plano.find((item) => item.tipo === 'iptu-salvador');
    expect(sefaz?.acao).toBe('pular');
    expect(iptu?.acao).toBe('pular');
  });

  it('payload válido de cada robot vira executar com dados normalizados', () => {
    const plano = lerPlanoSmoke(VARIAVEIS_VALIDAS);
    expect(plano.filter((item) => item.acao === 'executar')).toHaveLength(9);
    const sefaz = plano.find((item) => item.tipo === 'sefaz-bahia');
    expect(sefaz?.payload).toEqual({ cnpj: '12345678000190' });
    const dam = plano.find((item) => item.tipo === 'dam-tff-tll');
    expect(dam?.payload).toEqual({ inscricaoMunicipal: '123456', exercicio: '2026' });
  });

  it('normaliza CNPJ formatado para só dígitos', () => {
    const plano = lerPlanoSmoke({ SMOKE_FICHA_CADASTRAL: '{"cnpj":"12.345.678/0001-90"}' });
    const ficha = plano.find((item) => item.tipo === 'ficha-cadastral');
    expect(ficha?.acao).toBe('executar');
    expect(ficha?.payload).toEqual({ cnpj: '12345678000190' });
  });

  it('JSON inválido vira entrada inválida citando a variável sem derrubar as demais', () => {
    const plano = lerPlanoSmoke({
      SMOKE_SEFAZ_BAHIA: '{cnpj:',
      SMOKE_FICHA_CADASTRAL: '{"cnpj":"12345678000190"}',
    });
    const sefaz = plano.find((item) => item.tipo === 'sefaz-bahia');
    expect(sefaz?.acao).toBe('invalido');
    expect(sefaz?.mensagem).toContain('SMOKE_SEFAZ_BAHIA');
    const ficha = plano.find((item) => item.tipo === 'ficha-cadastral');
    expect(ficha?.acao).toBe('executar');
  });

  it('payload que viola o schema vira entrada inválida com a mensagem do zod', () => {
    const plano = lerPlanoSmoke({ SMOKE_SEFAZ_BAHIA: '{"cnpj":"123"}' });
    const sefaz = plano.find((item) => item.tipo === 'sefaz-bahia');
    expect(sefaz?.acao).toBe('invalido');
    expect(sefaz?.mensagem).toContain('CNPJ');
  });
});

describe('validarPayloadDoTipo', () => {
  it('aceita amostra válida e devolve o objeto canonizado', () => {
    const saida = validarPayloadDoTipo('iptu-salvador', { numeroIptu: '12345' });
    expect(saida).toEqual({ ok: true, payload: { numeroIptu: '12345' } });
  });

  it('rejeita documento curto com mensagem do zod', () => {
    const saida = validarPayloadDoTipo('cadin-salvador', { cnpj: '123' });
    expect(saida.ok).toBe(false);
    if (!saida.ok) {
      expect(saida.mensagem.length).toBeGreaterThan(0);
    }
  });

  it('rejeita valor que não é objeto', () => {
    const saida = validarPayloadDoTipo('sefaz-bahia', 'só-texto');
    expect(saida.ok).toBe(false);
  });
});

describe('decisão de polling', () => {
  it('PENDING e RUNNING continuam o poll', () => {
    expect(ehStatusTerminal('PENDING')).toBe(false);
    expect(ehStatusTerminal('RUNNING')).toBe(false);
    expect(deveContinuarPoll('PENDING')).toBe(true);
    expect(deveContinuarPoll('RUNNING')).toBe(true);
  });

  it('SUCCESS FAILED e CANCELLED são terminais', () => {
    expect(ehStatusTerminal('SUCCESS')).toBe(true);
    expect(ehStatusTerminal('FAILED')).toBe(true);
    expect(ehStatusTerminal('CANCELLED')).toBe(true);
    expect(deveContinuarPoll('SUCCESS')).toBe(false);
    expect(deveContinuarPoll('FAILED')).toBe(false);
    expect(deveContinuarPoll('CANCELLED')).toBe(false);
  });
});

describe('orçamento de timeout', () => {
  it('orçamento padrão por robot é 360 segundos', () => {
    expect(ORCAMENTO_POR_ROBOT_MS).toBe(360000);
    expect(INTERVALO_POLL_MS).toBeGreaterThan(0);
  });

  it('não estoura antes do limite', () => {
    expect(estourouOrcamento(1000, 2000)).toBe(false);
    expect(estourouOrcamento(0, ORCAMENTO_POR_ROBOT_MS - 1)).toBe(false);
  });

  it('estoura no limite exato e depois dele', () => {
    expect(estourouOrcamento(0, ORCAMENTO_POR_ROBOT_MS)).toBe(true);
    expect(estourouOrcamento(0, ORCAMENTO_POR_ROBOT_MS + 5000)).toBe(true);
  });

  it('aceita orçamento personalizado', () => {
    expect(estourouOrcamento(0, 5000, 10000)).toBe(false);
    expect(estourouOrcamento(0, 10000, 10000)).toBe(true);
  });
});

describe('linhas de resultado', () => {
  it('SUCCESS com sucesso true vira OK', () => {
    const saida = linhaDoDesfecho({
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      sucesso: true,
      duracaoMs: 1200,
      erro: null,
    });
    expect(saida).toEqual({ tipo: 'sefaz-bahia', resultado: 'OK', duracaoMs: 1200, observacao: '' });
  });

  it('SUCCESS com sucesso false vira FAIL', () => {
    const saida = linhaDoDesfecho({
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      sucesso: false,
      duracaoMs: 1200,
      erro: 'portal sem dados',
    });
    expect(saida.resultado).toBe('FAIL');
    expect(saida.observacao).toContain('portal sem dados');
  });

  it('FAILED carrega a mensagem de erro', () => {
    const saida = linhaDoDesfecho({
      tipo: 'dam-tff-tll',
      status: 'FAILED',
      sucesso: null,
      duracaoMs: 5000,
      erro: 'PORTAL_INDISPONIVEL: portal fora do ar',
    });
    expect(saida.resultado).toBe('FAIL');
    expect(saida.observacao).toContain('PORTAL_INDISPONIVEL');
  });

  it('FAILED sem mensagem usa o status como observação', () => {
    const saida = linhaDoDesfecho({
      tipo: 'dam-tff-tll',
      status: 'FAILED',
      sucesso: null,
      duracaoMs: 5000,
      erro: null,
    });
    expect(saida.resultado).toBe('FAIL');
    expect(saida.observacao).toContain('FAILED');
  });

  it('CANCELLED vira FAIL de cancelamento', () => {
    const saida = linhaDoDesfecho({
      tipo: 'iptu-salvador',
      status: 'CANCELLED',
      sucesso: null,
      duracaoMs: 300,
      erro: null,
    });
    expect(saida.resultado).toBe('FAIL');
    expect(saida.observacao).toContain('cancelada');
  });

  it('timeout informa os segundos decorridos', () => {
    const saida = linhaDeTimeout('dam-tff-tll', 360000);
    expect(saida).toEqual({
      tipo: 'dam-tff-tll',
      resultado: 'TIMEOUT',
      duracaoMs: 360000,
      observacao: 'sem conclusão em 360s',
    });
  });

  it('skip preserva o motivo e sem duração', () => {
    const saida = linhaDeSkip('sefaz-bahia', 'sem SMOKE_SEFAZ_BAHIA');
    expect(saida).toEqual({
      tipo: 'sefaz-bahia',
      resultado: 'SKIP',
      duracaoMs: null,
      observacao: 'sem SMOKE_SEFAZ_BAHIA',
    });
  });

  it('entrada inválida vira FAIL com a mensagem do plano', () => {
    const item: ItemPlano = {
      tipo: 'sefaz-bahia',
      acao: 'invalido',
      variavel: 'SMOKE_SEFAZ_BAHIA',
      payload: null,
      mensagem: 'cnpj: CNPJ inválido',
    };
    expect(linhaDeEntradaInvalida(item)).toEqual({
      tipo: 'sefaz-bahia',
      resultado: 'FAIL',
      duracaoMs: null,
      observacao: 'cnpj: CNPJ inválido',
    });
  });
});

describe('relatório e exit code', () => {
  it('formata duração em segundos com vírgula', () => {
    expect(formatarDuracao(null)).toBe('-');
    expect(formatarDuracao(0)).toBe('0,0s');
    expect(formatarDuracao(12345)).toBe('12,3s');
  });

  it('exit 0 sem linhas e com só OK e SKIP', () => {
    expect(calcularExitCode([])).toBe(0);
    expect(calcularExitCode([linha('sefaz-bahia', 'OK'), linha('iptu-salvador', 'SKIP')])).toBe(
      0,
    );
  });

  it('exit 1 com FAIL ou TIMEOUT', () => {
    expect(calcularExitCode([linha('sefaz-bahia', 'OK'), linha('iptu-salvador', 'FAIL')])).toBe(
      1,
    );
    expect(
      calcularExitCode([linha('sefaz-bahia', 'OK'), linha('dam-tff-tll', 'TIMEOUT')]),
    ).toBe(1);
  });

  it('monta tabela com cabeçalho linhas e resumo', () => {
    const relatorio = montarRelatorio([
      { tipo: 'sefaz-bahia', resultado: 'OK', duracaoMs: 12345, observacao: '' },
      { tipo: 'iptu-salvador', resultado: 'SKIP', duracaoMs: null, observacao: 'sem SMOKE_IPTU_SALVADOR' },
    ]);
    expect(relatorio.exitCode).toBe(0);
    expect(relatorio.texto).toContain('ROBOT | RESULTADO | DURACAO | OBS');
    expect(relatorio.texto).toContain('sefaz-bahia | OK | 12,3s | -');
    expect(relatorio.texto).toContain('iptu-salvador | SKIP | - | sem SMOKE_IPTU_SALVADOR');
    expect(relatorio.texto).toContain('Resumo: 1 ok, 0 fail, 1 skip, 0 timeout');
  });

  it('resumo conta fail e timeout com exit 1', () => {
    const relatorio = montarRelatorio([
      linha('sefaz-bahia', 'FAIL'),
      linha('dam-tff-tll', 'TIMEOUT'),
      linha('ficha-cadastral', 'OK'),
    ]);
    expect(relatorio.exitCode).toBe(1);
    expect(relatorio.texto).toContain('Resumo: 1 ok, 1 fail, 0 skip, 1 timeout');
  });
});

describe('parsearApenas', () => {
  it('sem --apenas devolve lista vazia e sem erro', () => {
    const parseado = parsearApenas(['outro-arg']);
    expect(parseado.tipos).toEqual([]);
    expect(parseado.erro).toBeNull();
  });

  it('lê tipos separados por vírgula preservando a ordem', () => {
    const parseado = parsearApenas(['--apenas', 'cadin-salvador, ficha-cadastral']);
    expect(parseado.erro).toBeNull();
    expect(parseado.tipos).toEqual(['cadin-salvador', 'ficha-cadastral']);
  });

  it('sem valor após --apenas devolve erro', () => {
    const parseado = parsearApenas(['--apenas']);
    expect(parseado.erro).toContain('ao menos um tipo');
    expect(parseado.tipos).toEqual([]);
  });

  it('tipo desconhecido devolve erro listando os nomes', () => {
    const parseado = parsearApenas(['--apenas', 'sefaz-bahia,robot-fantasma']);
    expect(parseado.erro).toBe('tipos desconhecidos em --apenas: robot-fantasma');
    expect(parseado.tipos).toEqual([]);
  });
});

describe('filtrarPlano', () => {
  it('lista vazia mantém o plano completo', () => {
    const plano = lerPlanoSmoke(VARIAVEIS_VALIDAS);
    expect(filtrarPlano(plano, [])).toEqual(plano);
  });

  it('mantém apenas os tipos pedidos e descarta os demais', () => {
    const plano = lerPlanoSmoke(VARIAVEIS_VALIDAS);
    const filtrado = filtrarPlano(plano, ['ficha-cadastral', 'dam-tff-tll']);
    expect(filtrado.map((item) => item.tipo)).toEqual(['ficha-cadastral', 'dam-tff-tll']);
  });

  it('filtra preservando itens que seriam pulados', () => {
    const plano = lerPlanoSmoke({});
    const filtrado = filtrarPlano(plano, ['iptu-salvador']);
    expect(filtrado).toHaveLength(1);
    expect(filtrado[0]?.acao).toBe('pular');
  });
});
