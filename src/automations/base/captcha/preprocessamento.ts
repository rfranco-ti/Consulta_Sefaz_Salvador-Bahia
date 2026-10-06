import { createCanvas, loadImage } from '@napi-rs/canvas';

const FATOR_ESCALA = 2;
const FATOR_CONTRASTE = 1.5;
const PONTO_MEDIO_CONTRASTE = 128;
const PESO_VERMELHO = 0.299;
const PESO_VERDE = 0.587;
const PESO_AZUL = 0.114;
const VALOR_MAXIMO_CANAL = 255;
const VALOR_BINARIO_CLARO = 255;
const VALOR_BINARIO_ESCURO = 0;
const ALFA_OPACO = 255;

export async function preprocessarCaptchaImagem(buffer: Buffer): Promise<Buffer> {
  const imagem = await loadImage(buffer);
  const larguraNova: number = Math.max(1, imagem.width * FATOR_ESCALA);
  const alturaNova: number = Math.max(1, imagem.height * FATOR_ESCALA);
  const tela = createCanvas(larguraNova, alturaNova);
  const contexto = tela.getContext('2d');
  contexto.imageSmoothingEnabled = true;
  contexto.imageSmoothingQuality = 'high';
  contexto.drawImage(imagem, 0, 0, larguraNova, alturaNova);
  const dados = contexto.getImageData(0, 0, larguraNova, alturaNova);
  const pixels: Uint8ClampedArray = dados.data;
  const quantidade: number = larguraNova * alturaNova;
  const cinzas = new Float64Array(quantidade);
  let soma = 0;
  for (let indice = 0; indice < quantidade; indice += 1) {
    const base: number = indice * 4;
    const vermelho: number = pixels[base] ?? 0;
    const verde: number = pixels[base + 1] ?? 0;
    const azul: number = pixels[base + 2] ?? 0;
    const luminancia: number =
      PESO_VERMELHO * vermelho + PESO_VERDE * verde + PESO_AZUL * azul;
    const comContraste: number =
      (luminancia - PONTO_MEDIO_CONTRASTE) * FATOR_CONTRASTE + PONTO_MEDIO_CONTRASTE;
    const limitado: number = Math.min(
      VALOR_MAXIMO_CANAL,
      Math.max(0, comContraste),
    );
    cinzas[indice] = limitado;
    soma += limitado;
  }
  const mediaGlobal: number = soma / Math.max(1, quantidade);
  for (let indice = 0; indice < quantidade; indice += 1) {
    const base: number = indice * 4;
    const tom: number = cinzas[indice] ?? 0;
    const binario: number =
      tom >= mediaGlobal ? VALOR_BINARIO_CLARO : VALOR_BINARIO_ESCURO;
    pixels[base] = binario;
    pixels[base + 1] = binario;
    pixels[base + 2] = binario;
    pixels[base + 3] = ALFA_OPACO;
  }
  contexto.putImageData(dados, 0, 0);
  return tela.encode('png');
}
