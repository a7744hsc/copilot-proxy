[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'start', 'status', 'stop', 'uninstall', 'run')]
    [string]$Action = 'status',
    [string]$NodePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-StartupContext {
    param([string]$Root = $script:ProjectRoot)

    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User.Value } finally { $identity.Dispose() }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$sid|$($rootPath.ToUpperInvariant())")
        $suffix = ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').Substring(0, 16)
    } finally { $hash.Dispose() }
    [pscustomobject]@{
        Root = $rootPath
        UserId = $sid
        TaskName = "CopilotProxy-$suffix"
        Description = "copilot-proxy autostart v1 | $sid | $rootPath"
    }
}

function Get-OwnedStartupTask {
    param($Context)

    try {
        $task = Get-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound,*') { return $null }
        throw
    }
    if ($task.Description -ne $Context.Description) {
        throw "Task $($Context.TaskName) belongs to another configuration; refusing to modify it."
    }
    return $task
}

function New-StartupDefinition {
    param($Context, [string]$NodeExecutable)

    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $runner = Join-Path $Context.Root 'scripts\autostart.ps1'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" run -NodePath "{1}"' -f $runner, $NodeExecutable
    $taskAction = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $Context.Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Context.UserId
    $trigger.Delay = 'PT15S'
    $principal = New-ScheduledTaskPrincipal -UserId $Context.UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
    New-ScheduledTask -Action $taskAction -Trigger $trigger -Principal $principal `
        -Settings $settings -Description $Context.Description
}

function Build-StartupApplication {
    param($Context)

    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Push-Location -LiteralPath $Context.Root
    try {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed ($LASTEXITCODE); the scheduled task was not changed." }
    } finally { Pop-Location }
}

function Assert-StartupPortAvailable {
    param([int]$Port = 5000)

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Server.ExclusiveAddressUse = $true
    try { $listener.Start() }
    catch { throw "Cannot bind 127.0.0.1:${Port}: $($_.Exception.Message). Stop the existing listener yourself; no process was terminated." }
    finally { $listener.Stop() }
}

function Get-StartupHealth {
    param([switch]$Probe)

    Add-Type -AssemblyName System.Net.Http
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $response = $null
    try {
        $url = if ($Probe) { 'http://127.0.0.1:5000/health/ready' } else { 'http://127.0.0.1:5000/health' }
        $response = $client.GetAsync($url).GetAwaiter().GetResult()
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $health = $text | ConvertFrom-Json -ErrorAction Stop
        [pscustomobject]@{
            status = $health.status
            ready = ($response.IsSuccessStatusCode -and $health.ready -eq $true)
            http_status = [int]$response.StatusCode
            error = $null
        }
    } catch {
        [pscustomobject]@{ status = 'unavailable'; ready = $false; http_status = $null; error = $_.Exception.Message }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
    }
}

function Get-StartupStatus {
    param($Context, [switch]$Probe)

    $task = Get-OwnedStartupTask $Context
    $info = if ($null -ne $task) { Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop }
    [pscustomobject]@{
        task_name = $Context.TaskName
        installed = ($null -ne $task)
        task_state = if ($null -ne $task) { [string]$task.State } else { $null }
        last_run_time = if ($null -ne $info) { $info.LastRunTime } else { $null }
        last_result_code = if ($null -ne $info) { $info.LastTaskResult } else { $null }
        proxy_health = Get-StartupHealth -Probe:$Probe
        note = 'Endpoint health can belong to a manually started proxy; it does not prove task ownership.'
    }
}

function Stop-OwnedStartupTask {
    param($Context)

    $task = Get-OwnedStartupTask $Context
    if ($null -eq $task) { return }
    if ([string]$task.State -in @('Running', 'Queued')) {
        Stop-ScheduledTask -InputObject $task -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $task = Get-OwnedStartupTask $Context
            if ($null -eq $task -or [string]$task.State -notin @('Running', 'Queued')) { return }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        throw "Task $($Context.TaskName) did not stop. Its registration was left intact."
    }
}

function Invoke-StartupProcess {
    param($Context, [string]$NodeExecutable)

    if (-not $NodeExecutable -or -not [System.IO.Path]::IsPathRooted($NodeExecutable) -or
        -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        throw 'The registered Node executable is missing. Run npm run autostart -- install again.'
    }
    $entry = Join-Path $Context.Root 'dist\index.js'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'dist\index.js is missing. Run npm run build.' }
    Assert-StartupPortAvailable
    $env:HOST = '127.0.0.1'
    $env:PORT = '5000'
    $env:LOG_LEVEL = 'info'
    $env:COPILOT_PROXY_NON_INTERACTIVE = '1'
    $env:COPILOT_PROXY_SUPERVISED = '1'
    # Do not inherit another project's config from the desktop environment.
    $env:CONFIG_PATH = Join-Path $Context.Root 'config.json'
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $NodeExecutable
    $startInfo.Arguments = '"{0}"' -f $entry
    $startInfo.WorkingDirectory = $Context.Root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardError = $true
    $child = [System.Diagnostics.Process]::new()
    $child.StartInfo = $startInfo
    $errorLog = $null
    $started = $false
    try {
        $errorLog = [System.IO.File]::Open((Join-Path $Context.Root 'startup-stderr.log'),
            [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $started = $child.Start()
        if (-not $started) { throw 'Failed to launch the background Node process.' }
        $copy = $child.StandardError.BaseStream.CopyToAsync($errorLog)
        $child.WaitForExit()
        $null = $copy.GetAwaiter().GetResult()
        return $child.ExitCode
    } finally {
        if ($started) { $child.StandardInput.Close() }
        if ($null -ne $errorLog) { $errorLog.Dispose() }
        $child.Dispose()
    }
}

function Invoke-StartupCommand {
    param([string]$Command, $Context)

    switch ($Command) {
        'install' {
            $null = Get-OwnedStartupTask $Context
            $tokenFile = Join-Path $Context.Root '.tokens\access-token'
            if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf) -or (Get-Item -LiteralPath $tokenFile).Length -eq 0) {
                throw 'Authenticate interactively with npm start before installing autostart.'
            }
            $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
            Build-StartupApplication $Context
            $definition = New-StartupDefinition $Context $node
            $null = Get-OwnedStartupTask $Context
            Register-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -InputObject $definition -Force -ErrorAction Stop | Out-Null
            Write-Host 'Installed for the current user. It starts at the next login, not immediately.'
        }
        'start' {
            $task = Get-OwnedStartupTask $Context
            if ($null -eq $task) { throw 'Autostart is not installed. Run npm run autostart -- install first.' }
            if ([string]$task.State -notin @('Running', 'Queued')) {
                Assert-StartupPortAvailable
                Start-ScheduledTask -InputObject $task -ErrorAction Stop
            }
            $deadline = [DateTime]::UtcNow.AddSeconds(30)
            do {
                $status = Get-StartupStatus $Context -Probe
                if ($status.task_state -eq 'Running' -and $status.proxy_health.ready) {
                    $status | ConvertTo-Json -Depth 5
                    return
                }
                Start-Sleep -Seconds 1
            } while ([DateTime]::UtcNow -lt $deadline)
            throw "Startup did not become ready within 30 seconds. Last result: $($status.last_result_code). Check proxy.log, startup.log, and startup-stderr.log; use the status command for current state."
        }
        'status' { }
        'stop' { Stop-OwnedStartupTask $Context }
        'uninstall' {
            Stop-OwnedStartupTask $Context
            $task = Get-OwnedStartupTask $Context
            if ($null -ne $task) { Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop }
        }
        default { throw "Unknown command: $Command" }
    }
    Get-StartupStatus $Context | ConvertTo-Json -Depth 5
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $context = Get-StartupContext
        if ($Action -eq 'run') {
            $code = Invoke-StartupProcess $context $NodePath
            if ($code -ne 0) {
                Add-Content -LiteralPath (Join-Path $context.Root 'startup.log') `
                    -Value "$([DateTime]::UtcNow.ToString('o')) Node exited with code $code. See proxy.log and startup-stderr.log."
            }
            exit $code
        }
        Invoke-StartupCommand $Action $context
    } catch {
        if ($Action -eq 'run') {
            Add-Content -LiteralPath (Join-Path $script:ProjectRoot 'startup.log') `
                -Value "$([DateTime]::UtcNow.ToString('o')) $($_.Exception.Message)" -ErrorAction Continue
        }
        Write-Error $_ -ErrorAction Continue
        exit 1
    }
}
