import { NextResponse } from "next/server";
import { z } from "zod";
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
      .select("id, status")
      .eq("client_id", client.id)
      .eq("status", "active");

    const { data: contract, error: contractError } = payload.contractId
      ? await contractQuery.eq("id", payload.contractId).single()
      : await contractQuery.order("starts_at", { ascending: false }).limit(1).single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Nenhum contrato ativo encontrado para este cliente." }, { status: 409 });
    }

    const targetDate = payload.targetDate ?? new Date().toISOString();
    const idempotencyKey = `manual-content-batch:${contract.id}:${targetDate.slice(0, 10)}`;

    const { error: insertError } = await supabase.from("generation_jobs").upsert(
      {
        organization_id: client.organization_id,
        client_id: client.id,
        contract_id: contract.id,
        job_type: "content_batch",
        status: "queued",
        idempotency_key: idempotencyKey,
        scheduled_for: new Date().toISOString(),
        payload: { target_date: targetDate, requested_by: user.id, source: "manual" },
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

    let worker: unknown = null;
    if (job.status === "queued") {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;
      const workerResponse = await fetch(`${baseUrl}/api/campaigns/generate`, {
        method: "POST",
        headers: process.env.CRON_SECRET
          ? { authorization: `Bearer ${process.env.CRON_SECRET}` }
          : {},
      });
      worker = await workerResponse.json().catch(() => null);
    }

    return NextResponse.json({
      success: true,
      job,
      worker,
      message:
        job.status === "queued"
          ? "Geração iniciada. Atualize a lista em instantes para revisar os rascunhos."
          : "Já existe uma geração em andamento para este período.",
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
