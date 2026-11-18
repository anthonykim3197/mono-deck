$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packagedExe = Join-Path $projectRoot 'release\win-unpacked\MONO DECK.exe'
if (Test-Path -LiteralPath $packagedExe) {
    $binaryDir = Split-Path -Parent $packagedExe
    & icacls $binaryDir /grant '*S-1-15-2-1:(OI)(CI)(RX)' | Out-Null
    Start-Process -FilePath $packagedExe -WorkingDirectory $binaryDir
} else {
    $electronExe = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
    if (!(Test-Path -LiteralPath $electronExe)) { throw 'Run npm install, then node node_modules/electron/install.js and npm run build first.' }
    $binaryDir = Split-Path -Parent $electronExe
    & icacls $binaryDir /grant '*S-1-15-2-1:(OI)(CI)(RX)' | Out-Null
    Start-Process -FilePath $electronExe -ArgumentList ('"' + $projectRoot + '"') -WorkingDirectory $projectRoot
}
