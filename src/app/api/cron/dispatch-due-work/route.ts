import { NextResponse } from "next/server";
import { planDispatch, type Cadence } from "@/lib/campaigns/period";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300; // Tempo suficiente para despachar e processar um lote de jobs.

const LOTE_DE_CONTRATOS = 25;

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
    const now = new Date();

    // 1. Contratos ativos cujo prazo de geração já chegou.
    const { data: dueContracts, error: contractsError } = await supabase
      .from("client_contracts")
      .select("id, client_id, organization_id, next_generation_at, generation_cadence, starts_at")
      .eq("status", "active")
      .lte("next_generation_at", now.toISOString())
      .order("next_generation_at", { ascending: true })
      .limit(LOTE_DE_CONTRATOS);

    if (contractsError) {
      throw new Error(`Erro ao buscar contratos: ${contractsError.message}`);
    }

    let dispatchedCount = 0;
    let skippedCycles = 0;

    // 2. Um job por contrato vencido. Se o cron ficou parado, gera só o ciclo ATUAL
    //    (nunca conteúdo para semanas que já passaram) e agenda o próximo no futuro.
    for (const contract of dueContracts ?? []) {
      const cadence = (contract.generation_cadence === "monthly" ? "monthly" : "weekly") as Cadence;
      const anchorDay = contract.starts_at ? Number(String(contract.starts_at).slice(8, 10)) : undefined;
      const plan = planDispatch(contract.next_generation_at, cadence, now, anchorDay);
      skippedCycles += plan.skippedCycles;

      const idempotencyKey = `batch_${contract.id}_${plan.target.slice(0, 10)}`;
      const { error: jobError } = await supabase.from("generation_jobs").insert({
        organization_id: contract.organization_id,
        client_id: contract.client_id,
        contract_id: contract.id,
        job_type: "content_batch",
        status: "queued",
        idempotency_key: idempotencyKey,
        payload: { target_date: plan.target, cadence, skipped_cycles: plan.skippedCycles },
      });

      // 23505 = já existe job para este ciclo (execução repetida do cron): segue normalmente.
      if (jobError && jobError.code !== "23505") {
        console.error(`Falha ao enfileirar job para contrato ${contract.id}:`, jobError);
        continue;
      }

      const { error: updateError } = await supabase
        .from("client_contracts")
        .update({ next_generation_at: plan.next })
        .eq("id", contract.id);

      if (updateError) {
        console.error(`Falha ao avançar o contrato ${contract.id}:`, updateError);
        continue;
      }

      dispatchedCount++;
    }

    // 3. O worker roda SEMPRE — não só quando entra job novo. Antes, novas tentativas
    //    de jobs com erro e o excedente da fila só andavam quando outro contrato vencia.
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
    const workerResponse = await fetch(`${baseUrl}/api/campaigns/generate`, {
      method: "POST",
      headers: cronSecret ? { authorization: `Bearer ${cronSecret}` } : {},
    });
    const workerResult: unknown = await workerResponse.json().catch(() => ({
      success: false,
      error: "O worker retornou uma resposta inválida.",
    }));

    return NextResponse.json({
      success: true,
      dispatched: dispatchedCount,
      skipped_cycles: skippedCycles,
      worker: workerResult,
      message: `${dispatchedCount} jobs enfileirados.`,
    });
  } catch (error) {
    console.error("Erro no despachante de cron:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
