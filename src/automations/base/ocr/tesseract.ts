import Tesseract from 'tesseract.js';

type TrabalhadorOcr = Awaited<ReturnType<typeof Tesseract.createWorker>>;

const IDIOMA_RECONHECIMENTO = 'por';
const DIRETORIO_CACHE_MODELO = './data';

let trabalhadorAtual: TrabalhadorOcr | null = null;
let fila: Promise<void> = Promise.resolve();

async function obterTrabalhador(): Promise<TrabalhadorOcr> {
  if (trabalhadorAtual === null) {
    trabalhadorAtual = await Tesseract.createWorker(IDIOMA_RECONHECIMENTO, undefined, {
      cachePath: DIRETORIO_CACHE_MODELO,
    });
  }
  return trabalhadorAtual;
}

export async function reconhecerTextoTesseract(buffer: Buffer): Promise<string> {
  const tarefa: Promise<string> = fila.then(async (): Promise<string> => {
    const trabalhador = await obterTrabalhador();
    const resultado = await trabalhador.recognize(buffer);
    return resultado.data.text.trim();
  });
  fila = tarefa.then(
    (): void => undefined,
    (): void => undefined,
  );
  return tarefa;
}
