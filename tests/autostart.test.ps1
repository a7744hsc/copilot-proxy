param([string]$ScriptPath, [string]$FixtureDirectory, [string]$NodeExecutable)

$ErrorActionPreference = 'Stop'
. $ScriptPath

function Assert-That {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-Throws {
    param([scriptblock]$Code, [string]$Pattern)
    $failure = $null
    try { & $Code | Out-Null } catch { $failure = $_ }
    Assert-That ($null -ne $failure) "Expected an error matching $Pattern"
    Assert-That ($failure.Exception.Message -match $Pattern) "Unexpected error: $($failure.Exception.Message)"
}

function Resolve-UserSid {
    param([string]$UserId)
    if ($UserId -like 'S-1-*') { return $UserId }
    return ([System.Security.Principal.NTAccount]::new($UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

$context = Get-StartupContext -Root $FixtureDirectory
Assert-That ($context.TaskName -eq (Get-StartupContext -Root $FixtureDirectory).TaskName) 'Task identity must be stable.'
Assert-That ($context.TaskName -ne (Get-StartupContext -Root (Join-Path $FixtureDirectory 'other')).TaskName) 'Different repositories need different task identities.'
$definition = New-StartupDefinition $context $NodeExecutable
Assert-That ((Resolve-UserSid $definition.Principal.UserId) -eq $context.UserId) 'Task must use the current user.'
Assert-That ($definition.Principal.LogonType -eq 3) 'Task must use an interactive token, not a stored password.'
Assert-That ($definition.Principal.RunLevel -eq 0) 'Task must not run elevated.'
Assert-That ((Resolve-UserSid $definition.Triggers[0].UserId) -eq $context.UserId) 'Trigger must target only this user.'
Assert-That ($definition.Triggers[0].Delay -eq 'PT15S') 'Login delay missing.'
Assert-That ($definition.Actions[0].WorkingDirectory -eq $context.Root) 'Working directory is not fixed.'
Assert-That ($definition.Actions[0].Arguments.Contains('"{0}"' -f $NodeExecutable)) 'Node path must be quoted.'
Assert-That ($definition.Actions[0].Arguments.Contains('"{0}"' -f (Join-Path $context.Root 'scripts\autostart.ps1'))) 'Runner path must be quoted.'
Assert-That ($definition.Actions[0].Arguments -match '-NonInteractive -WindowStyle Hidden') 'Unattended launch must be hidden.'
Assert-That ($definition.Actions[0].Arguments -notmatch 'ExecutionPolicy|Bypass|access-token') 'Do not bypass policy or put credentials in task arguments.'
Assert-That ($definition.Settings.ExecutionTimeLimit -eq 'PT0S') 'Long-running proxy must not have a task time limit.'
Assert-That ($definition.Settings.MultipleInstances -eq 2) 'Task must ignore parallel starts.'
Assert-That ($definition.Settings.RestartCount -eq 3) 'Process retries must be bounded.'
Assert-That ($definition.Settings.RestartInterval -eq 'PT1M') 'Unexpected restart interval.'
Assert-That ($definition.Settings.StartWhenAvailable -and -not $definition.Settings.DisallowStartIfOnBatteries -and -not $definition.Settings.StopIfGoingOnBatteries) 'Laptop task settings are incorrect.'

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
try { Assert-Throws { Assert-StartupPortAvailable -Port $port } 'no process was terminated' }
finally { $listener.Stop() }
Assert-StartupPortAvailable -Port $port

$script:Task = $null
$script:Registrations = 0
$script:Starts = 0
$script:Stops = 0
$script:Removals = 0
$script:BuildFailure = $false
$script:PortOccupied = $false
$script:QueryDenied = $false
$script:ActiveProbes = 0

# Replace only the Task Scheduler persistence boundary, never register a real task.
function Get-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath)
    if ($script:QueryDenied) { throw [UnauthorizedAccessException]::new('Task access denied') }
    if ($null -eq $script:Task) {
        $PSCmdlet.ThrowTerminatingError([System.Management.Automation.ErrorRecord]::new(
            [Exception]::new('Task not found'), 'CmdletizationQuery_NotFound',
            [System.Management.Automation.ErrorCategory]::ObjectNotFound, $TaskName))
    }
    return $script:Task
}
function Register-ScheduledTask {
    [CmdletBinding()]
    param($TaskName, $TaskPath, $InputObject, [switch]$Force)
    $script:Registrations++
    $state = if ($null -ne $script:Task) { $script:Task.State } else { 'Ready' }
    $script:Task = [pscustomobject]@{ Description = $InputObject.Description; State = $state }
    return $script:Task
}
function Get-ScheduledTaskInfo {
    [CmdletBinding()]
    param($InputObject)
    [pscustomobject]@{ LastRunTime = [DateTime]::UtcNow; LastTaskResult = 0 }
}
function Start-ScheduledTask {
    [CmdletBinding()]
    param($InputObject)
    $script:Starts++
    $script:Task.State = 'Running'
}
function Stop-ScheduledTask {
    [CmdletBinding()]
    param($InputObject)
    $script:Stops++
    $script:Task.State = 'Ready'
}
function Unregister-ScheduledTask {
    [CmdletBinding(SupportsShouldProcess)]
    param($InputObject)
    $script:Removals++
    $script:Task = $null
}
function Build-StartupApplication {
    param($Context)
    if ($script:BuildFailure) { throw 'Mock build failed' }
}
function Assert-StartupPortAvailable {
    param([int]$Port = 5000)
    if ($script:PortOccupied) { throw 'Port already occupied; no process was terminated.' }
}
function Get-StartupHealth {
    param([switch]$Probe)
    if ($Probe) { $script:ActiveProbes++ }
    [pscustomobject]@{ status = 'ok'; ready = $true; http_status = 200; error = $null }
}

$status = Invoke-StartupCommand status $context | ConvertFrom-Json
Assert-That (-not $status.installed -and $status.proxy_health.ready) 'Manual proxy health must not imply task installation.'
Assert-Throws { Invoke-StartupCommand start $context } 'not installed'
Assert-Throws { Invoke-StartupCommand install $context } 'Authenticate interactively'
New-Item -ItemType Directory -Path (Join-Path $FixtureDirectory '.tokens') | Out-Null
Set-Content -LiteralPath (Join-Path $FixtureDirectory '.tokens\access-token') -Value 'fake-test-token'
Invoke-StartupCommand install $context | Out-Null
Invoke-StartupCommand install $context | Out-Null
Assert-That ($script:Registrations -eq 2 -and $script:Starts -eq 0) 'Install must be repeatable and must not start or take over a running proxy.'
$script:BuildFailure = $true
Assert-Throws { Invoke-StartupCommand install $context } 'Mock build failed'
Assert-That ($script:Registrations -eq 2) 'Build failure must preserve the registered task.'
$script:BuildFailure = $false
$script:PortOccupied = $true
Assert-Throws { Invoke-StartupCommand start $context } 'no process was terminated'
Assert-That ($script:Starts -eq 0) 'Occupied ports must not start another task.'
$script:PortOccupied = $false
$status = Invoke-StartupCommand start $context | ConvertFrom-Json
Assert-That ($status.task_state -eq 'Running' -and $script:ActiveProbes -gt 0) 'Start must actively probe readiness.'
Invoke-StartupCommand start $context | Out-Null
Assert-That ($script:Starts -eq 1) 'Repeated starts must not create parallel instances.'
Invoke-StartupCommand stop $context | Out-Null
Assert-That ($script:Stops -eq 1 -and $null -ne $script:Task) 'Stop must keep registration.'
Invoke-StartupCommand start $context | Out-Null
Invoke-StartupCommand uninstall $context | Out-Null
Invoke-StartupCommand uninstall $context | Out-Null
Assert-That ($script:Stops -eq 2 -and $script:Removals -eq 1) 'Uninstall must stop the task and be idempotent.'

$script:Task = [pscustomobject]@{ Description = 'Foreign task'; State = 'Running' }
foreach ($command in @('install', 'start', 'status', 'stop', 'uninstall')) {
    Assert-Throws { Invoke-StartupCommand $command $context } 'another configuration'
}
Assert-That ($script:Stops -eq 2 -and $script:Removals -eq 1 -and $script:Registrations -eq 2) 'Foreign tasks must remain untouched.'
$script:QueryDenied = $true
Assert-Throws { Get-OwnedStartupTask $context } 'access denied'
$script:QueryDenied = $false

New-Item -ItemType Directory -Path (Join-Path $FixtureDirectory 'dist') | Out-Null
Set-Content -LiteralPath (Join-Path $FixtureDirectory 'dist\index.js') -Encoding ASCII -Value @'
process.stderr.write(JSON.stringify({ cwd: process.cwd(), host: process.env.HOST, port: process.env.PORT, mode: process.env.COPILOT_PROXY_NON_INTERACTIVE, supervised: process.env.COPILOT_PROXY_SUPERVISED, pipe: process.stdin instanceof require('node:net').Socket, config: process.env.CONFIG_PATH }));
process.exitCode = 7;
'@
Assert-Throws { Invoke-StartupProcess $context 'missing-node.exe' } 'registered Node executable is missing'
$code = Invoke-StartupProcess $context $NodeExecutable
Assert-That ($code -eq 7) 'Runner must wait and return the actual child exit code.'
$proof = Get-Content -Raw -LiteralPath (Join-Path $FixtureDirectory 'startup-stderr.log') | ConvertFrom-Json
Assert-That ($proof.cwd -eq $context.Root -and $proof.host -eq '127.0.0.1' -and $proof.port -eq '5000') 'Runner must preserve working directory and loopback settings.'
Assert-That ($proof.mode -eq '1' -and $proof.config -eq (Join-Path $context.Root 'config.json')) 'Runner must set noninteractive auth and an explicit config path.'
Assert-That ($proof.supervised -eq '1' -and $proof.pipe) 'Runner must own a stdin pipe for Node supervision.'
Write-Output 'Autostart checks passed.'
