# Our Mission MKT — EstratégiaPro CRM

Sistema de gestão de contratos e criação automática de campanhas de marketing digital por IA.

## Arquitetura

- **Frontend:** Next.js (App Router), React, Tailwind CSS, Lucide Icons.
- **Backend:** Next.js Serverless Functions e Vercel Cron Jobs.
- **Banco de Dados & Auth:** Supabase (PostgreSQL + Row Level Security).
- **IA:** Integração planejada para Anthropic Claude (Structured Outputs).

## Fluxo de Automação

1. **Vercel Cron Job** executa semanalmente (ex: domingo às 02:00 UTC).
2. O endpoint `/api/cron/dispatch-due-work` verifica contratos no Supabase e enfileira `generation_jobs`.
3. O worker em `/api/campaigns/generate` processa a fila de forma idempotente.
4. A IA lê o `Brand Kit` e o `Contrato` e gera rascunhos estruturados (JSON).
5. Os rascunhos ficam com status `review` no painel da agência para aprovação humana.

## Implantação (Deploy)

### 1. Supabase
1. Crie um novo projeto no [Supabase](https://supabase.com/).
2. No SQL Editor, execute o script localizado em `supabase/migrations/202607260001_initial_schema.sql`.
3. Vá em Storage e crie um bucket privado chamado `brand-assets`.
4. Obtenha a URL do projeto, a chave `anon/public` e a chave `service_role`.

### 2. Vercel
1. Importe o repositório no painel da [Vercel](https://vercel.com/).
2. Configure as variáveis de ambiente:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (Apenas servidor)
   - `ANTHROPIC_API_KEY` (Apenas servidor)
   - `CRON_SECRET` (Gere uma string segura de 32+ caracteres)
3. Faça o deploy. A Vercel detectará o arquivo `vercel.json` e configurará o Cron Job automaticamente.

## Desenvolvimento Local

1. Copie `.env.example` para `.env.local` e preencha as variáveis do Supabase.
2. Instale as dependências: `pnpm install`
3. Inicie o servidor: `pnpm dev`
4. Acesse `http://localhost:3000`

## Junção v2 (EstratégiaPro artifact + Campaign OS)

### Regra de identidade visual
**A paleta é sempre do CLIENTE, nunca da agência.** Cada cliente nasce com um brand kit próprio
(paleta neutra padrão) criado automaticamente por trigger, editável a qualquer momento em
`Perfil do cliente → Marca & Paleta`. As gerações de conteúdo leem o brand kit atualizado
automaticamente — mudou a cor, a próxima campanha já sai com ela.

### Novidades
- **Painel real**: home (`/`) e perfil (`/clients/[id]`) conectados ao Supabase com RLS.
  O painel demonstrativo original foi preservado em `/demo`.
- **Pesquisa de mercado por território**: funil de 3 etapas (ZIP + raio) com busca na web
  server-side, plano de execução "como fazer funcionar", histórico por cliente.
- **Plano estratégico de 5 seções**: auditoria digital (web), mercado/SWOT (web), personas,
  metas SMART e calendário editorial.
- **Correções de produção**: contratos novos entram na fila automaticamente
  (`next_generation_at` via trigger), cadência mensal respeitada no dispatcher, e datas
  geradas pela IA normalizadas antes do insert.
- **Criação de cliente completa**: brand kit automático + contrato semanal padrão —
  o pipeline do cron funciona desde o dia 1.

### Nova migration
Execute também `supabase/migrations/202607270001_junction_palette_research_plans.sql`
(depois da inicial) no SQL Editor do Supabase.

## Auditoria e testes internos

O projeto inclui dois verificadores que rodam sem rede e sem `node_modules`:

```bash
npm run audit          # contratos: imports, rotas de API, colunas/enums do SQL, migrations
npm run test:internal  # executa a lógica real: datas da IA, cadência, paleta, segurança
```

### Resultado da última auditoria (junção v2)
- Contratos: **0 erros** — 8 rotas, 15 tabelas, 9 enums conferidos.
- Testes de execução: **20/20 passando**.
- Sintaxe: 27 arquivos TS/TSX balanceados.

### Correções aplicadas pela auditoria
1. **Datas da IA nas bordas do período** — posts legítimos às 00:00 ou 20:00 no fuso do
   contrato eram remarcados. Agora há tolerância de 24h para offsets de fuso.
2. **Cadência mensal estourava o mês** — 31/jan + 1 mês virava 03/mar, pulando fevereiro
   inteiro. Agora o dia é limitado ao último dia do mês de destino, com métodos UTC.
3. **Migration re-executável** — `if not exists` nas tabelas e `drop ... if exists` em
   triggers e policies, para poder rodar de novo sem erro.
4. **Tipos do SDK da Anthropic** — tipagem estrutural em vez de nomes de namespace, para a
   build não quebrar se a versão do SDK mudar.
5. **Relacionamento brand_kits** — o PostgREST pode devolver objeto ou array; ambos tratados.
6. **Tipos do React** importados explicitamente em vez do global UMD.

> A migration inicial (`202607260001`) foi mantida como veio e roda **uma única vez**.
> Se ela falhar no meio, apague os objetos criados antes de reexecutar.

## Marca da agência

O nome da agência fica centralizado em `src/lib/brand.ts`:

```ts
export const AGENCY_NAME = "Our Mission MKT";
export const PRODUCT_NAME = "EstratégiaPro CRM";
```

Alterar ali muda a tela de login, o título da aba e os metadados. No painel interno, o
nome exibido vem da organização cadastrada no banco — por isso o campo já vem preenchido
com **Our Mission MKT** na criação da agência.

> Isto é a marca da **agência**. A identidade visual de cada **cliente** continua sendo
> dele: paleta própria no brand kit, editável no perfil a qualquer momento.

## Pesquisa de mercado — dois níveis

**Rápida (3 etapas, 2 a 3 min):** território e demanda → concorrência no raio →
oportunidade e funil local com veredicto 0-10.

**Completa (10 etapas, 8 a 12 min):**

| # | Etapa | O que entrega |
|---|-------|---------------|
| 1 | Demanda e sazonalidade | Termos de busca derivados do serviço, tendência de 12 meses e 5 anos, meses de pico e vale |
| 2 | Palavras-chave e volume | 15 a 20 palavras com volume, concorrência e CPC, mais cauda longa |
| 3 | Território e demanda | Cidades, bairros, demografia e sinais de procura |
| 4 | Mapa dos concorrentes | Até 20 empresas: site, Google Business, avaliações, nota, serviços, preço, diferencial, horário |
| 5 | SEO, Maps e redes | Palavras que eles usam, destaque no mapa local, redes e brechas |
| 6 | Uso de IA | Chatbot, agendamento, orçamento automático, lembretes — quem usa o quê |
| 7 | Tendências e nichos | Nichos do ramo com demanda, concorrência e margem |
| 8 | Público e oportunidades | Perfis mais promissores e as melhores combinações de procura, concorrência e margem |
| 9 | Google Ads | Palavras para começar, negativas, orçamento mínimo e ideal, meta de contatos |
| 10 | Relatório final | Top 30 palavras, top 20 oportunidades, plano de 12 meses por trimestre, veredicto 0-10 |

Os termos de busca **não são fixos**: a etapa 1 os deriva do serviço real do cliente. O
exemplo de limpeza (house cleaning, deep cleaning, move in/out, Airbnb, office) entra no
prompt como padrão a adaptar, não como lista literal.

Cada número gerado vem marcado como **[verificado]** (veio de fonte encontrada na web) ou
**[estimado]** (leitura do modelo), com a instrução de como confirmar no Google Trends,
no Keyword Planner ou no próprio Ads antes de investir.

### Arquitetura: uma etapa por requisição
`POST /api/research` abre a pesquisa e devolve a lista de etapas. `PATCH /api/research`
executa uma etapa e grava. O painel percorre a lista mostrando o progresso.
Dez etapas numa única requisição estourariam o `maxDuration` da Vercel.

## Equipe e acesso de qualquer lugar

O sistema é multiusuário: todos os membros de uma agência enxergam os mesmos clientes,
de qualquer computador ou celular, entrando com e-mail e senha.

- **Dono** — criado automaticamente por quem cadastra a agência.
- **Gerente** — pode adicionar e remover pessoas.
- **Estrategista / Designer** — cria e edita clientes, planos e conteúdo.
- **Somente leitura** — vê tudo, não altera nada.

Na tela de clientes, o botão **Equipe** lista os membros e permite ao dono ou gerente criar
o acesso de alguém: e-mail, papel e uma senha inicial (com botão de gerar). A pessoa entra
com esses dados e já vê a carteira inteira. Remover alguém da agência não apaga a conta —
apenas tira o acesso aos clientes.

> Sem essa tela, um segundo usuário que fizesse login criaria uma agência separada e não
> enxergaria nenhum cliente. Ela é o que torna o sistema realmente compartilhado.

## Publicar pelo PowerShell (Windows, sem GitHub)

Dois scripts em `scripts/` fazem tudo pela linha de comando. O Vercel CLI publica direto
da pasta, então **o GitHub não é necessário**.

```powershell
powershell -ExecutionPolicy Bypass -File .\1-preparar.ps1
powershell -ExecutionPolicy Bypass -File .\2-publicar.ps1
```

**`1-preparar.ps1`** — confere e instala o que falta (Node, pnpm, Vercel CLI), extrai o ZIP,
instala as dependências, pergunta as chaves do Supabase e da Anthropic, **gera o CRON_SECRET
sozinho**, roda os testes internos e compila para conferir se está tudo certo.

**`2-publicar.ps1`** — faz login na Vercel, vincula o projeto, envia as variáveis do
`.env.local` para produção e publica. Para atualizar o site depois de qualquer mudança,
basta rodar este script de novo.

### O projeto fica na sua pasta do OneDrive
Os scripts instalam o projeto direto em
`C:\Users\PeaceonTax\OneDrive - Peace on Tax\Confidencial-David\Our Mission Marketing`.

Para o OneDrive não engasgar, `node_modules` e `.next` são redirecionados por *junction*
(atalho de sistema) para `C:\dev\omk-cache`. O OneDrive não entra em junctions, então
ignora esses milhares de arquivos temporários — enquanto o código-fonte continua
sincronizado e com backup normal.

Para usar outra pasta, passe o caminho como parâmetro:

```powershell
powershell -ExecutionPolicy Bypass -File .\1-preparar.ps1 -PastaProjeto "D:\outro\caminho"
```

## Workflow de agência

O sistema tem uma espinha de processo: cada cliente percorre 10 fases, com dono,
prazo e critério de saída **verificado contra os dados reais** — a fase só fecha quando o
entregável existe no banco, não quando alguém marca uma caixinha.

| # | Fase | Dono | SLA | Critério de saída |
|---|------|------|-----|-------------------|
| 1 | Onboarding | Atendimento | 5 d | Brand kit preenchido + contrato ativo |
| 2 | Diagnóstico | Estrategista | 7 d | Pesquisa de mercado analisada |
| 3 | Estratégia | Estrategista | 7 d | Plano estratégico gerado |
| 4 | Planejamento | Estrategista | 4 d | Calendário do ciclo montado |
| 5 | Produção | Redação | 5 d | Peças com texto |
| 6 | Revisão interna | Estrategista | 2 d | Peças revisadas |
| 7 | Aprovação do cliente | Atendimento | 3 d | Peças aprovadas |
| 8 | Veiculação | Performance | 2 d | Peças agendadas ou publicadas |
| 9 | Mensuração | Performance | 3 d | Relatório entregue |
| 10 | Otimização | Estrategista | 3 d | Tarefas concluídas |

Ao sair da otimização o ciclo reinicia no planejamento, incrementando o número do ciclo.

**Tarefas** são criadas automaticamente ao entrar na fase, cada uma com papel responsável e
prazo em dias úteis. **Eventos** registram cada passagem, retorno, pausa e avanço forçado —
com o motivo, quando houver pendência.

- `/workflow` — quadro com todos os clientes por fase, saúde do prazo e tarefas em aberto
- Aba **Processo** no perfil do cliente — fase atual, o que falta para avançar, tarefas e entregáveis

## Inteligência de mercado — dado coletado x análise

O módulo separa o que foi **medido** do que é **interpretação**:

- **Dado coletado** — concorrentes reais vindos do Google Places (nome, nota, nº de avaliações,
  site, distância), gravados com a data da coleta e exibidos em tabela própria com atribuição.
- **Análise da IA** — a leitura sobre esses dados: quem lidera, onde estão as brechas, como se
  posicionar. Apresentada como análise, nunca como medição.
- **Sem fonte conectada** — quando um provedor não está configurado, o relatório declara a
  ausência. A IA é instruída a NÃO produzir volume de busca, CPC ou nomes de empresas que não
  estejam nos dados coletados.

| Fonte | Variável | Situação típica |
|-------|----------|-----------------|
| Google Places | `GOOGLE_MAPS_API_KEY` | Fácil de obter, paga por chamada |
| Google Ads (Keyword Planner) | `GOOGLE_ADS_*` | Exige developer token aprovado |
| Google Trends | `GOOGLE_TRENDS_API_KEY` | API em alpha, por convite |
| SEO (DataForSEO) | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Opcional |

> Política do Google Places: conteúdo não pode virar acervo permanente — `place_id` é a
> exceção. Por isso `market_competitors.fetched_at` registra a coleta, e a interface exibe a
> atribuição ao Google.

### Ordem das migrations
```
202607260001_initial_schema.sql
202607260002_market_intelligence.sql
202607270001_junction_palette_research_plans.sql
202607270002_workflow.sql
```
