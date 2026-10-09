import { readFile } from 'node:fs/promises';
import Tesseract from 'tesseract.js';
import { InternalError } from '../../../shared/errors/index.js';
import { preprocessarCaptchaImagem } from './preprocessamento.js';

export interface ResultadoReconhecimento {
  texto: string;
  confianca: number;
}

export interface BlocoReconhecido {
  paragraphs: Array<{
    lines: Array<{
      words: Array<{
        symbols: Array<{ confidence: number }>;
      }>;
    }>;
  }>;
}

export interface DepsResolvedorCaptcha {
  reconhecer?: (buffer: Buffer) => Promise<ResultadoReconhecimento>;
}

export interface SimboloReconhecido {
  texto: string;
  confianca: number;
}

export interface LeituraOcr {
  texto: string;
  simbolos: SimboloReconhecido[];
}

export function combinarLeituras(
  primeira: LeituraOcr,
  segunda: LeituraOcr,
): { texto: string; confianca: number } {
  if (primeira.texto === segunda.texto) {
    return { texto: primeira.texto, confianca: mediaSimbolos(primeira.simbolos) };
  }
  const cincoPrimeira = primeira.texto.length === 5;
  const cincoSegunda = segunda.texto.length === 5;
  if (cincoPrimeira !== cincoSegunda) {
    const escolhida = cincoPrimeira ? primeira : segunda;
    return { texto: escolhida.texto, confianca: mediaSimbolos(escolhida.simbolos) };
  }
  if (
    primeira.texto.length !== 5 ||
    primeira.simbolos.length !== 5 ||
    segunda.simbolos.length !== 5
  ) {
    return { texto: primeira.texto, confianca: mediaSimbolos(primeira.simbolos) };
  }
  let montado = '';
  let soma = 0;
  for (let indice = 0; indice < 5; indice += 1) {
    const atual = primeira.simbolos[indice];
    const outro = segunda.simbolos[indice];
    if (atual === undefined || outro === undefined) {
      return { texto: primeira.texto, confianca: mediaSimbolos(primeira.simbolos) };
    }
    if (atual.texto === outro.texto) {
      montado += atual.texto;
      soma += atual.confianca;
    } else if (outro.confianca > atual.confianca) {
      montado += outro.texto;
      soma += outro.confianca;
    } else {
      montado += atual.texto;
      soma += atual.confianca;
    }
  }
  return { texto: montado, confianca: soma / 5 };
}

function mediaSimbolos(simbolos: SimboloReconhecido[]): number {
  let soma = 0;
  let quantidade = 0;
  for (const simbolo of simbolos) {
    if (Number.isFinite(simbolo.confianca)) {
      soma += simbolo.confianca;
      quantidade += 1;
    }
  }
  if (quantidade === 0) {
    return 0;
  }
  return soma / quantidade;
}

export function mediaConfiancaSimbolos(blocos: BlocoReconhecido[] | null | undefined): number {
  let soma = 0;
  let quantidade = 0;
  for (const bloco of blocos ?? []) {
    for (const paragrafo of bloco.paragraphs) {
      for (const linha of paragrafo.lines) {
        for (const palavra of linha.words) {
          for (const simbolo of palavra.symbols) {
            const confianca: number = simbolo.confidence;
            if (Number.isFinite(confianca)) {
              soma += confianca;
              quantidade += 1;
            }
          }
        }
      }
    }
  }
  if (quantidade === 0) {
    return 0;
  }
  return soma / quantidade;
}

const IDIOMA_OCR = 'por';
const IDIOMA_OCR_APOIO = 'eng';
const DIRETORIO_CACHE_MODELO = './data';
const LISTA_BRANCA_CARACTERES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LIMIAR_CONFIANCA = 0.75;
const TAMANHO_MINIMO_TEXTO = 3;
const TAMANHO_MAXIMO_TEXTO = 8;
const PADRAO_LIMPEZA_TEXTO = /[^A-Z0-9]/g;

interface EstadoWorker {
  ativo: Tesseract.Worker | null;
  promessa: Promise<Tesseract.Worker> | null;
}

const workerPrincipal: EstadoWorker = { ativo: null, promessa: null };
const workerApoio: EstadoWorker = { ativo: null, promessa: null };
const workerSegmentacao: EstadoWorker = { ativo: null, promessa: null };
let filaReconhecimento: Promise<void> = Promise.resolve();

async function criarWorkerCaptcha(
  idioma: string,
  modoSegmentacao: Tesseract.PSM,
): Promise<Tesseract.Worker> {
  const worker: Tesseract.Worker = await Tesseract.createWorker(idioma, undefined, {
    cachePath: DIRETORIO_CACHE_MODELO,
  });
  await worker.setParameters({
    tessedit_char_whitelist: LISTA_BRANCA_CARACTERES,
    tessedit_pageseg_mode: modoSegmentacao,
    user_defined_dpi: '300',
  });
  return worker;
}

async function obterWorker(
  estado: EstadoWorker,
  idioma: string,
  modoSegmentacao: Tesseract.PSM,
): Promise<Tesseract.Worker> {
  if (estado.ativo !== null) {
    return estado.ativo;
  }
  if (estado.promessa === null) {
    estado.promessa = criarWorkerCaptcha(idioma, modoSegmentacao);
  }
  try {
    const pronto: Tesseract.Worker = await estado.promessa;
    estado.ativo = pronto;
    return pronto;
  } catch (erro: unknown) {
    estado.promessa = null;
    throw erro;
  }
}

async function executarComFila<Tipo>(operacao: () => Promise<Tipo>): Promise<Tipo> {
  const anterior: Promise<void> = filaReconhecimento;
  let liberarFila: () => void = () => undefined;
  filaReconhecimento = new Promise<void>((resolver) => {
    liberarFila = resolver;
  });
  await anterior;
  try {
    return await operacao();
  } finally {
    liberarFila();
  }
}

