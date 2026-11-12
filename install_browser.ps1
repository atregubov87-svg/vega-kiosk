# Автозапуск киоска на сенсорном ПК: Edge открывает страницу во весь экран,
# без адресной строки, вкладок и рамки окна.
#
# Запускать НА СЕНСОРНОМ ПК от имени администратора:
#   powershell -ExecutionPolicy Bypass -File install_browser.ps1
# Параметры:
#   -Url            адрес киоска (по умолчанию http://192.168.88.53:8080/)
#   -TaskName       имя задачи планировщика
#   -SkipPolicies   не трогать политики Edge в реестре
#
# Удалить автозапуск:
#   Unregister-ScheduledTask -TaskName 'Vega Kiosk Browser' -Confirm:$false
#
# ВАЖНО: файл сохранён в UTF-8 с BOM. Windows PowerShell 5.1 читает .ps1 без BOM
# как ANSI (cp1251), и кириллица ломает разбор — не пересохранять без BOM.

param(
  [string]$Url = 'http://192.168.88.53:8080/',
  [string]$TaskName = 'Vega Kiosk Browser',
  [switch]$SkipPolicies
)

$ErrorActionPreference = 'Stop'

# Чтобы русские сообщения ниже не превращались в кракозябры в консоли (cp866).
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $edge) { throw 'Не найден msedge.exe. Установите Microsoft Edge или поправьте путь в скрипте.' }

# --- Политики Edge -----------------------------------------------------------
# Без них свежий профиль показывает «InPrivate / импорт избранного», а при
# включённом фоне (StartupBoost, BackgroundMode) Edge держит процесс после
# закрытия окна: новый запуск с --kiosk просто открывает окно в старом
# экземпляре и флаги игнорируются — видим стартовую страницу (Яндекс).
if (-not $SkipPolicies) {
  $policyKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
  if (-not (Test-Path $policyKey)) { New-Item -Path $policyKey -Force | Out-Null }

  # Числовые политики
  $policies = [ordered]@{
    HideFirstRunExperience       = 1   # не показывать мастер первого запуска
    ImportFavorites              = 0   # не предлагать импорт избранного
    ImportHistory                = 0
    ImportCookies                = 0
    ImportSearchEngine           = 0
    ImportSavedPasswords         = 0
    ImportAutofillFormData       = 0
    ImportBrowserSettings        = 0
    ImportHomepage               = 0
    InPrivateModeAvailability    = 1   # InPrivate выключен (0 — разрешён, 2 — всегда)
    DefaultBrowserSettingEnabled = 0
    StartupBoostEnabled          = 0   # не держать процесс после закрытия окна
    BackgroundModeEnabled        = 0   # не работать в фоне
    RestoreOnStartup             = 4   # при старте открывать список адресов ниже
    HomepageIsNewTabPage         = 0
    ShowHomeButton               = 0
  }
  foreach ($name in $policies.Keys) {
    New-ItemProperty -Path $policyKey -Name $name -Value $policies[$name] `
      -PropertyType DWord -Force | Out-Null
  }

  # Строковые политики: стартовый адрес, домашняя и новая вкладка — киоск
  $strings = [ordered]@{
    HomepageLocation   = $Url
    NewTabPageLocation = $Url
  }
  foreach ($name in $strings.Keys) {
    New-ItemProperty -Path $policyKey -Name $name -Value $strings[$name] `
      -PropertyType String -Force | Out-Null
  }

  # RestoreOnStartupURLs: подраздел, по одному адресу на значение "1", "2", ...
  $startupKey = Join-Path $policyKey 'RestoreOnStartupURLs'
  if (-not (Test-Path $startupKey)) { New-Item -Path $startupKey -Force | Out-Null }
  New-ItemProperty -Path $startupKey -Name '1' -Value $Url `
    -PropertyType String -Force | Out-Null

  "Политики Edge заданы в HKLM:\SOFTWARE\Policies\Microsoft\Edge"
}

# --- Закрыть Edge, включая фоновый процесс -----------------------------------
# Двух проходов достаточно и для startup boost: после первого убийства фоновый
# процесс может успеть перезапуститься, второй проход его добивает.
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# URL — отдельным аргументом после --kiosk: так его понимают все сборки Edge.
$arguments = @(
  '--kiosk', $Url,
  '--edge-kiosk-type=fullscreen',          # окно без рамки, адресной строки и вкладок
  '--no-first-run',                        # не показывать мастер первого запуска
  '--no-default-browser-check',
  '--disable-features=msEdgeFirstRunExperience,msImplicitSignin,msEdgeImportFavorites',
  '--disable-sync',                        # не восстанавливать вкладки из профиля
  '--hide-crash-restore-bubble',           # не предлагать «восстановить страницы»
  '--overscroll-history-navigation=0',     # свайп назад/вперёд не уводит со страницы
  '--disable-pinch'                        # без масштабирования двумя пальцами
) -join ' '

$action = New-ScheduledTaskAction -Execute $edge -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit 0 `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

# --- Проверка результата ------------------------------------------------------
Start-Sleep -Seconds 8

$kiosk = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*--kiosk*' } | Select-Object -First 1

if ($kiosk) {
  "Edge запущен в киоск-режиме (PID $($kiosk.ProcessId))."
} else {
  "ВНИМАНИЕ: процесс Edge с --kiosk не найден — возможно, открылось обычное окно."
  "Проверьте: Get-CimInstance Win32_Process -Filter `"Name='msedge.exe'`" | Select ProcessId,CommandLine"
}

$health = $Url.TrimEnd('/') + '/api/health'
try {
  $resp = Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 5
  "Сервер отвечает: $health ($($resp.StatusCode))"
} catch {
  "ВНИМАНИЕ: сервер киоска недоступен ($health). Проверьте сеть и правило"
  "брандмауэра «Vega Kiosk HTTP» (TCP 8080) на 192.168.88.53."
}

"Готово: задача «$TaskName» запускает Edge в полноэкранном режиме при входе в Windows."
"Браузер: $edge"
"Адрес:   $Url"
