import { z } from "zod";
import { parseCount, parseMoney } from "@/lib/marketing/tracking";

// Validação no SERVIDOR dos números digitados à mão — o mesmo parser da tela
// (parseMoney / parseCount em tracking.ts): "1.500,00" nunca vira 1,5.

/** Valor em dinheiro: aceita número ou texto ("1,500.50", "1.500,50"...). undefined = não mexer, null/"" = limpar. */
export const moneyInput = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (value === null || (typeof value === "string" && value.trim() === "")) return null;
    const parsed = parseMoney(value);
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: `Valor inválido: "${value}". Use 1500, 1500.50, 1,500.50 ou 1.500,50.` });
      return z.NEVER;
    }
    return parsed;
  });

/** Contagem inteira (impressões, cliques...). Vazio = null (sem dado). */
export const countInput = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
    const parsed = parseCount(value);
    if (parsed === null || parsed > 2_000_000_000) {
      ctx.addIssue({ code: "custom", message: `Número inválido: "${value}". Use só números inteiros.` });
      return z.NEVER;
    }
    return parsed;
  });
