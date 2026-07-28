# Verificação visual local

Data: 2026-07-26

- A página inicial carregou corretamente em `http://localhost:3000`.
- O painel exibe a navegação lateral, os indicadores operacionais, a fila de aprovação e o bloco de automações.
- A navegação para o perfil do cliente funcionou corretamente.
- No perfil de cliente, as abas Visão geral, Marca, Contrato, Calendário e Conteúdos estão visíveis.
- O botão de criação por IA está visível e o resumo do contrato mostra quotas, cadência automática e aprovação obrigatória.
- O layout apresenta contraste adequado, boa hierarquia visual e não mostrou erros de renderização na inspeção inicial.

A verificação das abas Marca e Contrato também foi concluída. A aba Marca exibiu a paleta editável, o seletor de estilo, o campo de tom de voz, os termos obrigatórios/proibidos e o CTA. A aba Contrato exibiu a vigência, o mercado, o fuso, a cadência de IA, as quotas de posts e vídeos e as datas especiais configuradas. Os controles foram renderizados sem falhas visuais.

O teste de criação por IA no painel funcionou em modo demonstrativo: o sistema criou um novo item, alterou a aba para Conteúdos, exibiu a confirmação de que o rascunho foi enviado para revisão e abriu o item recém-criado. A peça contém legenda, hashtags, briefing criativo, prompt de imagem e botão de aprovação, confirmando o fluxo de revisão humana previsto.
