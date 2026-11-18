param([switch]$Force)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectRoot 'native\Bridge.cs'
$outputDirectory = Join-Path $projectRoot 'native\bin'
$outputPath = Join-Path $outputDirectory 'MacroBridge.exe'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw '.NET Framework 4.x 64-bit compiler is required on Windows.' }
if (-not $Force -and (Test-Path -LiteralPath $outputPath) -and (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc -ge (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc) {
    Write-Output "Native bridge is current: $outputPath"
    exit 0
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compilerPath /nologo /target:exe /platform:x64 /optimize+ /warn:4 /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$outputPath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Native bridge compilation failed with exit code $LASTEXITCODE" }
Write-Output "Built native bridge: $outputPath"
