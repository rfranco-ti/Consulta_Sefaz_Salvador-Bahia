import type { ElementHandle, Page } from 'playwright-core';

interface HTMLImageElement {
  readonly src: string;
}

const TEMPO_SONDAGEM_MS = 300;
const SELETOR_GENERICO_CAPTCHA = 'img[src*="captcha" i]';
const MENSAGEM_SONDAGEM_EXPIRADA = 'Tempo esgotado ao sondar o captcha na página.';

async function sondarSeletor(
  pagina: Page,
  seletor: string,
): Promise<ElementHandle<HTMLImageElement> | null> {
  let temporizador: NodeJS.Timeout | undefined;
  try {
    const busca: Promise<ElementHandle<HTMLImageElement> | null> = pagina.$(seletor);
    const expiracao = new Promise<null>((_, rejeitar) => {
      temporizador = setTimeout(() => {
        rejeitar(new Error(MENSAGEM_SONDAGEM_EXPIRADA));
      }, TEMPO_SONDAGEM_MS);
    });
    const encontrado: ElementHandle<HTMLImageElement> | null = await Promise.race([
      busca,
      expiracao,
    ]);
    return encontrado;
  } catch {
    return null;
  } finally {
    if (temporizador !== undefined) {
      clearTimeout(temporizador);
    }
  }
}

export async function detectarCaptchaImagem(
  pagina: Page,
  seletores: string[],
): Promise<ElementHandle<HTMLImageElement> | null> {
  for (const seletor of seletores) {
    const encontrado: ElementHandle<HTMLImageElement> | null = await sondarSeletor(
      pagina,
      seletor,
    );
    if (encontrado !== null) {
      return encontrado;
    }
  }
  return sondarSeletor(pagina, SELETOR_GENERICO_CAPTCHA);
}
