# Consulta SEFAZ SSA/BA

API REST para consultas automatizadas em portais da SEFAZ Bahia e da SEFAZ Salvador. A automação roda em um navegador headless controlado por Playwright, no servidor, e devolve os dados estruturados em JSON — com opção de retornar também o PDF ou o print da página.

Projetada para uso interno de uma equipe pequena (até 10 usuários simultâneos), em servidor simples, com consumo controlado de recursos.

## Origem

As consultas aos portais da SEFAZ Bahia e da SEFAZ Salvador eram feitas manualmente, uma a uma. Para acelerar, foi criada uma suíte de automações em Python que rodava localmente na máquina de cada usuário: o processo ficou mais rápido, mas o navegador headless consumia CPU e memória da própria estação de trabalho, deixando o computador inoperante durante a execução.

Este projeto é a reescrita desse modelo como API. A automação roda em um servidor (local ou em nuvem); as máquinas dos usuários apenas enviam a requisição HTTP e recebem o resultado. O custo do navegador passa a ser do servidor, concentrado em um pool de browser reutilizado, com limite de concorrência e cache de resultados.

Mantivemos o mesmo propósito técnico da suíte Python, com o runtime corrigido:

- eliminar a dependência de máquina local dedicada (a consulta roda no servidor);
- concentrar o custo de navegador num pool com contexto isolado por execução;
- fila FIFO persistida e limite de concorrência por portal, para não martelar os portais;
- cache de resultados com TTL por tipo de consulta (evita reexecução desnecessária);
- histórico, auditoria e controle de acesso centralizados (SQLite + API key por colaborador).

## Escopo

Somente consultas aos portais da SEFAZ Bahia e da SEFAZ Salvador:

| Automação | Portal | Entrada principal |
|---|---|---|
| `sefaz-bahia` | SEFAZ Bahia | CNPJ |
| `sefaz-bahia-inscricao` | SEFAZ Bahia | Inscrição Estadual |
| `sefaz-bahia-socio` | SEFAZ Bahia | CPF do sócio |
| `consulta-inscricoes` | SEFAZ Bahia + SEFAZ Salvador | CNPJ (IE + IM) |
| `iptu-salvador` | SEFAZ Salvador | Número do IPTU |
| `ficha-cadastral` | SEFAZ Salvador | CNPJ |
| `alvara-funcionamento` | SEFAZ Salvador | CNPJ / inscrição municipal |
| `cadin-salvador` | SEFAZ Salvador | CPF ou CNPJ |
| `dam-tff-tll` | SEFAZ Salvador | Inscrição municipal (CGA) + exercício |

Não faz: login em outros sistemas, escrita em portais, envio de documentos, ou qualquer operação que altere dados.

## Como funciona

1. O cliente envia uma requisição (GET com parâmetros na URL, ou POST com JSON).
2. A API valida, consulta o cache e, em caso de miss, cria uma execução.
3. Um worker interno executa a automação no navegador, na ordem de chegada (FIFO), respeitando limite de concorrência global e por portal.
4. O cliente acompanha por polling ou por SSE, e ao final recebe os dados e os links dos documentos (PDF/print).
5. O resultado fica em cache por um período configurável por tipo de consulta.

Autenticação por API key: cada usuário possui a própria chave, enviada no header `X-API-Key` ou na query `?apikey=`. Chaves são gerenciadas por uma chave administrativa.

Documentação interativa em **`/docs`** (Swagger UI), gerada a partir dos schemas de validação.

## Requisitos

- Node.js 20 ou superior
- npm
- Linux ou macOS (no Linux, o Playwright precisa de algumas bibliotecas de sistema)

## Instalação

```bash
npm install
npm run browser:install
cp .env.example .env
# edite .env: defina ADMIN_KEY e gere ENCRYPTION_KEY
```

`npm run browser:install` baixa apenas o `chromium-headless-shell` (binário mínimo de headless, ~90 MB — sem Firefox, sem WebKit, sem Chromium completo).

No Linux pode ser necessário instalar as bibliotecas de sistema uma única vez:

```bash
npx playwright-core install-deps chromium
```

Gerar a `ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Build e execução

```bash
npm run typecheck   # verificação de tipos
npm test            # testes
npm run build       # compila para dist/
npm start           # produção (dist/)
npm run dev         # desenvolvimento com reload
```

A API sobe em `http://localhost:3000` (configure `PORT` no `.env`).

### Saúde do serviço

```bash
curl http://localhost:3000/health   # {"status":"ok"} — processo vivo
curl http://localhost:3000/ready    # prontidão (banco, browser)
curl http://localhost:3000/metrics  # métricas básicas
```

## Configuração

Todas as variáveis estão descritas em `.env.example`. As mais relevantes:

| Variável | Descrição | Padrão |
|---|---|---|
| `ADMIN_KEY` | Chave para gerenciar API keys | obrigatória |
| `ENCRYPTION_KEY` | Criptografia das sessões de navegador | obrigatória |
| `SEMAFORO_GLOBAL` | Automações simultâneas no servidor | `5` |
| `SEMAFORO_POR_PORTAL` | Simultaneidades por portal | `1` |
| `FILA_TIMEOUT_SEG` | Tempo máximo de espera na fila | `90` |
| `CACHE_<TIPO>` | TTL do cache por automação (`7d`, `12h`, `45m`) | ver abaixo |

### Valores de cache

TTLs padrão: **7 dias** para a maioria das consultas, **3 dias** para CADIN, **12 horas** para DAM. Erros nunca entram em cache. O parâmetro `forceRefresh` é **opcional e desligado por padrão** — quando enviado, pula o cache e regrava o resultado.

Todos os valores podem ser alterados:

