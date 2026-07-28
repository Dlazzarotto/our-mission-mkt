import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300; // Tempo suficiente para despachar e processar um pequeno lote de jobs.

export async function GET(request: Request) {
  // Validação de segurança exigida pela Vercel para Cron Jobs.
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (process.env.NODE_ENV === "production") {
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const supabase = createAdminClient();

    // 1. Busca contratos ativos que precisam de geração de campanha e cujo prazo já chegou.
    const { data: dueContracts, error: contractsError } = await supabase
      .from("client_contracts")
      .select("id, client_id, organization_id, next_generation_at, generation_cadence")
      .eq("status", "active")
      .lte("next_generation_at", new Date().toISOString())
      .limit(10); // Processa em lotes para evitar timeout no despachante.

    if (contractsError) {
      throw new Error(`Erro ao buscar contratos: ${contractsError.message}`);
    }

    if (!dueContracts || dueContracts.length === 0) {
      return NextResponse.json({ success: true, dispatched: 0, message: "Nenhum contrato pendente de geração." });
    }

    let dispatchedCount = 0;

    // 2. Para cada contrato vencido, cria um job de geração na fila.
    for (const contract of dueContracts) {
      const idempotencyKey = `batch_${contract.id}_${new Date(contract.next_generation_at).toISOString().split("T")[0]}`;

      const { error: jobError } = await supabase.from("generation_jobs").insert({
        organization_id: contract.organization_id,
        client_id: contract.client_id,
        contract_id: contract.id,
        job_type: "content_batch",
        status: "queued",
        idempotency_key: idempotencyKey,
        payload: { target_date: contract.next_generation_at },
      });

      // Se der erro de violação de unique constraint (23505), o job já existe. Podemos ignorar e seguir.
      if (jobError && jobError.code !== "23505") {
        console.error(`Falha ao enfileirar job para contrato ${contract.id}:`, jobError);
        continue;
      }

      // 3. Atualiza o contrato para a próxima data de geração,
      // respeitando a cadência contratada (semanal ou mensal).
      // Métodos UTC para não depender do fuso do servidor.
      // No mensal, somar 1 mês direto estoura: 31/jan viraria 03/mar e fevereiro
      // seria pulado. Fixamos o dia 1 antes de avancar e depois limitamos ao
      // ultimo dia do mes de destino.
      const nextDate = new Date(contract.next_generation_at);
      if (contract.generation_cadence === "monthly") {
        const diaDesejado = nextDate.getUTCDate();
        nextDate.setUTCDate(1);
        nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
        const ultimoDiaDoMes = new Date(
          Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 0),
        ).getUTCDate();
        nextDate.setUTCDate(Math.min(diaDesejado, ultimoDiaDoMes));
      } else {
        nextDate.setUTCDate(nextDate.getUTCDate() + 7);
      }

      await supabase
        .from("client_contracts")
        .update({ next_generation_at: nextDate.toISOString() })
        .eq("id", contract.id);

      dispatchedCount++;
    }

    // 4. Aciona o worker interno. Isso mantém o fluxo completamente automático:
    // Cron → fila persistente → IA → rascunhos em revisão.
    let workerResult: unknown = null;
    if (dispatchedCount > 0) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
      const workerResponse = await fetch(`${baseUrl}/api/campaigns/generate`, {
        method: "POST",
        headers: cronSecret ? { authorization: `Bearer ${cronSecret}` } : {},
      });

      workerResult = await workerResponse.json().catch(() => ({
        success: false,
        error: "O worker retornou uma resposta inválida.",
      }));
    }

    return NextResponse.json({
      success: true,
      dispatched: dispatchedCount,
      worker: workerResult,
      message: `${dispatchedCount} jobs enfileirados com sucesso.`,
    });
  } catch (error) {
    console.error("Erro no despachante de cron:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
