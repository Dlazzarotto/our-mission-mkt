# ============================================================
#  Our Mission MKT - Enviar para o GitHub (PowerShell)
#
#  Primeira vez: cria o repositorio privado e envia.
#  Depois: envia so as mudancas (a Vercel republica sozinha).
#
#  Como rodar:
#     powershell -ExecutionPolicy Bypass -File .\3-github.ps1
#     powershell -ExecutionPolicy Bypass -File .\3-github.ps1 -Mensagem "ajuste na pesquisa"
# ============================================================

param(
  [string]$PastaProjeto = "",
  [string]$Repositorio  = "our-mission-mkt",
  [string]$Mensagem     = ""
)

$ErrorActionPreference = "Stop"

function Titulo($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Erro($t)   { Write-Host "  [x]  $t" -ForegroundColor Red }

# Descobre a pasta do projeto
if (-not $PastaProjeto) {
  $candidatos = @()
  if ($PSScriptRoot) {
    $candidatos += (Split-Path -Parent $PSScriptRoot)
    $candidatos += $PSScriptRoot
  }
  $candidatos += "C:\Users\PeaceonTax\OneDrive - Peace on Tax\Confidencial-David\Our Mission Marketing"
  foreach ($raiz in @($PSScriptRoot, (Split-Path -Parent $PSScriptRoot)) | Where-Object { $_ }) {
    Get-ChildItem -LiteralPath $raiz -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidatos += $_.FullName
    }
  }
  foreach ($c in $candidatos) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "package.json"))) { $PastaProjeto = $c; break }
  }
  if (-not $PastaProjeto) { $PastaProjeto = $candidatos[-1] }
}

if (-not (Test-Path -LiteralPath (Join-Path $PastaProjeto "package.json"))) {
  Erro "Projeto nao encontrado em: $PastaProjeto"
  exit 1
}
Write-Host ""
Write-Host "Pasta do projeto:" -ForegroundColor White
Write-Host "  $PastaProjeto"
Set-Location -LiteralPath $PastaProjeto

# ------------------------------------------------------------
Titulo "Requisitos"

try { $v = (git --version) 2>$null; Ok $v }
catch {
  Aviso "Instalando Git..."
  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  try { $v = (git --version) 2>$null; Ok $v }
  catch { Erro "Git instalado, mas o PowerShell ainda nao enxerga. Feche e abra o PowerShell, e rode de novo."; exit 1 }
}

try { (gh --version) 2>$null | Out-Null; Ok "GitHub CLI" }
catch {
  Aviso "Instalando GitHub CLI..."
  winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
  try { (gh --version) 2>$null | Out-Null; Ok "GitHub CLI" }
  catch { Erro "GitHub CLI instalado, mas o PowerShell ainda nao enxerga. Feche e abra o PowerShell, e rode de novo."; exit 1 }
}

# ------------------------------------------------------------
Titulo "Conta GitHub"
$logado = $false
try { gh auth status 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { $logado = $true } } catch { }
if ($logado) {
  Ok "Ja conectado"
} else {
  Write-Host "  Responda: GitHub.com > HTTPS > Y > Login with a web browser"
  gh auth login
  Ok "Conectado"
}

# ------------------------------------------------------------
Titulo "Seguranca"

# O .gitignore bloqueia .env*, mas conferimos antes de qualquer envio.
if (Test-Path -LiteralPath ".env.local") {
  $rastreado = git check-ignore .env.local 2>$null
  if ($rastreado) { Ok ".env.local protegido - nao vai para o GitHub" }
  else { Erro "ATENCAO: .env.local NAO esta protegido pelo .gitignore. Corrija antes de continuar."; exit 1 }
}

# ------------------------------------------------------------
Titulo "Git"

if (-not (Test-Path -LiteralPath ".git")) {
  git init | Out-Null
  git branch -M main
  Ok "Repositorio local criado"
} else {
  Ok "Repositorio local ja existe"
}

# Identidade do autor (obrigatoria para o commit)
$nome  = (git config user.name)  2>$null
$email = (git config user.email) 2>$null
if (-not $nome)  { $n = Read-Host "  Seu nome para os commits"; git config user.name $n }
if (-not $email) { $e = Read-Host "  Seu e-mail para os commits"; git config user.email $e }

git add -A
$temMudancas = (git status --porcelain)
if ($temMudancas) {
  if (-not $Mensagem) {
    $Mensagem = "Atualizacao " + (Get-Date -Format "dd/MM/yyyy HH:mm")
  }
  git commit -m $Mensagem | Out-Null
  Ok "Commit: $Mensagem"
} else {
  Ok "Nada mudou desde o ultimo envio"
}

# ------------------------------------------------------------
Titulo "Enviar"

$temRemoto = $false
try { git remote get-url origin 2>&1 | Out-Null; if ($LASTEXITCODE -eq 0) { $temRemoto = $true } } catch { }

if ($temRemoto) {
  $url = (git remote get-url origin)
  Write-Host "  Enviando para $url"
  git push -u origin main
  Ok "Enviado"
} else {
  Write-Host "  Criando repositorio privado '$Repositorio' no GitHub..."
  gh repo create $Repositorio --private --source=. --remote=origin --push
  Ok "Repositorio criado e codigo enviado"
}

$urlFinal = (git remote get-url origin)

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host " Codigo no GitHub." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host " Repositorio: $urlFinal"
Write-Host ""
Write-Host " Proximo passo - primeira vez:"
Write-Host "   1. Entre em vercel.com > Add New > Project"
Write-Host "   2. Importe o repositorio '$Repositorio'"
Write-Host "   3. Cadastre as 5 variaveis de ambiente (estao no seu .env.local,"
Write-Host "      menos a NEXT_PUBLIC_APP_URL)"
Write-Host "   4. Deploy"
Write-Host ""
Write-Host " Depois disso, para publicar qualquer mudanca:"
Write-Host "   powershell -ExecutionPolicy Bypass -File .\3-github.ps1"
Write-Host "   (a Vercel republica sozinha a cada envio)"
Write-Host ""
