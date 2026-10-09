import { createCanvas, loadImage } from '@napi-rs/canvas';

const FATOR_ESCALA = 4;
const BORDA_BRANCA_PX = 10;
const PESO_VERMELHO = 0.299;
const PESO_VERDE = 0.587;
const PESO_AZUL = 0.114;
const VALOR_MAXIMO_CANAL = 255;
const COR_FUNDO_BRANCO = '#ffffff';
const JANELA_MEDIANA_RAIO = 1;
const INDICE_MEDIANA_NOVE = 4;

function aplicarMediana(
  largura: number,
  altura: number,
  cinzas: Float64Array,
): Float64Array {
  const saida = new Float64Array(largura * altura);
  const janela: number[] = [];
  for (let linha = 0; linha < altura; linha += 1) {
    for (let coluna = 0; coluna < largura; coluna += 1) {
      janela.length = 0;
      for (let dy = -JANELA_MEDIANA_RAIO; dy <= JANELA_MEDIANA_RAIO; dy += 1) {
        for (let dx = -JANELA_MEDIANA_RAIO; dx <= JANELA_MEDIANA_RAIO; dx += 1) {
          const vizinhoX: number = Math.min(largura - 1, Math.max(0, coluna + dx));
          const vizinhoY: number = Math.min(altura - 1, Math.max(0, linha + dy));
          janela.push(cinzas[vizinhoY * largura + vizinhoX] ?? 0);
        }
      }
      janela.sort((primeiro: number, segundo: number) => primeiro - segundo);
      saida[linha * largura + coluna] = janela[INDICE_MEDIANA_NOVE] ?? 0;
    }
  }
  return saida;
}

export async function preprocessarCaptchaImagem(buffer: Buffer): Promise<Buffer> {
  const imagem = await loadImage(buffer);
  const larguraBase: number = Math.max(1, imagem.width);
  const alturaBase: number = Math.max(1, imagem.height);
  const rascunho = createCanvas(larguraBase, alturaBase);
  const contextoRascunho = rascunho.getContext('2d');
  contextoRascunho.drawImage(imagem, 0, 0, larguraBase, alturaBase);
  const dadosBase = contextoRascunho.getImageData(0, 0, larguraBase, alturaBase);
  const pixelsBase: Uint8ClampedArray = dadosBase.data;
  const quantidadeBase: number = larguraBase * alturaBase;
  const cinzas = new Float64Array(quantidadeBase);
  for (let indice = 0; indice < quantidadeBase; indice += 1) {
    const base: number = indice * 4;
    const vermelho: number = pixelsBase[base] ?? 0;
    const verde: number = pixelsBase[base + 1] ?? 0;
    const azul: number = pixelsBase[base + 2] ?? 0;
    cinzas[indice] = PESO_VERMELHO * vermelho + PESO_VERDE * verde + PESO_AZUL * azul;
  }
  const semRuido: Float64Array = aplicarMediana(larguraBase, alturaBase, cinzas);
  const telaDenoised = createCanvas(larguraBase, alturaBase);
  const contextoDenoised = telaDenoised.getContext('2d');
  const imagemDenoised = contextoDenoised.createImageData(larguraBase, alturaBase);
  for (let indice = 0; indice < quantidadeBase; indice += 1) {
    const tom: number = Math.min(
      VALOR_MAXIMO_CANAL,
      Math.max(0, Math.round(semRuido[indice] ?? 0)),
    );
    const base: number = indice * 4;
    imagemDenoised.data[base] = tom;
    imagemDenoised.data[base + 1] = tom;
    imagemDenoised.data[base + 2] = tom;
    imagemDenoised.data[base + 3] = VALOR_MAXIMO_CANAL;
  }
  contextoDenoised.putImageData(imagemDenoised, 0, 0);
  const larguraEscalada: number = larguraBase * FATOR_ESCALA;
  const alturaEscalada: number = alturaBase * FATOR_ESCALA;
  const tela = createCanvas(
    larguraEscalada + BORDA_BRANCA_PX * 2,
    alturaEscalada + BORDA_BRANCA_PX * 2,
  );
  const contexto = tela.getContext('2d');
  contexto.fillStyle = COR_FUNDO_BRANCO;
  contexto.fillRect(0, 0, tela.width, tela.height);
  contexto.imageSmoothingEnabled = true;
  contexto.imageSmoothingQuality = 'high';
  contexto.drawImage(
    telaDenoised,
    BORDA_BRANCA_PX,
    BORDA_BRANCA_PX,
    larguraEscalada,
    alturaEscalada,
  );
  return tela.encode('png');
}
