# CLAUDE.md — Our Mission MKT (EstratégiaPro CRM)

CRM de agência de marketing (multi-tenant: agência → clientes) com geração de campanhas por IA,
pesquisa de mercado, workflow de 10 fases e, desde out/2026, **medição e atribuição** (Fase 1 do
"Autonomous Marketing Operating System"). Dono: David (Peace on Tax Corp, Malden MA). Conversa em
**português**; o conteúdo voltado ao consumidor final dos clientes é em **inglês** (mercado dos EUA).

## Como o David trabalha (obrigatório)

- Agir como especialista sênior. **Quando ele questionar algo, NÃO defender o que está feito:
  auditar o código, reproduzir o problema e responder com resultado testado.**
- Mudou algo em um ponto → aplicar em **todos** os pontos equivalentes (rotas, telas, tipos,
  enums do banco, testes, README). Nada de correção parcial.
- Entregas completas e testadas. Nada descartável, nada de lógica duplicada.
- Windows + PowerShell: comandos **individuais** (sem `&&`), `Set-Content` sempre com
  `-Encoding UTF8`, `-LiteralPath` em caminhos com colchetes (`[slug]`, `[id]`).
- Todo SQL é **arquivo** em `supabase/migrations/` — nunca SQL solto na resposta.
- Ao final de cada entrega: comandos prontos de `git add .` / `git commit -m` / `git push`
  e, se houver migration, como aplicar no SQL Editor (um arquivo por vez, na ordem).
- Conteúdo para o mercado dos EUA nunca usa conceitos brasileiros (MEI, CNPJ, Simples):
  usar LLC, EIN, Schedule C, IRS. Setor regulado: não afirmar regra tributária específica.

## Onde fica cada coisa

