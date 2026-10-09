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
  AppError,
  BrowserError,
  CaptchaError,
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

interface RespostaMunicipalObservada {
  status: number;
  url: string;
}

interface SondaMunicipal {
  respostas: RespostaMunicipalObservada[];
  falhasRede: string[];
  soltar(): void;
}

const MARCADORES_INDISPONIBILIDADE_TEXTO: RegExp[] = [
  /http\s*5\d\d/,
  /status\s*5\d\d/,
  /\b50[0-9]\b/,
  /server error/,
  /runtime error/,
  /crystal/,
  /service unavailable/,
  /bad gateway/,
  /gateway timeout/,
  /portal.*(indispon|fora do ar|em manuten|instab)/,
  /sefaz.*(indispon|fora do ar|instab)/,
  /relat[óo]rio.*(falhou|erro|indispon)/,
  /erro interno do servidor/,
  /tempo esgotado/,
  /timeout/,
  /econnrefused/,
  /econnreset/,
  /enotfound/,
  /eai_again/,
  /socket hang up/,
  /net::err_/,
  /navegador falhou/,
];

const MARCADORES_INDISPONIBILIDADE_PAGINA: RegExp[] = [
  /server error/,
  /runtime error/,
  /crystal/,
  /service unavailable/,
  /bad gateway/,
  /gateway timeout/,
  /aspxerrorpath/,
  /erro interno do servidor/,
  /portal.*(indispon|em manuten)/,
];

const MARCADOR_FALHA_REDE: RegExp =
  /refused|reset|timed out|unreachable|enotfound|eai_again|econn|net::err_|dns/i;

function causasDoErro(erro: unknown): Error[] {
  const cadeia: Error[] = [];
  const visitados = new Set<Error>();
  let atual: unknown = erro;
  while (atual instanceof Error && !visitados.has(atual)) {
    visitados.add(atual);
    cadeia.push(atual);
    atual = atual.cause;
  }
  return cadeia;
}

function indicaIndisponibilidadeNaCadeia(cadeia: Error[]): boolean | null {
  if (cadeia.some((item) => item instanceof ValidationError || item instanceof CaptchaError)) {
    return false;
  }
  const comTempoEsgotado = cadeia.some(
    (item) =>
      item instanceof TimeoutError ||
      item.name.startsWith('Timeout') ||
      (item instanceof AppError && item.code === 'TIMEOUT'),
  );
  if (comTempoEsgotado) {
    return true;
  }
  if (cadeia.some((item) => item instanceof BrowserError)) {
    return true;
  }
  const texto = cadeia
    .map((item) => item.message)
    .join(' | ')
    .toLowerCase();
  if (MARCADORES_INDISPONIBILIDADE_TEXTO.some((marcador) => marcador.test(texto))) {
    return true;
  }
  return null;
}

function lerStatusResposta(carga: unknown): number | null {
  if (typeof carga !== 'object' || carga === null) {
    return null;
  }
  const status = (carga as { status?: unknown }).status;
  if (typeof status !== 'function') {
    return null;
  }
  const valor = (status as () => unknown).call(carga);
  return typeof valor === 'number' ? valor : null;
}

function lerUrlResposta(carga: unknown): string {
  if (typeof carga !== 'object' || carga === null) {
    return '';
  }
  const url = (carga as { url?: unknown }).url;
  if (typeof url !== 'function') {
    return '';
  }
  const valor = (url as () => unknown).call(carga);
  return typeof valor === 'string' ? valor : '';
}

function lerTextoFalhaRequisicao(carga: unknown): string {
  if (typeof carga !== 'object' || carga === null) {
    return '';
  }
  const falha = (carga as { failure?: unknown }).failure;
  if (typeof falha !== 'function') {
    return '';
  }
  const resultado = (falha as () => unknown).call(carga);
  if (typeof resultado !== 'object' || resultado === null) {
    return '';
  }
  const texto = (resultado as { errorText?: unknown }).errorText;
  return typeof texto === 'string' ? texto : '';
}

function sondarSessaoMunicipal(sessao: BrowserSession): SondaMunicipal {
  const sonda: SondaMunicipal = {
    respostas: [],
    falhasRede: [],
    soltar: () => undefined,
  };
  const pagina = sessao.page as unknown;
  if (typeof pagina !== 'object' || pagina === null) {
    return sonda;
  }
  const ganchos = pagina as { on?: unknown; off?: unknown };
  if (typeof ganchos.on !== 'function') {
    return sonda;
  }
  const registrar = ganchos.on as (evento: string, ouvinte: (carga: unknown) => void) => unknown;
  const aoResponder = (carga: unknown): void => {
    const status = lerStatusResposta(carga);
    if (status === null) {
      return;
    }
    sonda.respostas.push({ status, url: lerUrlResposta(carga) });
  };
  const aoFalhar = (carga: unknown): void => {
    const texto = lerTextoFalhaRequisicao(carga);
    if (texto !== '') {
      sonda.falhasRede.push(texto);
    }
  };
  registrar.call(pagina, 'response', aoResponder);
  registrar.call(pagina, 'requestfailed', aoFalhar);
  sonda.soltar = () => {
    if (typeof ganchos.off === 'function') {
      const remover = ganchos.off as (evento: string, ouvinte: (carga: unknown) => void) => unknown;
      remover.call(pagina, 'response', aoResponder);
      remover.call(pagina, 'requestfailed', aoFalhar);
    }
  };
  return sonda;
}

