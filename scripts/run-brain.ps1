#---------------------------------------------------------------------------------------------
#  CodeMind Project Brain launcher (development)
#
#  Starts everything the persistent project memory needs, turns the brain on for the developer,
#  then launches CodeMind:
#    1. reads the provider key from %USERPROFILE%\.codemind\ppb.env
#    2. brings up the Docker stack (PostgreSQL+pgvector, Neo4j, Redis)
#    3. starts the local embedding stand-in and the Headroom proxy (if available)
#    4. sets the PPB environment and enables ppbEnabled in %USERPROFILE%\.codemind\projects.json
#    5. runs scripts\run.bat with any folder you pass
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File scripts\run-brain.ps1
#    powershell -ExecutionPolicy Bypass -File scripts\run-brain.ps1 D:\path\to\your\project
#---------------------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptsDir = $PSScriptRoot
$repoRoot   = Split-Path -Parent $scriptsDir
$prefsDir   = Join-Path $env:USERPROFILE '.codemind'
$envFile    = Join-Path $prefsDir 'ppb.env'
$prefsFile  = Join-Path $prefsDir 'projects.json'

function Test-Port([int]$Port) {
	return (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
}

# 1. Optional overrides from ppb.env (KEY=VALUE lines). By default the brain follows the provider
#    configured in the CodeMind panel — model, endpoint and key — so this file is usually empty.
if (Test-Path $envFile) {
	Get-Content -LiteralPath $envFile | ForEach-Object {
		if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
			[Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), 'Process')
		}
	}
}

# 2. Infrastructure defaults. The extraction model, endpoint and key come from the panel; the
#    engine normalises the panel base URL to the OpenAI /v1 shape for the extraction call.
if (-not $env:PPB_EXTRACT_TIMEOUT_MS) { $env:PPB_EXTRACT_TIMEOUT_MS = '90000' }
if (-not $env:PPB_EMBED_BASE_URL)     { $env:PPB_EMBED_BASE_URL     = 'http://127.0.0.1:20129/v1' }
if (-not $env:PPB_EMBED_MODEL)        { $env:PPB_EMBED_MODEL        = 'local-hash-2048' }
if (-not $env:PPB_EMBEDDING_DIM)      { $env:PPB_EMBEDDING_DIM      = '2048' }
if (-not $env:PPB_PG_URL)             { $env:PPB_PG_URL             = 'postgres://postgres:postgres@localhost:55432/codemind_ppb' }
if (-not $env:PPB_NEO4J_URL)          { $env:PPB_NEO4J_URL          = 'bolt://localhost:57687' }
if (-not $env:PPB_REDIS_URL)          { $env:PPB_REDIS_URL          = 'redis://localhost:56379' }
if (-not $env:PPB_EMBED_API_KEY)      { $env:PPB_EMBED_API_KEY      = '' }
$env:CODEMIND_PPB_ENABLED = '1'
# Reasoning-model gateways can burn the whole output budget on extended thinking and never emit a
# tool call, so the agent only plans. Disable extended thinking by default; override in ppb.env.
if (-not $env:CODEMIND_THINKING) { $env:CODEMIND_THINKING = 'off' }
# Raise the Claude Agent SDK's output ceiling (it hard-caps at 64000) before CodeMind starts,
# otherwise long file writes are truncated at the 32k default and the turn stops mid-task.
if (-not $env:CLAUDE_CODE_MAX_OUTPUT_TOKENS) { $env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = '64000' }

# 3. Backing services.
Push-Location $repoRoot
try {
	try {
		Write-Host 'Starting PostgreSQL / Neo4j / Redis ...'
		docker compose -f infra/ppb/docker-compose.yml up -d | Out-Host
	} catch {
		Write-Host "Could not start the Docker services ($($_.Exception.Message))." -ForegroundColor Yellow
		Write-Host 'Start Docker Desktop and run this launcher again.' -ForegroundColor Yellow
	}

	# 4. Embedding stand-in.
	if (-not (Test-Port 20129)) {
		Write-Host 'Starting embedding stand-in on :20129 ...'
		Start-Process -FilePath 'node' -ArgumentList (Join-Path $scriptsDir 'embed-standin.mjs') -WindowStyle Hidden
	}

	# 5. Headroom proxy (optional; fast heuristic path, no ML compression).
	if (-not (Test-Port 7878)) {
		$headroom = Get-Command headroom -ErrorAction SilentlyContinue
		if ($headroom) {
			Write-Host 'Starting Headroom proxy on :7878 ...'
			Start-Process -FilePath $headroom.Source -ArgumentList 'proxy', '--port', '7878', '--no-llmlingua' -WindowStyle Hidden
		} else {
			Write-Host 'Headroom CLI not found on PATH — running without it (optional).'
		}
	}

	# 6. Read-only dashboard: what the brain is actually storing (PostgreSQL + Neo4j).
	if (-not (Test-Port 20200)) {
		Write-Host 'Starting Project Brain dashboard on :20200 ...'
		Start-Process -FilePath 'node' -ArgumentList (Join-Path $scriptsDir 'brain-dashboard.mjs') -WindowStyle Hidden
	}
} finally {
	Pop-Location
}

# 7. Enable the brain for this developer in projects.json (preserve existing content).
if (-not (Test-Path $prefsDir)) { New-Item -ItemType Directory -Path $prefsDir | Out-Null }
$prefs = [ordered]@{ version = 1; globalPrefs = [ordered]@{ ppbEnabled = $true; maxInjectionTokens = 2000 }; projects = [ordered]@{} }
if (Test-Path $prefsFile) {
	try {
		$existing = Get-Content -Raw -LiteralPath $prefsFile | ConvertFrom-Json
		if ($existing.PSObject.Properties['version'])      { $prefs.version = $existing.version }
		if ($existing.PSObject.Properties['projects'])     { $prefs.projects = $existing.projects }
		if ($existing.PSObject.Properties['globalPrefs']) {
			$gp = $existing.globalPrefs
			$prefs.globalPrefs.ppbEnabled = $true
			if ($gp.PSObject.Properties['maxInjectionTokens']) { $prefs.globalPrefs.maxInjectionTokens = $gp.maxInjectionTokens }
		}
	} catch {
		Write-Host "projects.json was unreadable; replacing it with defaults." -ForegroundColor Yellow
	}
}
$prefs | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $prefsFile -Encoding UTF8

Write-Host ''
Write-Host 'Project Brain enabled. Launching CodeMind ...' -ForegroundColor Green
Write-Host '  In the panel: use /brain to check status, and ask the agent to "recall project knowledge".' -ForegroundColor Green
Write-Host ''

# 8. Launch the editor (forwards an optional folder argument).
& (Join-Path $scriptsDir 'run-editor.bat') @args