- Produção: https://our-mission-mkt.vercel.app (login obrigatório; públicas só `/r/*` e `/f/*`)
- Repositório: https://github.com/Dlazzarotto/our-mission-mkt — a `main` faz deploy automático na
  Vercel. A Fase 1 entrou na `main` em 07/out/2026 (PRs #1, #2 e #3); `fase1-medicao` está obsoleta.
- Pasta local do David: dentro do OneDrive (`C:\Users\PeaceonTax\OneDrive - Peace on Tax\Confidencial-David\...`).
  Se precisar entregar arquivos por ZIP, o padrão confiável é extrair numa pasta temporária e
  usar `Copy-Item` para o projeto — `Expand-Archive` direto em cima do OneDrive já falhou.
- Master Prompt original do marketing autônomo: `docs/MASTER-PROMPT-MARKETING.md`
  (citado abaixo como "seção N"). Ler junto com a seção "Roteiro" deste arquivo.

## Variáveis de ambiente (Vercel — nunca no frontend, exceto as NEXT_PUBLIC)

| Variável | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | cliente Supabase (navegador e servidor) |
| `SUPABASE_SERVICE_ROLE_KEY` | só servidor: cron, worker, rotas públicas `/r` `/f` `/api/public/*` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | geração de campanhas e pesquisa (modelo padrão no código) |
| `CRON_SECRET` | protege `/api/cron/*` e o worker `/api/campaigns/generate` |
| `NEXT_PUBLIC_APP_URL` | URL base para o cron chamar o worker e para montar links `/r/` |
| `TRACKING_SALT` | **nova** — sal do hash de IP (limite de envios). Sem ela usa `CRON_SECRET` |
| `GOOGLE_MAPS_API_KEY` | Google Places (pesquisa de concorrentes) |
| `GOOGLE_AI_API_KEY` | geração de imagem das peças |
| `DATAFORSEO_*`, `GOOGLE_ADS_*`, `GOOGLE_TRENDS_API_KEY` | provedores opcionais da pesquisa de mercado |

## Migrations (ordem de aplicação)

```
202607260001_initial_schema.sql
202607260002_market_intelligence.sql
202607270001_junction_palette_research_plans.sql
202607270002_workflow.sql
202607270003_logo_flag.sql
202610060001_integridade_tenant_e_fila.sql      ← aplicada em produção em 07/out/2026
202610060002_medicao_e_atribuicao.sql           ← aplicada em produção em 07/out/2026
202610060003_geracao_transacional.sql           ← aplicada em produção em 07/out/2026
```

No SQL Editor do Supabase cada arquivo roda numa transação só: se falhar, nada é aplicado e
pode rodar de novo depois de corrigir. Aplicar UM arquivo por vez. As 5 primeiras não são
re-executáveis (o `pnpm run audit` avisa) — isso é esperado, já estão em produção.
As 3 de out/2026 também já estão em produção: NUNCA editar; corrigir com migration nova.
A integração Supabase ↔ GitHub está com o **deploy automático de migrations para produção
desligado** (07/out/2026): migration só entra pelo SQL Editor, à mão. O histórico do Supabase
(`supabase_migrations.schema_migrations`) está vazio — se um dia ligar o deploy automático ou usar
`supabase db push`, antes é preciso registrar ali as migrations já aplicadas, senão ele tenta
rodar tudo desde a primeira. O deploy do SITE (Vercel ↔ GitHub) é outro: merge na `main` publica.

## Stack

Next.js 16 (App Router, `src/proxy.ts` como middleware) · React 19 · Tailwind 4 · Supabase
(Postgres + RLS + Storage privado `brand-assets`) · Vercel (Cron) · Anthropic SDK com
saída estruturada (Zod) · Google Places · geração de imagem (Gemini). Gerenciador: **pnpm**.

## Comandos

```
pnpm install
pnpm test        # testes internos (scripts/testes.js) + banco real em memória (tests/db, PGlite)
pnpm test:db     # só o banco (tests/db/run.mjs + tests/db/geracao.mjs)
pnpm run audit   # contratos código × schema (scripts/auditoria.py) — `pnpm audit` sem `run` é o
                 # comando do pnpm que lista vulnerabilidades de pacotes, NÃO este script
pnpm build
```

`pnpm test` TEM que ficar verde antes de qualquer entrega. Os testes carregam TypeScript direto
pelo Node (exige Node 22.18+): módulos testados (`src/lib/campaigns/period.ts`,
`src/lib/marketing/tracking.ts`) só podem usar sintaxe de tipo apagável e nenhum import `@/`.

## Estado atual (07/out/2026)

Fase 1 em produção (`main`), com as correções da auditoria de 07/out (uma FK por par de tabelas,
append-only real, atribuição só com clique, totais calculados pelo banco, geração transacional,
calendário contínuo, IA em en-US). O que a Fase 1 entregou:

1. `202610060001_integridade_tenant_e_fila.sql` — **brecha corrigida**: antes, a RLS conferia só
   o `organization_id` da própria linha, e a agência B gravava campanha no cliente da agência A
   (reproduzido). Agora toda relação entre tabelas da agência é **FK composta**
   `(organization_id, x_id)`; `organization_id` é imutável; jobs presos em `processing` voltam à
   fila em 15 min; `performance_metrics.source` obrigatório; canais tiktok/youtube/pinterest.
2. `202610060002_medicao_e_atribuicao.sql` — famílias de conteúdo (CF-), código de peça (C-),
   links rastreáveis, cliques (append-only), leads com funil e receita (LD-), histórico do funil,
   views de resultado (`v_content_results`, `v_content_scores`, `v_channel_results`,
   `v_location_results`, `v_family_results`).
3. Worker/cron: esvazia a fila sempre, período e cota respeitam a cadência (mensal = mês inteiro),
   cron parado não gera semanas passadas, cron de hora em hora (`vercel.json`, exige Vercel Pro).
4. IA devolve `concept`, `hook`, `cta` por peça; cotas por lote calculadas pela aplicação.
5. Rotas públicas `/r/[slug]` (redirect + clique) e `/f/[slug]` (formulário com a marca do
   cliente) + `POST /api/public/leads` (CORS, isca anti-robô, limite por IP e por link).
6. Aba **📈 Resultados** no perfil do cliente (`src/components/results-panel.tsx`).

### PENDENTE (fazer nesta ordem)

1. ~~Aplicar as migrations 0001, 0002 e 0003 no Supabase~~ — feito em 07/out/2026, sem erro.
   Daqui em diante qualquer correção nelas é migration NOVA.
2. ~~Variável `TRACKING_SALT` na Vercel~~ — cadastrada (confirmado pelo David em 08/out/2026).
3. ~~Confirmar plano Vercel~~ — é **Pro** (confirmado 07/out/2026): cron de hora em hora mantido.
4. ~~Merge na `main` → deploy~~ — feito em 07/out/2026.
5. Teste real: criar link na aba Resultados → abrir no celular → preencher o formulário →
   lead deve aparecer com "origem comprovada".
6. Lint: 3 erros ANTIGOS do React Compiler (`src/app/workflow/page.tsx`, `equipe.tsx`,
   `workflow-panel.tsx`) — não bloqueiam build; corrigir com cuidado quando mexer nesses arquivos.

## Regras invioláveis do código

**Banco**
- Migrations são só-avanço: nunca editar arquivo já aplicado; corrigir com migration nova.
- Toda tabela da agência: `organization_id` + RLS (`is_organization_member` para ler,
  `is_organization_editor` para escrever, `is_organization_manager` para apagar) + FK composta
  para cada relação + trigger `lock_organization_id` + `set_updated_at`.
- Tabela nova precisa de teste em `tests/db/run.mjs` (isolamento entre agências no mínimo).
- Clique e histórico de lead são append-only. Gravação de clique e de lead público só pelo
  servidor (service role) nas rotas públicas.

**Aplicação**
- Todo `update` confere a linha devolvida (`.select(...)` e checar vazio): a RLS recusa em
  silêncio com 0 linhas e a tela diria "salvo" sem ter salvo.
- Toda rota em `src/app/api` valida sessão (`auth.getUser()`) ou `CRON_SECRET`. Rota pública
  só se marcada com o comentário `ROTA PÚBLICA` E com limite de envios (o teste interno cobra).
- `service_role` / `createAdminClient` nunca em componente `"use client"`.
- **A IA nunca calcula número**: CPL, CPA, ROAS, CTR, nota S–F, cotas e datas vêm do banco ou
  de funções puras testadas. A IA cria texto e explica. Nunca inventar dado: sem base = "sem dado".
- Paleta é sempre DO CLIENTE (brand kit), nunca da agência.

## Roteiro do marketing autônomo (Master Prompt "Autonomous Marketing Operating System")

Texto completo em `docs/MASTER-PROMPT-MARKETING.md`. O Master Prompt descreve o cérebro; a auditoria apontou o que as plataformas permitem de fato:
- Atribuição de post orgânico sem clique é impossível por API → link rastreável + "como nos conheceu".
- Desempenho por cidade por post orgânico não existe nas APIs → geo vem do clique e do lead;
  ranking por cidade de verdade só em mídia paga.
- Publicação automática exige aprovação de app (Meta, TikTok, YouTube, LinkedIn, Google Business)
  e tem cotas → semanas no caminho crítico.
- Estatística: negócio local gera dezenas de leads/mês → amostra mínima e uma variável por teste.
- Autonomia financeira só com teto diário em US$ por cliente e kill switch.

Fases seguintes (aguardar aprovação do David antes de cada uma):
- **Fase 2** — importação de métricas por API (Meta Graph / Instagram Insights primeiro),
  investimento de anúncios por campanha, relatório diário (formato da seção 24 do Master Prompt).
- **Fase 3** — reciclagem de vencedores: família com nota S/A gera variações (hook/CTA) para
  aprovação; registro de testes A/B com uma variável por vez.
- **Fase 4** — publicação por API com os 3 níveis de autonomia (seção 22), teto de gasto e alertas.
- Vídeo: templates (Remotion/Creatomate) + voz + legendas com fotos reais do cliente; generativo só como B-roll.

## Primeira sessão no Claude Code

1. Ler este arquivo e `docs/MASTER-PROMPT-MARKETING.md`.
2. `pnpm install` e `pnpm test` (esperado: 80 internos + 72 de banco + 18 de geração, tudo verde).
3. Auditar o que for mexer procurando erro — sem defender o que está feito — e
   reportar achados antes de qualquer mudança.
4. Guiar o David pela lista PENDENTE acima, um passo por vez, com comandos PowerShell prontos.
5. Só começar a Fase 2 depois da aprovação dele.

## Contexto de outros produtos do David (não são dependências)

CleanFlow (limpeza; tem campanhas com link `/c/[slug]` — mesmo conceito da Fase 1), JobFlow
(construção), Peace on Business (contabilidade estilo QuickBooks), ProQuantum (day trade).
