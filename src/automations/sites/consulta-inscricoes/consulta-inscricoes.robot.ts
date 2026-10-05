import { z } from 'zod';
import { PORTAL_DO_TIPO, type TipoAutomacao } from '../../../automations/registry.js';
import type { Execucao } from '../../../database/index.js';
import type { BrowserSession } from '../../../modules/browser/browser.types.js';
import {
  obterCanalProgresso,
  obterExecutor,
  registrarExecutor,
  type DepsExecutor,
  type ResultadoExecutor,
} from '../../../modules/jobs/index.js';
import {
  EtapaError,
  InternalError,
  TimeoutError,
  ValidationError,
} from '../../../shared/errors/index.js';

export const CONSULTA_INSCRICOES_TIMEOUT_MS = 180000;

export const consultaInscricoesInputSchema = z.object({
  cnpj: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 14, 'CNPJ inválido: deve conter 14 dígitos'),
});

export type ConsultaInscricoesParams = z.infer<typeof consultaInscricoesInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface SubEtapa {
  tipo: TipoAutomacao;
  etapa: string;
  rotulo: string;
}

const ETAPA_ESTADUAL: SubEtapa = {
  tipo: 'sefaz-bahia',
  etapa: 'consultar-estadual',
  rotulo: 'SEFAZ Bahia',
};

const ETAPA_MUNICIPAL: SubEtapa = {
  tipo: 'ficha-cadastral',
  etapa: 'consultar-municipal',
  rotulo: 'Ficha Cadastral',
};

function publicar(execucaoId: string, tentativa: number, etapa: string): void {
  obterCanalProgresso().publicar({
    execucaoId,
    status: 'RUNNING',
    posicaoFila: null,
    etapa,
    tentativa,
  });
}

function validarPayload(payload: string): { cnpj: string; artefatos: ArtefatosEscolha } {
  let bruto: unknown;
  try {
    bruto = JSON.parse(payload) as unknown;
  } catch {
    throw new ValidationError('Payload da execução inválido: JSON malformado');
  }
  if (typeof bruto !== 'object' || bruto === null) {
    throw new ValidationError('Payload da execução inválido: objeto esperado');
  }
  const registro = bruto as Record<string, unknown>;
  const entrada = consultaInscricoesInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { cnpj: entrada.data.cnpj, artefatos: artefatos.data };
}

function normalizarErro(etapa: string, rotulo: string, erro: unknown): EtapaError {
  const detalhe = erro instanceof Error ? erro.message : String(erro);
  return new EtapaError(etapa, `${rotulo} falhou: ${detalhe}`, { cause: erro });
}

async function comTimeout<T>(promessa: Promise<T>, ms: number, etapa: string): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    const teto = new Promise<never>((_, rejeitar) => {
      temporizador = setTimeout(() => {
        rejeitar(new TimeoutError(`Tempo esgotado durante ${etapa}`));
      }, ms);
    });
    return await Promise.race([promessa, teto]);
  } finally {
    if (temporizador !== undefined) {
      clearTimeout(temporizador);
    }
  }
}

function exigirFabrica(deps: DepsExecutor | undefined): DepsExecutor {
  if (deps?.criarSessao === undefined) {
    throw new InternalError('Consulta de inscrições exige fábrica de sessões por portal');
  }
  return deps;
}

async function encerrarSessoes(sessoes: BrowserSession[]): Promise<void> {
  await Promise.allSettled(sessoes.map((sessao) => sessao.liberar()));
}

async function consultarSubEtapa(
  sub: SubEtapa,
  execucao: Execucao,
  sessao: BrowserSession,
  cnpj: string,
  artefatos: ArtefatosEscolha,
): Promise<ResultadoExecutor> {
  const executorFilho = obterExecutor(sub.tipo);
  const execucaoFilha: Execucao = {
    ...execucao,
    tipo: sub.tipo,
    payload: JSON.stringify({ cnpj, artefatos }),
  };
  publicar(execucao.id, execucao.attempts, `Consultando ${sub.rotulo} para o CNPJ ${cnpj}`);
  try {
    return await executorFilho(execucaoFilha, sessao);
  } catch (erro) {
    throw normalizarErro(sub.etapa, sub.rotulo, erro);
  }
}

function comoRegistro(valor: unknown): Record<string, unknown> {
  if (typeof valor === 'object' && valor !== null) {
    return valor as Record<string, unknown>;
  }
  return {};
}

function textoDe(registro: Record<string, unknown>, chave: string): string {
  const valor = registro[chave];
  return typeof valor === 'string' ? valor : '';
}

function semSufixoMe(valor: string): string {
  return valor.replace(/\/ME$/i, '');
}

function agregarArtefatos(
  saida: Record<string, unknown>,
  estadual: ResultadoExecutor,
  municipal: ResultadoExecutor,
): void {
  const pdfEstadual = textoDe(estadual, 'pdfBase64');
  if (pdfEstadual !== '') {
    saida['pdfEstadualBase64'] = pdfEstadual;
  }
  const pdfMunicipal = textoDe(municipal, 'pdfBase64');
  if (pdfMunicipal !== '') {
    saida['pdfMunicipalBase64'] = pdfMunicipal;
  }
  const printEstadual = textoDe(estadual, 'printBase64');
  if (printEstadual !== '') {
    saida['printEstadualBase64'] = printEstadual;
  }
  const printMunicipal = textoDe(municipal, 'printBase64');
  if (printMunicipal !== '') {
    saida['printMunicipalBase64'] = printMunicipal;
  }
}