1. **Sem mexer em código** — crie ou edite o `.env` e reinicie o serviço. O formato aceito é `30s`, `45m`, `12h`, `7d`:

   ```bash
   CACHE_SEFAZ_BAHIA=14d
   CACHE_DAM_TFF_TLL=24h
   CACHE_CADIN_SALVADOR=7d
   ```

2. **Em código** — ajuste o padrão em `src/config/cache.ts`.

## Uso

A API aceita autenticação de duas formas em qualquer rota:

- header `X-API-Key: $CHAVE` (recomendado para servidores)
- query `?apikey=$CHAVE` (conveniente para testar no navegador)

### Consultar pela URL (GET)

Mais simples para uso direto no navegador ou com `curl`:

```bash
curl "http://localhost:3000/v1/consultas/sefaz-bahia?apikey=$USER_KEY&cnpj=12345678000190"
```

- responde `200` com o resultado (usa o cache; em caso de miss, executa a consulta de verdade)
- aceita `&artefatos=pdf|print|ambos`, `&forceRefresh=true`, `&wait=30`

> Observação de segurança: a query string aparece em logs e no histórico do navegador. Para uso em produção prefira o header.

### Executar de forma assíncrona (POST, padrão)

```bash
curl -X POST http://localhost:3000/v1/automacoes/sefaz-bahia \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $USER_KEY" \
  -d '{
    "cnpj": "12345678000190",
    "artefatos": "ambos"
  }'
```

Resposta (202):

```json
{
  "execucaoId": "exe_01H...",
  "status": "PENDING",
  "posicaoFila": 2
}
```

### Criar uma API key (admin)

```bash
curl -X POST http://localhost:3000/v1/admin/apikeys \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $ADMIN_KEY" \
  -d '{"nome": "Maria"}'
```

### Consultar o resultado

```bash
curl http://localhost:3000/v1/execucoes/exe_01H... \
  -H "X-API-Key: $USER_KEY"
```

Quando `status` for `SUCCESS`, o corpo traz `dados` e `documentos` (quando `artefatos` foi solicitado).

### Acompanhar progresso (SSE)

```bash
curl -N http://localhost:3000/v1/execucoes/exe_01H.../progresso \
  -H "X-API-Key: $USER_KEY"
```

### Baixar um documento (PDF ou print)

```bash
curl -OJ http://localhost:3000/v1/documentos/doc_01H... \
  -H "X-API-Key: $USER_KEY"
```

### Documentação interativa (Swagger)

Abra **`http://localhost:3000/docs`** no navegador: todas as rotas, parâmetros e exemplos, com botão "Try it out" para executar de verdade.

### Parâmetro de artefatos

| Valor | Entrega |
|---|---|
| `nenhum` (padrão) | apenas os dados em JSON |
| `pdf` | PDF da página ou PDF oficial do portal |
| `print` | imagem da página (JPEG) |
| `ambos` | PDF e print |

Com `artefatos`, os documentos ficam disponíveis em `GET /v1/documentos/:id` durante o TTL configurado.

### Resposta síncrona (opcional)

```bash
curl -X POST "http://localhost:3000/v1/automacoes/sefaz-bahia?wait=30" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $USER_KEY" \
  -d '{"cnpj": "12345678000190"}'
```

Espera até 30 segundos e devolve o resultado pronto; se a execução demorar, responde 202 com o ID normalmente.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/v1/consultas/:tipo` | Consulta direta pela URL (cache-first) |
| POST | `/v1/automacoes/:tipo` | Executa uma consulta (assíncrono) |
| GET | `/v1/execucoes/:id` | Status e resultado |
| GET | `/v1/execucoes/:id/progresso` | Progresso em SSE |
| GET | `/v1/execucoes/:id/documentos` | Lista de documentos da execução |
| GET | `/v1/documentos/:id` | Download do documento |
| POST | `/v1/admin/apikeys` | Cria API key (admin) |
| GET | `/v1/admin/apikeys` | Lista API keys (admin) |
| DELETE | `/v1/admin/apikeys/:id` | Revoga API key (admin) |
| GET | `/docs` | Swagger UI (OpenAPI) |
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness (banco e browser saudáveis) |
| GET | `/metrics` | Métricas básicas |

## Estrutura do projeto

```
src/
  app/          aplicação Fastify (server, plugins)
  config/       env, constantes, TTLs de cache
  modules/
    automation/ controller, service, repository, cache das consultas
    jobs/       fila, worker, estados das execuções
    browser/    pool de navegadores, contexto, factory
  automations/
    base/       base dos robôs, artefatos, captcha, ocr
    sites/      um diretório por portal
    registry.ts registro das automações
  database/     cliente SQLite, migrations, repositories
  shared/       logger, erros, utilitários, tipos
tests/          unit, integration, e2e
storage/        screenshots, traces, downloads, artefatos
data/           banco SQLite
```

## Notas de operação

- A automação usa `chromium-headless-shell` (modo headless, binário mínimo). O navegador é lançado uma vez e reutilizado; cada execução recebe um contexto isolado. O pool é reciclado periodicamente para manter o consumo de memória estável.
- Execuções do mesmo portal rodam uma por vez (fila FIFO); portais diferentes rodam em paralelo.
- Consultas idênticas em andamento são agrupadas (uma única execução serve vários pedidos).
- Captcha e OCR são resolvidos localmente (Tesseract), sem serviços externos de IA.
- Imagens e fontes dos portais são bloqueadas por padrão para reduzir consumo; quando a consulta pede PDF/print, os recursos visuais são liberados.
- O banco (`data/app.sqlite`) e a pasta `storage/` devem ser incluídos em backup junto com o `.env`.