function extrairLeitura(saida: Tesseract.RecognizeResult): LeituraOcr {
  const textoBruto: unknown = saida.data.text;
  const bruto: string = typeof textoBruto === 'string' ? textoBruto : '';
  const simbolos: SimboloReconhecido[] = [];
  for (const bloco of saida.data.blocks ?? []) {
    for (const paragrafo of bloco.paragraphs) {
      for (const linha of paragrafo.lines) {
        for (const palavra of linha.words) {
          for (const simbolo of palavra.symbols) {
            const digito = (simbolo.text ?? '').toUpperCase().replace(PADRAO_LIMPEZA_TEXTO, '');
            if (digito !== '') {
              simbolos.push({ texto: digito, confianca: simbolo.confidence });
            }
          }
        }
      }
    }
  }
  return { texto: bruto.toUpperCase().replace(PADRAO_LIMPEZA_TEXTO, ''), simbolos };
}

async function reconhecerViaTesseract(buffer: Buffer): Promise<ResultadoReconhecimento> {
  const principal: Tesseract.Worker = await obterWorker(
    workerPrincipal,
    IDIOMA_OCR,
    Tesseract.PSM.SINGLE_WORD,
  );
  const apoio: Tesseract.Worker = await obterWorker(
    workerApoio,
    IDIOMA_OCR_APOIO,
    Tesseract.PSM.AUTO,
  );
  const saidaPrincipal: Tesseract.RecognizeResult = await principal.recognize(
    buffer,
    {},
    { blocks: true },
  );
  const saidaApoio: Tesseract.RecognizeResult = await apoio.recognize(buffer, {}, { blocks: true });
  const combinado = combinarLeituras(extrairLeitura(saidaPrincipal), extrairLeitura(saidaApoio));
  if (combinado.confianca > 0) {
    const combinadoLimpo = combinado.texto.toUpperCase().replace(PADRAO_LIMPEZA_TEXTO, '');
    const combinadoNormalizado =
      combinado.confianca >= 1 ? combinado.confianca / 100 : combinado.confianca;
    if (
      combinadoNormalizado >= LIMIAR_CONFIANCA &&
      combinadoLimpo.length >= TAMANHO_MINIMO_TEXTO &&
      combinadoLimpo.length <= TAMANHO_MAXIMO_TEXTO
    ) {
      return { texto: combinado.texto, confianca: combinado.confianca };
    }
  }
  const segmentacao: Tesseract.Worker = await obterWorker(
    workerSegmentacao,
    IDIOMA_OCR,
    Tesseract.PSM.AUTO,
  );
  const saidaSegmentacao: Tesseract.RecognizeResult = await segmentacao.recognize(
    buffer,
    {},
    { blocks: true },
  );
  const leituraSegmentacao = extrairLeitura(saidaSegmentacao);
  const mediaSegmentacao = mediaConfiancaSimbolos(saidaSegmentacao.data.blocks);
  if (mediaSegmentacao > 0) {
    return { texto: leituraSegmentacao.texto, confianca: mediaSegmentacao };
  }
  const confiancaBruta: unknown = saidaSegmentacao.data.confidence;
  const confiancaCentena: number =
    typeof confiancaBruta === 'number' && Number.isFinite(confiancaBruta)
      ? confiancaBruta
      : 0;
  return { texto: leituraSegmentacao.texto, confianca: confiancaCentena };
}

async function encerrarEstado(estado: EstadoWorker): Promise<void> {
  const criacaoPendente: Promise<Tesseract.Worker> | null = estado.promessa;
  estado.promessa = null;
  const ativo: Tesseract.Worker | null = estado.ativo;
  estado.ativo = null;
  const alvo: Tesseract.Worker | null =
    ativo ?? (criacaoPendente === null ? null : await criacaoPendente.catch(() => null));
  if (alvo !== null) {
    await alvo.terminate().catch(() => undefined);
  }
}

export async function encerrarWorkerCaptcha(): Promise<void> {
  await encerrarEstado(workerPrincipal);
  await encerrarEstado(workerApoio);
  await encerrarEstado(workerSegmentacao);
}

export async function resolverCaptchaLocal(
  caminhoImagem: string,
  deps?: DepsResolvedorCaptcha,
): Promise<string> {
  let original: Buffer;
  try {
    original = await readFile(caminhoImagem);
  } catch {
    throw new InternalError(
      `Não foi possível ler a imagem do captcha em "${caminhoImagem}".`,
    );
  }
  let processado: Buffer;
  try {
    processado = await preprocessarCaptchaImagem(original);
  } catch {
    return '';
  }
  const reconhecer: (buffer: Buffer) => Promise<ResultadoReconhecimento> =
    deps?.reconhecer ?? reconhecerViaTesseract;
  let resultado: ResultadoReconhecimento;
  try {
    resultado = await executarComFila(() => reconhecer(processado));
  } catch {
    return '';
  }
  const confiancaCentena: number = resultado.confianca;
  const confiancaNormalizadaZeroUm: number =
    confiancaCentena >= 1 ? confiancaCentena / 100 : confiancaCentena;
  const textoLimpo: string = resultado.texto.toUpperCase().replace(PADRAO_LIMPEZA_TEXTO, '');
  if (confiancaNormalizadaZeroUm < LIMIAR_CONFIANCA) {
    return '';
  }
  if (textoLimpo.length < TAMANHO_MINIMO_TEXTO || textoLimpo.length > TAMANHO_MAXIMO_TEXTO) {
    return '';
  }
  return textoLimpo;
}
