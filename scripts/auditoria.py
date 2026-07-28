#!/usr/bin/env python3
"""Auditoria de contratos do EstratégiaPro CRM (junção v2).

Verifica, sem precisar de rede ou node_modules:
  A. imports '@/...' resolvem para arquivos existentes
  B. fetch() do frontend bate com rotas/métodos existentes
  C. campos enviados no body batem com os schemas zod das rotas
  D. tabelas/colunas usadas no código existem no schema SQL
  E. valores literais de enum usados no código existem nos enums SQL
  F. conflitos entre as duas migrations (nomes duplicados) e re-execução
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
MIG = os.path.join(ROOT, "supabase", "migrations")

problemas = []
avisos = []


def erro(cat, msg):
    problemas.append(f"[{cat}] {msg}")


def aviso(cat, msg):
    avisos.append(f"[{cat}] {msg}")


def arquivos_ts():
    for base, _, files in os.walk(SRC):
        for f in files:
            if f.endswith((".ts", ".tsx")):
                yield os.path.join(base, f)


def rel(p):
    return os.path.relpath(p, ROOT)


# ---------------------------------------------------------------- A. imports
def checar_imports():
    for path in arquivos_ts():
        src = open(path, encoding="utf-8").read()
        for imp in re.findall(r'from\s+"(@/[^"]+)"', src):
            alvo = os.path.join(SRC, imp[2:])
            existe = any(
                os.path.exists(alvo + ext)
                for ext in ("", ".ts", ".tsx", "/index.ts", "/index.tsx")
            )
            if not existe:
                erro("IMPORT", f"{rel(path)} importa '{imp}' — arquivo inexistente")


# ------------------------------------------------------- B/C. contrato de API
def coletar_rotas():
    rotas = {}
    for base, _, files in os.walk(os.path.join(SRC, "app", "api")):
        if "route.ts" not in files:
            continue
        url = "/" + os.path.relpath(base, os.path.join(SRC, "app")).replace(os.sep, "/")
        src = open(os.path.join(base, "route.ts"), encoding="utf-8").read()
        metodos = set(re.findall(r"export async function (GET|POST|PATCH|PUT|DELETE)", src))
        campos = set()
        bloco = re.search(r"requestSchema\s*=\s*z\.object\(\{(.*?)\n\}\)", src, re.S)
        if bloco:
            campos = set(re.findall(r"^\s*(\w+):", bloco.group(1), re.M))
        obrig = set()
        if bloco:
            for linha in bloco.group(1).splitlines():
                m = re.match(r"\s*(\w+):", linha)
                if m and ".optional()" not in linha and ".default(" not in linha:
                    obrig.add(m.group(1))
        rotas[url] = {"metodos": metodos, "campos": campos, "obrigatorios": obrig}
    return rotas


def checar_fetches(rotas):
    padrao = re.compile(
        r'fetch\(\s*"(/api/[^"]+)"\s*,\s*\{(.*?)\}\s*\)', re.S
    )
    for path in arquivos_ts():
        src = open(path, encoding="utf-8").read()
        for url, corpo in padrao.findall(src):
            if url not in rotas:
                erro("API", f"{rel(path)} chama '{url}' — rota inexistente")
                continue
            metodo = re.search(r'method:\s*"(\w+)"', corpo)
            metodo = metodo.group(1) if metodo else "GET"
            if metodo not in rotas[url]["metodos"]:
                erro(
                    "API",
                    f"{rel(path)} chama {metodo} {url} — rota exporta apenas "
                    f"{sorted(rotas[url]['metodos'])}",
                )
            body = re.search(r"JSON\.stringify\(\{(.*?)\}\)", corpo, re.S)
            if body and rotas[url]["campos"]:
                enviados = set(re.findall(r"^\s*(\w+):", body.group(1), re.M))
                desconhecidos = enviados - rotas[url]["campos"]
                faltando = rotas[url]["obrigatorios"] - enviados
                if desconhecidos:
                    aviso(
                        "API",
                        f"{rel(path)} envia campos não previstos no schema de {url}: "
                        f"{sorted(desconhecidos)}",
                    )
                if faltando:
                    erro(
                        "API",
                        f"{rel(path)} NÃO envia campos obrigatórios de {url}: "
                        f"{sorted(faltando)}",
                    )


# ------------------------------------------------------------ D/E/F. SQL
def carregar_sql():
    textos = {}
    for nome in sorted(os.listdir(MIG)):
        if nome.endswith(".sql"):
            textos[nome] = open(os.path.join(MIG, nome), encoding="utf-8").read()
    return textos


def parse_schema(sql_total):
    tabelas = {}
    for m in re.finditer(
        r"create table (?:if not exists )?public\.(\w+)\s*\((.*?)\n\);", sql_total, re.S
    ):
        nome, corpo = m.group(1), m.group(2)
        colunas = set()
        for linha in corpo.splitlines():
            linha = linha.strip()
            if not linha or linha.startswith(("constraint", "check", "primary key", "unique", "--")):
                continue
            mm = re.match(r"(\w+)\s+", linha)
            if mm:
                colunas.add(mm.group(1))
        tabelas[nome] = colunas
    # Colunas adicionadas depois, via ALTER TABLE ... ADD COLUMN
    for m in re.finditer(
        r"alter table (?:only )?public\.(\w+)(.*?);", sql_total, re.S | re.I
    ):
        nome, corpo = m.group(1), m.group(2)
        if nome not in tabelas:
            continue
        for col in re.finditer(r"add column (?:if not exists )?(\w+)", corpo, re.I):
            tabelas[nome].add(col.group(1))

    enums = {}
    for m in re.finditer(r"create type public\.(\w+) as enum\s*\((.*?)\);", sql_total, re.S):
        enums[m.group(1)] = set(re.findall(r"'([^']+)'", m.group(2)))
    return tabelas, enums


def checar_sql_uso(tabelas, enums):
    # coluna -> enum, para validar literais
    col_enum = {
        ("content_items", "channel"): "content_channel",
        ("content_items", "format"): "content_format",
        ("content_items", "objective"): "content_objective",
        ("content_items", "status"): "content_status",
        ("campaigns", "status"): "campaign_status",
        ("client_contracts", "status"): "contract_status",
        ("brand_kits", "visual_style"): "visual_style",
        ("generation_jobs", "status"): "generation_job_status",
    }
    for path in arquivos_ts():
        src = open(path, encoding="utf-8").read()
        ocorrencias = [(mm.start(), mm.group(1)) for mm in re.finditer(r'\.from\("(\w+)"\)', src)]
        for idx, (pos, tabela) in enumerate(ocorrencias):
            fim = ocorrencias[idx + 1][0] if idx + 1 < len(ocorrencias) else len(src)
            resto = src[pos:fim]
            if tabela not in tabelas:
                erro("SQL", f"{rel(path)} usa tabela '{tabela}' — inexistente no schema")
                continue
            cols = tabelas[tabela]
            # colunas em .select("a, b, c") — ignora joins tipo tabela(col)
            sel = re.search(r'\.select\(\s*"([^"]+)"', resto)
            if sel and sel.group(1).strip() != "*":
                texto = re.sub(r"\w+\([^)]*\)", "", sel.group(1))
                for campo in texto.split(","):
                    campo = campo.strip()
                    if campo and campo != "*" and campo not in cols:
                        erro(
                            "SQL",
                            f"{rel(path)}: select de '{campo}' em '{tabela}' — coluna inexistente",
                        )
            # colunas em .eq("col", ...) e .order("col")
            for campo in re.findall(r'\.(?:eq|order|lte|gte)\(\s*"(\w+)"', resto):
                if campo not in cols:
                    erro("SQL", f"{rel(path)}: filtro por '{campo}' em '{tabela}' — coluna inexistente")
            # colunas em .insert({...}) / .update({...})
            for verbo in ("insert", "update"):
                mm = re.search(rf"\.{verbo}\(\{{(.*?)\n\s*\}}\)", resto, re.S)
                if not mm:
                    continue
                # objeto de update/insert nunca contem uma chamada fetch: se contem,
                # a regex vazou para o codigo seguinte — ignora para evitar falso positivo
                if "fetch(" in mm.group(1):
                    continue
                # O objeto de resposta (NextResponse.json) as vezes gruda no
                # update pela regex — nao e coluna de tabela.
                if "success:" in mm.group(1) or "NextResponse" in mm.group(1):
                    continue
                for linha in mm.group(1).splitlines():
                    campo_m = re.match(r"\s*(\w+):", linha)
                    if not campo_m:
                        continue
                    campo = campo_m.group(1)
                    if campo not in cols:
                        erro(
                            "SQL",
                            f"{rel(path)}: {verbo} de '{campo}' em '{tabela}' — coluna inexistente",
                        )
                        continue
                    enum_nome = col_enum.get((tabela, campo))
                    if enum_nome:
                        lit = re.search(r':\s*"([^"]+)"', linha)
                        if lit and lit.group(1) not in enums.get(enum_nome, set()):
                            erro(
                                "SQL",
                                f"{rel(path)}: valor '{lit.group(1)}' para {tabela}.{campo} "
                                f"não existe no enum {enum_nome}",
                            )


def checar_migrations(sqls):
    nomes = list(sqls)
    if len(nomes) < 2:
        aviso("MIGRATION", "esperava 2 migrations")
        return
    def extrair(sql, padrao):
        return set(re.findall(padrao, sql))
    for i, a in enumerate(nomes):
        for b in nomes[i + 1:]:
            for rotulo, padrao in [
                ("tabela", r"create table (?:if not exists )?public\.(\w+)"),
                ("policy", r"create policy (\w+)"),
                ("trigger", r"create trigger (\w+)"),
                ("type", r"create type public\.(\w+)"),
            ]:
                dup = extrair(sqls[a], padrao) & extrair(sqls[b], padrao)
                if dup:
                    erro("MIGRATION", f"{rotulo} duplicado entre {a} e {b}: {sorted(dup)}")
    # re-execução segura
    for nome, sql in sqls.items():
        for rotulo, padrao, guarda in [
            ("create table", r"create table public\.(\w+)", "if not exists"),
            ("create trigger", r"create trigger (\w+)", "drop trigger if exists"),
            ("create policy", r"create policy (\w+)", "drop policy if exists"),
        ]:
            achados = re.findall(padrao, sql)
            if achados and guarda not in sql:
                aviso(
                    "MIGRATION",
                    f"{nome}: {len(achados)} '{rotulo}' sem '{guarda}' — "
                    f"re-executar a migration dará erro",
                )


def main():
    sqls = carregar_sql()
    sql_total = "\n".join(sqls.values())
    tabelas, enums = parse_schema(sql_total)

    checar_imports()
    rotas = coletar_rotas()
    checar_fetches(rotas)
    checar_sql_uso(tabelas, enums)
    checar_migrations(sqls)

    print(f"Tabelas no schema: {len(tabelas)} | Enums: {len(enums)} | Rotas de API: {len(rotas)}")
    for url, info in sorted(rotas.items()):
        print(f"  {sorted(info['metodos'])} {url}")

    print(f"\n{'=' * 60}")
    if problemas:
        print(f"ERROS ({len(problemas)}):")
        for p in problemas:
            print("  ✗ " + p)
    else:
        print("ERROS: nenhum")
    if avisos:
        print(f"\nAVISOS ({len(avisos)}):")
        for a in avisos:
            print("  ! " + a)
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main())
