[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskFramework = if ([Environment]::Is64BitOperatingSystem) { 'Framework64' } else { 'Framework' }
$taskCompiler = Join-Path $env:WINDIR "Microsoft.NET\$taskFramework\v4.0.30319\csc.exe"
if (!(Test-Path -LiteralPath $taskCompiler)) { throw '.NET Framework 4 compiler was not found.' }
$taskSource = Join-Path $PSScriptRoot 'SilentVoice.cs'
$taskOutput = Join-Path $PSScriptRoot 'ForeverAssistant.SilentVoice3.dll'
$taskArguments = @('/nologo', '/target:library', '/platform:anycpu', '/optimize+', ('/out:' + $taskOutput), $taskSource)
& $taskCompiler @taskArguments
if ($LASTEXITCODE -ne 0) { throw 'Silent voice compilation failed.' }
Write-Output "Built $taskOutput"
