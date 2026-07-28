import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Gestão de equipe: quem é dono ou gerente pode criar acessos para o resto do time.
// Todos entram na MESMA organização, então enxergam os mesmos clientes.

const createSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres."),
  role: z.enum(["manager", "strategist", "designer", "viewer"]).default("strategist"),
});

const removeSchema = z.object({
  userId: z.string().uuid(),
});

async function contextoDoUsuario() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { erro: "Sessão inválida.", status: 401 as const };

  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) return { erro: "Você ainda não pertence a uma agência.", status: 409 as const };
  return { supabase, user, membership };
}

// ---------------------------------------------------------------------------
// GET — lista os membros da agência
// ---------------------------------------------------------------------------
export async function GET() {
  const ctx = await contextoDoUsuario();
  if ("erro" in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status });

  const { data: membros } = await ctx.supabase
    .from("organization_members")
    .select("user_id, role, created_at")
    .eq("organization_id", ctx.membership.organization_id)
    .order("created_at", { ascending: true });

  // O e-mail vive em auth.users, fora do alcance da RLS — buscamos com a chave admin.
  let comEmail = (membros ?? []).map((m) => ({ ...m, email: null as string | null }));
  try {
    const admin = createAdminClient();
    const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const mapa = new Map((lista?.users ?? []).map((u) => [u.id, u.email ?? null]));
    comEmail = comEmail.map((m) => ({ ...m, email: mapa.get(m.user_id) ?? null }));
  } catch {
    // Sem a chave admin, mostramos a lista sem os e-mails.
  }

  return NextResponse.json({
    success: true,
    membros: comEmail,
    meuPapel: ctx.membership.role,
    meuId: ctx.user.id,
  });
}

// ---------------------------------------------------------------------------
// POST — cria o acesso de um novo integrante
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  try {
    const ctx = await contextoDoUsuario();
    if ("erro" in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status });

    if (!["owner", "manager"].includes(ctx.membership.role)) {
      return NextResponse.json(
        { error: "Só o dono ou um gerente pode adicionar pessoas à equipe." },
        { status: 403 },
      );
    }

    const payload = createSchema.parse(await request.json());
    const admin = createAdminClient();

    // Se a pessoa já tem conta, aproveitamos em vez de recusar.
    const { data: existentes } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const jaExiste = (existentes?.users ?? []).find(
      (u) => (u.email ?? "").toLowerCase() === payload.email.toLowerCase(),
    );

    let userId = jaExiste?.id ?? null;

    if (!userId) {
      const { data: criado, error: createError } = await admin.auth.admin.createUser({
        email: payload.email,
        password: payload.password,
        email_confirm: true,
      });
      if (createError || !criado?.user) {
        throw new Error(createError?.message ?? "Não foi possível criar o acesso.");
      }
      userId = criado.user.id;
    }

    const { error: memberError } = await admin.from("organization_members").upsert(
      {
        organization_id: ctx.membership.organization_id,
        user_id: userId,
        role: payload.role,
      },
      { onConflict: "organization_id,user_id" },
    );

    if (memberError) {
      throw new Error(`Acesso criado, mas falhou ao vincular à agência: ${memberError.message}`);
    }

    return NextResponse.json({
      success: true,
      reaproveitado: Boolean(jaExiste),
      membro: { user_id: userId, email: payload.email, role: payload.role },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — tira alguém da agência (a conta continua existindo)
// ---------------------------------------------------------------------------
export async function DELETE(request: Request) {
  try {
    const ctx = await contextoDoUsuario();
    if ("erro" in ctx) return NextResponse.json({ error: ctx.erro }, { status: ctx.status });

    if (!["owner", "manager"].includes(ctx.membership.role)) {
      return NextResponse.json({ error: "Sem permissão para remover pessoas." }, { status: 403 });
    }

    const payload = removeSchema.parse(await request.json());
    if (payload.userId === ctx.user.id) {
      return NextResponse.json({ error: "Você não pode remover a si mesmo." }, { status: 400 });
    }

    const admin = createAdminClient();
    const { error } = await admin
      .from("organization_members")
      .delete()
      .eq("organization_id", ctx.membership.organization_id)
      .eq("user_id", payload.userId);

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    return NextResponse.json(
      { success: false, error: message },
      { status: error instanceof z.ZodError ? 400 : 500 },
    );
  }
}
