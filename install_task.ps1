param(
  [string]$TaskName = 'Vega Kiosk Server',
  [int]$Port = 8080
)
# Register the kiosk server as a boot-time task (S4U: runs without a logged-in
# session, same pattern as the DMS automation tasks) and open the firewall port
# so the touchscreen PC can reach it.
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$script = Join-Path $dir 'run_server.ps1'
if (-not (Test-Path $script)) { throw "run_server.ps1 not found in $dir" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"') `
  -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType S4U -RunLevel Highest

$description = "Serves the Vega-M info kiosk (price, schedule, doctors) on port $Port"

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description $description -Force | Out-Null

$rule = Get-NetFirewallRule -DisplayName 'Vega Kiosk HTTP' -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -DisplayName 'Vega Kiosk HTTP' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Domain,Private `
    -Description 'Info kiosk client on the touchscreen PC' | Out-Null
}

$t = Get-ScheduledTask -TaskName $TaskName
'task: ' + $t.TaskName
'state: ' + $t.State
'action: ' + $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments
'firewall: ' + ((Get-NetFirewallRule -DisplayName 'Vega Kiosk HTTP').Enabled)
