$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $root 'daily-yield-mailer.mjs') --run *>> (Join-Path $logs 'daily-yield.log')
exit $LASTEXITCODE
