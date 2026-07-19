param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [ValidateSet("win-x64", "win-arm64")]
    [string]$Runtime = "win-x64",
    [switch]$SelfContained
)

$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "NcmCli.SmtcBridge.csproj"
$output = Join-Path $PSScriptRoot "publish\$Runtime"
$arguments = @(
    "publish",
    $project,
    "--configuration", $Configuration,
    "--runtime", $Runtime,
    "--self-contained", $SelfContained.IsPresent.ToString().ToLowerInvariant(),
    "--output", $output,
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true"
)

& dotnet @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Remove-Item (Join-Path $PSScriptRoot "bin"), (Join-Path $PSScriptRoot "obj") -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $output -Force | Where-Object { $_.Name -ne "ncm-cli-smtc-bridge.exe" } | Remove-Item -Recurse -Force