async function lerConteudoMunicipal(sessao: BrowserSession): Promise<string> {
  const pagina = sessao.page as unknown;
  if (typeof pagina !== 'object' || pagina === null) {
    return '';
  }
  const conteudo = (pagina as { content?: unknown }).content;
  if (typeof conteudo !== 'function') {
    return '';
  }
  try {
    const html = await (conteudo as () => Promise<unknown>).call(pagina);
    return typeof html === 'string' ? html : '';
  } catch {
    return '';
  }
}

function lerUrlMunicipal(sessao: BrowserSession): string {
  const pagina = sessao.page as unknown;
  if (typeof pagina !== 'object' || pagina === null) {
    return '';
  }
  const atual = (pagina as { url?: unknown }).url;
  if (typeof atual !== 'function') {
    return '';
  }
  try {
    const valor = (atual as () => unknown).call(pagina);
    return typeof valor === 'string' ? valor : '';
  } catch {
    return '';
  }
}

async function portalMunicipalForaDoAr(
  erro: unknown,
  sonda: SondaMunicipal,
  sessao: BrowserSession,
): Promise<boolean> {
  if (!(erro instanceof Error)) {
    return false;
  }
  const cadeia = causasDoErro(erro);
  const veredito = indicaIndisponibilidadeNaCadeia(cadeia);
  if (veredito !== null) {
    return veredito;
  }
  if (sonda.respostas.some((resposta) => resposta.status >= 500)) {
    return true;
  }
  if (sonda.falhasRede.some((falha) => MARCADOR_FALHA_REDE.test(falha))) {
    return true;
  }
  const conteudo = (await lerConteudoMunicipal(sessao)).toLowerCase();
  if (
    conteudo !== '' &&
    MARCADORES_INDISPONIBILIDADE_PAGINA.some((marcador) => marcador.test(conteudo))
  ) {
    return true;
  }
  const url = lerUrlMunicipal(sessao).toLowerCase();
  if (url !== '' && MARCADORES_INDISPONIBILIDADE_PAGINA.some((marcador) => marcador.test(url))) {
    return true;
  }
  return false;
}

function detalheFalhaMunicipal(erro: unknown): string {
  if (erro instanceof Error) {
    const cadeia = causasDoErro(erro);
    for (const causa of cadeia) {
      if (causa instanceof EtapaError && causa.etapa !== ETAPA_MUNICIPAL.etapa) {
        return causa.message;
      }
    }
    const ultima = cadeia[cadeia.length - 1];
    if (ultima !== undefined) {
      return ultima.message;
    }
    return erro.message;
  }
  return String(erro);
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
    const sonda = sondarSessaoMunicipal(sessaoMunicipal);
    try {
      const acompanhar = async (
        sub: SubEtapa,
        promessa: Promise<ResultadoExecutor>,
      ): Promise<ResultadoExecutor> => {
        const resultado = await promessa;
        publicar(execucao.id, execucao.attempts, `${sub.rotulo}: resposta recebida`);
        return resultado;
      };
      const embrulhar = async (
        sub: SubEtapa,
        promessa: Promise<ResultadoExecutor>,
      ): Promise<{ valor: ResultadoExecutor } | { erro: unknown }> => {
        try {
          return { valor: await acompanhar(sub, promessa) };
        } catch (erro) {
          return { erro };
        }
      };
      const [liquidEstadual, liquidMunicipal] = await comTimeout(
        Promise.all([
          embrulhar(
            ETAPA_ESTADUAL,
            consultarSubEtapa(ETAPA_ESTADUAL, execucao, sessaoEstadual, cnpj, artefatos),
          ),
          embrulhar(
            ETAPA_MUNICIPAL,
            consultarSubEtapa(ETAPA_MUNICIPAL, execucao, sessaoMunicipal, cnpj, artefatos),
          ),
        ]),
        CONSULTA_INSCRICOES_TIMEOUT_MS,
        'consulta-inscricoes',
      );
      sonda.soltar();
      if ('erro' in liquidEstadual) {
        throw liquidEstadual.erro;
      }
      if ('erro' in liquidMunicipal) {
        const foraDoAr = await portalMunicipalForaDoAr(liquidMunicipal.erro, sonda, sessaoMunicipal);
        if (!foraDoAr) {
          throw liquidMunicipal.erro;
        }
        publicar(
          execucao.id,
          execucao.attempts,
          'Ficha Cadastral indisponível — seguindo com os dados estaduais',
        );
        const municipalDegradado: ResultadoExecutor = {
          sucesso: false,
          dados: {},
          mensagem: `Portal indisponível: ${detalheFalhaMunicipal(liquidMunicipal.erro)}`,
        };
        return comporResultado(execucao, cnpj, artefatos, liquidEstadual.valor, municipalDegradado);
      }
      return comporResultado(execucao, cnpj, artefatos, liquidEstadual.valor, liquidMunicipal.valor);
    } finally {
      sonda.soltar();
    }
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
