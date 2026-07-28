# ============================================================
#  Our Mission MKT - Publicar na Vercel (PowerShell)
#  Sobe direto da sua pasta. Nao precisa de GitHub.
#
#  Como rodar:
#     powershell -ExecutionPolicy Bypass -File .\2-publicar.ps1
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

if (-not (Test-Path -LiteralPath (Join-Path $PastaProjeto "package.json"))) {
  Erro "Projeto nao encontrado em:"
  Write-Host "     $PastaProjeto"
  Write-Host "     Rode primeiro: .\1-preparar.ps1"
  exit 1
}
Set-Location -LiteralPath $PastaProjeto

if (-not (Test-Path -LiteralPath ".env.local")) {
  Erro ".env.local nao existe. Rode primeiro: .\1-preparar.ps1"
  exit 1
}

# ------------------------------------------------------------
Titulo "Conta Vercel"
Write-Host "  Se abrir o navegador, confirme o login por la."
vercel login
Ok "Conectado"

# ------------------------------------------------------------
Titulo "Projeto na Vercel"
if (Test-Path -LiteralPath ".vercel\project.json") {
  Ok "Projeto ja vinculado"
} else {
  Write-Host "  Responda as perguntas da Vercel:"
  Write-Host "    - Set up and deploy?  ......  Y"
  Write-Host "    - Which scope?  ...........  sua conta"
  Write-Host "    - Link to existing project?  N"
  Write-Host "    - Project name?  ..........  our-mission-mkt"
  Write-Host "    - In which directory?  ....  ./ (Enter)"
  Write-Host "    - Modify settings?  .......  N"
  Write-Host ""
  vercel link
  Ok "Projeto vinculado"
}

# ------------------------------------------------------------
Titulo "Variaveis de ambiente"

$variaveis = @{}
Get-Content -LiteralPath ".env.local" | ForEach-Object {
  $linha = $_.Trim()
  if ($linha -and -not $linha.StartsWith("#") -and $linha.Contains("=")) {
    $pos = $linha.IndexOf("=")
    $nome = $linha.Substring(0, $pos).Trim()
    $valor = $linha.Substring($pos + 1).Trim()
    if ($valor) { $variaveis[$nome] = $valor }
  }
}

# Em producao a URL base e a do site publicado, nao localhost.
$variaveis.Remove("NEXT_PUBLIC_APP_URL") | Out-Null

foreach ($nome in $variaveis.Keys) {
  Write-Host "  Enviando $nome..."
  $variaveis[$nome] | vercel env add $nome production 2>$null
}
Ok "Variaveis enviadas"

# ------------------------------------------------------------
Titulo "Publicando"
Write-Host "  Isso leva alguns minutos..."
vercel --prod

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " No ar." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host " O endereco do site aparece logo acima."
Write-Host " Entre com o usuario que voce criou no Supabase."
Write-Host ""
Aviso "Plano gratuito da Vercel limita funcoes a 60s."
Write-Host "     As etapas de pesquisa com busca na web passam disso."
Write-Host "     Para elas funcionarem, o plano Pro e necessario."
Write-Host ""
Write-Host " Depois de entrar, use o botao 'Equipe' para dar acesso"
Write-Host " a cada pessoa do time - todos veem os mesmos clientes."
Write-Host ""
Write-Host " Para publicar mudancas depois: rode este script de novo."
Write-Host ""
