# Supervisor for the kiosk server: keeps node running if it ever exits.
# Started by the scheduled task "Vega Kiosk Server" at boot (S4U, session 0).
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$supervisorLog = Join-Path $dir 'logs\supervisor.log'
$stdoutLog = Join-Path $dir 'logs\stdout.log'

function Write-Supervisor([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'), $message
  Add-Content -Path $supervisorLog -Value $line -Encoding UTF8
  Write-Output $line
}

$env:NODE_ENV = 'production'
$env:VEGA_KIOSK_CONFIG = Join-Path $env:USERPROFILE '.claude\tools\db\kiosk_config.json'

while ($true) {
  try {
    $proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
      -WorkingDirectory $dir -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog -RedirectStandardError ($stdoutLog + '.err')
    Write-Supervisor ("started node pid {0}" -f $proc.Id)
    $proc.WaitForExit()
    Write-Supervisor ("node exited with {0}, restarting in 5s" -f $proc.ExitCode)
  } catch {
    Write-Supervisor ("failed to start node: {0}; retrying in 15s" -f $_.Exception.Message)
    Start-Sleep -Seconds 15
  }
  Start-Sleep -Seconds 5
}
