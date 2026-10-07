import { NextResponse } from "next/server";
import { z } from "zod";
import { batchKey, contractAnchorDay, manualPeriodFor, type Cadence } from "@/lib/campaigns/period";
import { triggerWorkerInBackground } from "@/lib/campaigns/worker";
import { createClient } from "@/lib/supabase/server";

const requestSchema = z.object({
  clientId: z.string().uuid(),
  contractId: z.string().uuid().optional(),
  targetDate: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  try {
    const payload = requestSchema.parse(await request.json());
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Sessão inválida." }, { status: 401 });
    }

    // A RLS garante que este usuário só consiga encontrar clientes e contratos da própria organização.
    const { data: client, error: clientError } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", payload.clientId)
      .single();

    if (clientError || !client) {
      return NextResponse.json({ error: "Cliente não encontrado ou sem permissão." }, { status: 404 });
    }

    const contractQuery = supabase
      .from("client_contracts")
      .select("id, status, generation_cadence, next_generation_at, starts_at")
      .eq("client_id", client.id)
      .eq("status", "active");

    const { data: contract, error: contractError } = payload.contractId
      ? await contractQuery.eq("id", payload.contractId).single()
      : await contractQuery.order("starts_at", { ascending: false }).limit(1).single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Nenhum contrato ativo encontrado para este cliente." }, { status: 409 });
    }

    // Período do pedido manual: de hoje (nunca o passado) até o FIM do ciclo do contrato.
    // A chave usa o fim do ciclo — a MESMA do cron (batchKey): pedido manual e cron do
    // mesmo ciclo não geram conteúdo em dobro.
    const targetDate = payload.targetDate ?? new Date().toISOString();
    const cadence = (contract.generation_cadence === "monthly" ? "monthly" : "weekly") as Cadence;
    const period = manualPeriodFor(targetDate, cadence, contract.next_generation_at, contractAnchorDay(contract.starts_at));
    const idempotencyKey = batchKey(contract.id, period);

    const { error: insertError } = await supabase.from("generation_jobs").upsert(
      {
        organization_id: client.organization_id,
        client_id: client.id,
        contract_id: contract.id,
        job_type: "content_batch",
        status: "queued",
        idempotency_key: idempotencyKey,
        scheduled_for: new Date().toISOString(),
        payload: { target_date: targetDate, cadence, period, requested_by: user.id, source: "manual" },
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    if (insertError) {
      throw new Error(insertError.message);
    }

    const { data: job, error: jobError } = await supabase
      .from("generation_jobs")
      .select("id, status, scheduled_for")
      .eq("idempotency_key", idempotencyKey)
      .single();

    if (jobError || !job) {
      throw new Error(jobError?.message ?? "Não foi possível localizar o job enfileirado.");
    }

    // Dispara o worker sem esperar: a tela responde na hora (antes esperava a fila global inteira).
    if (job.status === "queued") triggerWorkerInBackground(request);

    return NextResponse.json({
      success: true,
      job,
      period,
      message:
        job.status === "queued"
          ? "Geração iniciada. Atualize a lista em instantes para revisar os rascunhos."
          : job.status === "processing"
            ? "Já existe uma geração em andamento para este período."
            : `Este período (${period.startsAt} a ${period.endsAt}) já tem um lote (${job.status}).`,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Dados inválidos para gerar a campanha." }, { status: 400 });
    }

    console.error("Erro ao enfileirar campanha:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 },
    );
  }
}
