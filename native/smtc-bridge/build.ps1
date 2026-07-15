param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [ValidateSet("win-x64", "win-arm64")]
    [string]$Runtime = "win-x64",
    [switch]$SelfContained
)

$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "NcmCli.SmtcBridge.csproj"
$arguments = @(
    "publish",
    $project,
    "--configuration", $Configuration,
    "--runtime", $Runtime,
    "--self-contained", $SelfContained.IsPresent.ToString().ToLowerInvariant(),
    "-p:PublishSingleFile=true",
    "-p:IncludeNativeLibrariesForSelfExtract=true"
)

& dotnet @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