export const executarConsultaInscricoes = async (
  execucao: Execucao,
  _sessao: BrowserSession,
  deps?: DepsExecutor,
): Promise<ResultadoExecutor> => {
  const { cnpj, artefatos } = validarPayload(execucao.payload);
  const fabrica = exigirFabrica(deps);
  publicar(execucao.id, execucao.attempts, `Iniciando consulta de inscrições para o CNPJ ${cnpj}`);
  const sessoes: BrowserSession[] = [];
  try {
    const sessaoEstadual = await fabrica.criarSessao(PORTAL_DO_TIPO[ETAPA_ESTADUAL.tipo]);
    sessoes.push(sessaoEstadual);
    const sessaoMunicipal = await fabrica.criarSessao(PORTAL_DO_TIPO[ETAPA_MUNICIPAL.tipo]);
    sessoes.push(sessaoMunicipal);
    const acompanhar = async (
      sub: SubEtapa,
      promessa: Promise<ResultadoExecutor>,
    ): Promise<ResultadoExecutor> => {
      const resultado = await promessa;
      publicar(execucao.id, execucao.attempts, `${sub.rotulo}: resposta recebida`);
      return resultado;
    };
    const [estadual, municipal] = await comTimeout(
      Promise.all([
        acompanhar(
          ETAPA_ESTADUAL,
          consultarSubEtapa(ETAPA_ESTADUAL, execucao, sessaoEstadual, cnpj, artefatos),
        ),
        acompanhar(
          ETAPA_MUNICIPAL,
          consultarSubEtapa(ETAPA_MUNICIPAL, execucao, sessaoMunicipal, cnpj, artefatos),
        ),
      ]),
      CONSULTA_INSCRICOES_TIMEOUT_MS,
      'consulta-inscricoes',
    );
    return comporResultado(execucao, cnpj, artefatos, estadual, municipal);
  } finally {
    await encerrarSessoes(sessoes);
  }
};

function comporResultado(
  execucao: Execucao,
  cnpj: string,
  artefatos: ArtefatosEscolha,
  estadual: ResultadoExecutor,
  municipal: ResultadoExecutor,
): ResultadoExecutor {
  const dados: Record<string, unknown> = { cnpj };
  const pendencias: string[] = [];
  if (estadual['sucesso'] === true) {
    const detalhe = comoRegistro(estadual['dados']);
    const inscricaoEstadual = semSufixoMe(textoDe(detalhe, 'inscricaoEstadual'));
    if (inscricaoEstadual !== '') {
      dados['inscricaoEstadual'] = inscricaoEstadual;
    }
    const situacao = textoDe(detalhe, 'situacaoCadastral');
    if (situacao !== '') {
      dados['situacaoEstadual'] = situacao;
    }
    const dataSituacao = textoDe(detalhe, 'dataSituacaoCadastral');
    if (dataSituacao !== '') {
      dados['dataSituacaoEstadual'] = dataSituacao;
    }
    publicar(
      execucao.id,
      execucao.attempts,
      `Inscrição Estadual obtida: ${inscricaoEstadual === '' ? 'não encontrada' : inscricaoEstadual}`,
    );
  } else {
    const motivo = textoDe(estadual, 'mensagem');
    pendencias.push(`SEFAZ Bahia: ${motivo === '' ? 'consulta sem sucesso' : motivo}`);
  }
  if (municipal['sucesso'] === true) {
    const detalhe = comoRegistro(municipal['dados']);
    const inscricaoMunicipal = textoDe(detalhe, 'inscricaoMunicipal');
    if (inscricaoMunicipal !== '') {
      dados['inscricaoMunicipal'] = inscricaoMunicipal;
    }
    const situacao = textoDe(detalhe, 'situacaoCadastral');
    if (situacao !== '') {
      dados['situacaoMunicipal'] = situacao;
    }
    const dataInscricao = textoDe(detalhe, 'dataInscricaoPrefeitura');
    if (dataInscricao !== '') {
      dados['dataInscricaoPrefeitura'] = dataInscricao;
    }
    publicar(
      execucao.id,
      execucao.attempts,
      `Inscrição Municipal obtida: ${inscricaoMunicipal === '' ? 'não encontrada' : inscricaoMunicipal}`,
    );
  } else {
    const motivo = textoDe(municipal, 'mensagem');
    pendencias.push(`Ficha Cadastral: ${motivo === '' ? 'consulta sem sucesso' : motivo}`);
  }
  const temEstadual = typeof dados['inscricaoEstadual'] === 'string';
  const temMunicipal = typeof dados['inscricaoMunicipal'] === 'string';
  if (!temEstadual && !temMunicipal) {
    return {
      sucesso: false,
      dados: { cnpj },
      mensagem: `Nenhuma inscrição encontrada para o CNPJ ${cnpj}. ${pendencias.join('; ')}`,
    };
  }
  const saida: Record<string, unknown> = {
    sucesso: true,
    dados,
    mensagem:
      pendencias.length === 0
        ? 'Consulta de inscrições realizada com sucesso.'
        : `Consulta parcial de inscrições realizada. ${pendencias.join('; ')}`,
  };
  if (artefatos !== 'nenhum') {
    agregarArtefatos(saida, estadual, municipal);
  }
  publicar(execucao.id, execucao.attempts, 'Consulta de inscrições concluída');
  return saida;
}

registrarExecutor('consulta-inscricoes', executarConsultaInscricoes);
