param([string]$TaskName = "Rate Ledger - Fifth Third Collector")

$required = "RATE_COLLECTION_READ_TOKEN", "RATE_COLLECTION_WRITE_TOKEN"
$missing = $required | Where-Object { -not [Environment]::GetEnvironmentVariable($_, "User") }
if ($missing) { throw "Set these user environment variables before installing the scheduled task: $($missing -join ', ')" }

$collector = Join-Path $PSScriptRoot "collect-fifth-third.mjs"
$logDirectory = Join-Path $PSScriptRoot "logs"
$log = Join-Path $logDirectory "fifth-third-collector.log"
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$command = "Set-Location -LiteralPath '$PSScriptRoot'; & '$node' '$collector' *>> '$log'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At 4:45AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Collects Citizens Bank, Fifth Third, and PNC public ZIP-specific CD rates for Rate Ledger before the 5 AM ET email cycle." -Force | Out-Null
Write-Output "Installed '$TaskName'. It runs Monday through Friday at 4:45 AM local time and writes diagnostics to $log."
