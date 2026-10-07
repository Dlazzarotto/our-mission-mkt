import { NextResponse } from "next/server";
import { batchKey, contractAnchorDay, periodFor, planDispatch, type Cadence } from "@/lib/campaigns/period";
import { isInternalRequest, triggerWorkerInBackground } from "@/lib/campaigns/worker";
import { createAdminClient } from "@/lib/supabase/admin";

// Só enfileira (rápido) e dispara o worker sem esperar por ele: antes esta rota aguardava
// o worker inteiro e as duas funções tinham 300s → 504 no cron.
export const maxDuration = 60;

const PAGINA = 100;
const MAXIMO_POR_RODADA = 1000;

export async function GET(request: Request) {
  // Vercel Cron envia Authorization: Bearer CRON_SECRET — exigido sempre que definido.
  if (!isInternalRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const now = new Date();

    let dispatchedCount = 0;
    let skippedCycles = 0;
    const failures: Array<{ contractId: string; error: string }> = [];

    // 1. Contratos ativos vencidos, em páginas. Um contrato que falha NÃO avança e continua
    //    vencido — por isso a paginação: antes o lote fixo de 25 era sempre o mesmo e um
    //    contrato com erro permanente bloqueava todos os outros. O que falha é registrado e
    //    tentado de novo no próximo cron (espera de 1 ciclo do cron), sem mexer no calendário.
    for (let page = 0; page < MAXIMO_POR_RODADA / PAGINA; page++) {
      const { data: dueContracts, error: contractsError } = await supabase
        .from("client_contracts")
        .select("id, client_id, organization_id, next_generation_at, generation_cadence, starts_at")
        .eq("status", "active")
        .lte("next_generation_at", now.toISOString())
        .order("next_generation_at", { ascending: true })
        .order("id", { ascending: true })
        // Quem avançou deixa de estar vencido; só os que falharam continuam no topo — pula-os.
        .range(failures.length, failures.length + PAGINA - 1);

      if (contractsError) {
        throw new Error(`Erro ao buscar contratos: ${contractsError.message}`);
      }
      if (!dueContracts || dueContracts.length === 0) break;

      // 2. Um job por contrato vencido. Se o cron ficou parado, gera só o ciclo ATUAL
      //    (nunca conteúdo para semanas que já passaram) e agenda o próximo no futuro.
      for (const contract of dueContracts) {
        const cadence = (contract.generation_cadence === "monthly" ? "monthly" : "weekly") as Cadence;
        const anchorDay = contractAnchorDay(contract.starts_at);
        const plan = planDispatch(contract.next_generation_at, cadence, now, anchorDay);
        // Mesmo dia-âncora do planDispatch: o período termina na véspera do próximo alvo.
        const period = periodFor(plan.target, cadence, now, anchorDay);

        const { error: jobError } = await supabase.from("generation_jobs").insert({
          organization_id: contract.organization_id,
          client_id: contract.client_id,
          contract_id: contract.id,
          job_type: "content_batch",
          status: "queued",
          // Mesma chave do pedido manual (batchKey): o mesmo ciclo nunca é gerado duas vezes.
          idempotency_key: batchKey(contract.id, period),
          payload: { target_date: plan.target, cadence, skipped_cycles: plan.skippedCycles, period, source: "cron" },
        });

        // 23505 = já existe job para este ciclo (cron repetido ou pedido manual): segue normalmente.
        if (jobError && jobError.code !== "23505") {
          console.error(`Falha ao enfileirar job para contrato ${contract.id}:`, jobError);
          failures.push({ contractId: contract.id, error: jobError.message });
          continue;
        }

        const { data: advanced, error: updateError } = await supabase
          .from("client_contracts")
          .update({ next_generation_at: plan.next })
          .eq("id", contract.id)
          .eq("next_generation_at", contract.next_generation_at)
          .select("id");

        if (updateError || !advanced || advanced.length === 0) {
          const message = updateError?.message ?? "contrato alterado por outra execução";
          console.error(`Falha ao avançar o contrato ${contract.id}:`, message);
          failures.push({ contractId: contract.id, error: message });
          continue;
        }

        skippedCycles += plan.skippedCycles;
        dispatchedCount++;
      }

      if (dueContracts.length < PAGINA) break;
    }

    // 3. O worker roda SEMPRE (novas tentativas e excedente da fila também andam), sem esperar.
    triggerWorkerInBackground(request);

    return NextResponse.json({
      success: true,
      dispatched: dispatchedCount,
      skipped_cycles: skippedCycles,
      failures,
      message: `${dispatchedCount} jobs enfileirados; worker disparado em segundo plano.`,
    });
  } catch (error) {
    console.error("Erro no despachante de cron:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
