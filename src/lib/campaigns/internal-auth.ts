// Autorização das chamadas internas (cron, fila, worker). Lógica PURA, sem imports,
// testada pelo Node em scripts/testes.js.

/**
 * Exige `Authorization: Bearer CRON_SECRET` SEMPRE que CRON_SECRET estiver definido —
 * em qualquer ambiente (antes, fora de produção qualquer requisição passava, inclusive
 * em preview pública da Vercel). Sem segredo configurado: só em desenvolvimento e só
 * a partir de localhost.
 */
export function internalRequestAllowed(input: {
  authorization: string | null;
  url: string;
  cronSecret: string | undefined;
  nodeEnv: string | undefined;
}) {
  if (input.cronSecret) return input.authorization === `Bearer ${input.cronSecret}`;
  if (input.nodeEnv === "production") return false;
  let host = "";
  try {
    host = new URL(input.url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
