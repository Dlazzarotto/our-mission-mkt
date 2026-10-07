// Autorização e disparo do worker de geração (/api/campaigns/generate). Só servidor.
import { after } from "next/server";
import { internalRequestAllowed } from "@/lib/campaigns/internal-auth";

/** Chamada interna (cron, fila, o próprio worker): regra em internalRequestAllowed. */
export function isInternalRequest(request: Request) {
  return internalRequestAllowed({
    authorization: request.headers.get("authorization"),
    url: request.url,
    cronSecret: process.env.CRON_SECRET,
    nodeEnv: process.env.NODE_ENV,
  });
}

/** Limite de reencadeamentos do worker por rodada (proteção contra laço). */
export const MAX_WORKER_HOPS = 20;

/**
 * Chama o worker e espera só o aceite (ele responde 202 na hora e processa em
 * segundo plano). Nunca lança: falha de disparo é registrada no log.
 */
export async function fireWorker(baseUrl: string, hop = 0) {
  const cronSecret = process.env.CRON_SECRET;
  try {
    const response = await fetch(`${baseUrl}/api/campaigns/generate`, {
      method: "POST",
      headers: {
        ...(cronSecret ? { authorization: `Bearer ${cronSecret}` } : {}),
        "x-worker-hop": String(hop),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) console.error(`Worker de geração recusou o disparo: HTTP ${response.status}`);
  } catch (error) {
    console.error("Falha ao disparar o worker de geração:", error);
  }
}

export function appBaseUrl(request: Request) {
  return process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
}

/**
 * Dispara o worker SEM esperar: a resposta para quem chamou (cron, usuário na
 * tela) sai imediatamente e o disparo roda depois dela (`after`). Antes o cron e a
 * tela esperavam o worker esvaziar a fila (os dois com 300s → 504).
 */
export function triggerWorkerInBackground(request: Request, hop = 0) {
  const baseUrl = appBaseUrl(request);
  after(() => fireWorker(baseUrl, hop));
}
