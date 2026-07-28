# ============================================================
#  Our Mission MKT - Preparacao (PowerShell)
#
#  Como rodar:
#     powershell -ExecutionPolicy Bypass -File .\1-preparar.ps1
# ============================================================

param(
  [string]$PastaProjeto = ""
)

$ErrorActionPreference = "Stop"

# Descobre a pasta do projeto sozinho:
# 1. o caminho passado como parametro, se houver
# 2. a pasta acima deste script (quando ele roda de dentro de scripts\)
# 3. a pasta onde este script esta
# 4. o caminho padrao do OneDrive
if (-not $PastaProjeto) {
  $candidatos = @()
  if ($PSScriptRoot) {
    $candidatos += (Split-Path -Parent $PSScriptRoot)
    $candidatos += $PSScriptRoot
  }
  $candidatos += "C:\Users\PeaceonTax\OneDrive - Peace on Tax\Confidencial-David\Our Mission Marketing"

  # Tambem procura o projeto em subpastas (caso o ZIP tenha sido extraido
  # criando uma pasta dentro da pasta onde este script esta).
  foreach ($raiz in @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot)) | Where-Object { $_ }) {
    Get-ChildItem -LiteralPath $raiz -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidatos += $_.FullName
    }
  }

  foreach ($c in $candidatos) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "package.json"))) {
      $PastaProjeto = $c
      break
    }
  }
  if (-not $PastaProjeto) { $PastaProjeto = $candidatos[-1] }
}

function Titulo($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Erro($t)   { Write-Host "  [x]  $t" -ForegroundColor Red }

Write-Host ""
Write-Host "Pasta do projeto:" -ForegroundColor White
Write-Host "  $PastaProjeto"

# Cache local para node_modules e .next - fora do OneDrive.
$PastaCache = "C:\dev\omk-cache"

# ------------------------------------------------------------
Titulo "Requisitos"

try {
  $nodeVersao = (node --version) 2>$null
  $numero = [int]($nodeVersao -replace 'v(\d+)\..*', '$1')
  if ($numero -lt 18) {
    Erro "Node.js $nodeVersao e antigo. Instale a versao LTS em https://nodejs.org"
    exit 1
  }
  Ok "Node.js $nodeVersao"
} catch {
  Erro "Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e rode de novo."
  exit 1
}

try { $v = (pnpm --version) 2>$null; Ok "pnpm $v" }
catch { Aviso "Instalando pnpm..."; npm install -g pnpm; Ok "pnpm instalado" }

try { $v = (vercel --version) 2>$null; Ok "Vercel CLI $v" }
catch { Aviso "Instalando Vercel CLI..."; npm install -g vercel; Ok "Vercel CLI instalado" }

# ------------------------------------------------------------
Titulo "Projeto"

if (-not (Test-Path -LiteralPath $PastaProjeto)) {
  New-Item -ItemType Directory -Path $PastaProjeto -Force | Out-Null
  Ok "Pasta criada"
}

if (Test-Path -LiteralPath (Join-Path $PastaProjeto "package.json")) {
  Ok "Projeto ja esta na pasta"
} else {
  $ondeProcurar = @(
    $PSScriptRoot,
    $PastaProjeto,
    (Join-Path $env:USERPROFILE "Downloads"),
    (Join-Path $env:USERPROFILE "Desktop")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  $zip = $null
  foreach ($pasta in $ondeProcurar) {
    $achado = Get-ChildItem -LiteralPath $pasta -Filter "our-mission-mkt-crm*.zip" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($achado) { $zip = $achado; break }
  }

  if (-not $zip) {
    Erro "Nao achei our-mission-mkt-crm.zip"
    Write-Host ""
    Write-Host "     Procurei em:"
    foreach ($p in $ondeProcurar) { Write-Host "       $p" }
    Write-Host ""
    Write-Host "     Coloque o ZIP em uma dessas pastas e rode de novo."
    exit 1
  }
  Ok "ZIP encontrado em $($zip.DirectoryName)"

  $temp = Join-Path $env:TEMP "omk-extract"
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
  Write-Host "  Extraindo..."
  Expand-Archive -LiteralPath $zip.FullName -DestinationPath $temp -Force

  # O ZIP tem uma pasta raiz; movemos o CONTEUDO dela para a pasta do projeto.
  $raiz = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
  Get-ChildItem -LiteralPath $raiz.FullName -Force | ForEach-Object {
    Move-Item -LiteralPath $_.FullName -Destination $PastaProjeto -Force
  }
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  Ok "Projeto instalado na sua pasta"
}

Set-Location -LiteralPath $PastaProjeto

# ------------------------------------------------------------
Titulo "Pasta node_modules"

# O OneDrive nao lida bem com atalhos de sistema (junctions) - ele os converte
# e o pnpm passa a ver a pasta como um arquivo. Por isso node_modules e .next
# ficam como pastas comuns aqui.
foreach ($nome in @("node_modules", ".next")) {
  $caminho = Join-Path $PastaProjeto $nome
  if (Test-Path -LiteralPath $caminho) {
    $item = Get-Item -LiteralPath $caminho -Force
    if ($item.LinkType) {
      # Remove so o atalho; o conteudo do destino nao e apagado.
      cmd /c rmdir "`"$caminho`"" 2>$null
      Ok "$nome - atalho antigo removido"
    }
  }
}
Aviso "O OneDrive vai sincronizar node_modules (milhares de arquivos)."
Write-Host "     Se o build ficar lento ou travar, pause a sincronizacao do"
Write-Host "     OneDrive enquanto trabalha, ou mova o projeto para C:\dev."

Titulo "Dependencias"
Write-Host "  Instalando (leva alguns minutos na primeira vez)..."
pnpm install
Ok "Dependencias instaladas"

# ------------------------------------------------------------
Titulo "Variaveis de ambiente"

if (Test-Path -LiteralPath ".env.local") {
  Ok ".env.local ja existe - pulando"
} else {
  Write-Host "  Tenha em maos: Supabase > Settings > API"
  Write-Host ""
  $supabaseUrl = Read-Host "  URL do projeto Supabase (https://xxx.supabase.co)"
  $anonKey     = Read-Host "  Chave anon / publishable"
  $serviceKey  = Read-Host "  Chave service_role (secreta)"
  $anthropic   = Read-Host "  Chave da Anthropic (sk-ant-...)"

  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $cronSecret = [Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', ''

  $conteudo = @"
NEXT_PUBLIC_SUPABASE_URL=$supabaseUrl
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$anonKey
SUPABASE_SERVICE_ROLE_KEY=$serviceKey
ANTHROPIC_API_KEY=$anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
CRON_SECRET=$cronSecret
NEXT_PUBLIC_APP_URL=http://localhost:3000
"@
  Set-Content -LiteralPath ".env.local" -Value $conteudo -Encoding UTF8
  Ok ".env.local criado (CRON_SECRET gerado automaticamente)"
}

# ------------------------------------------------------------
Titulo "Verificacao"
pnpm run test:internal
Write-Host ""
Write-Host "  Compilando para conferir..."
pnpm run build

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " Pronto para publicar." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host " Confirme no Supabase antes de publicar:"
Write-Host "   1. as duas migrations rodadas no SQL Editor"
Write-Host "   2. bucket privado 'brand-assets' criado"
Write-Host "   3. seu usuario criado em Authentication > Users"
Write-Host ""
Write-Host " Testar no computador:  pnpm dev"
Write-Host " Publicar na internet:  .\2-publicar.ps1"
Write-Host ""
