param([Parameter(Mandatory=$true)][string]$ArtifactDirectory)
$ErrorActionPreference = "Stop"
$artifactRoot = (Resolve-Path $ArtifactDirectory).Path
$extracted = Join-Path $env:RUNNER_TEMP "netft-trust-inspection"
New-Item -ItemType Directory -Path $extracted -Force | Out-Null
$archives = @(Get-ChildItem $artifactRoot -Recurse -Filter *.zip)
if ($archives.Count -ne 1) { throw "Expected exactly one portable archive." }
if ($IsWindows) {
  Expand-Archive -LiteralPath $archives[0].FullName -DestinationPath $extracted
  $files = @(Get-ChildItem $artifactRoot -Recurse -Filter *Setup.exe)
  $files += @(Get-ChildItem $extracted -Recurse -Filter *.exe | Where-Object {
    $_.Name -in @("Net F-T Viewer.exe", "netft-viewer-companion.exe")
  })
  if ($files.Count -ne 3) { throw "Expected installer, application and companion executables." }
  $results = @($files | ForEach-Object {
    $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
    [ordered]@{
      file = $_.Name
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
      status = [string]$signature.Status
      subject = $signature.SignerCertificate.Subject
      thumbprint = $signature.SignerCertificate.Thumbprint
    }
  })
} elseif ($IsMacOS) {
  & ditto -x -k $archives[0].FullName $extracted
  if ($LASTEXITCODE -ne 0) { throw "Cannot extract the portable application." }
  $apps = @(Get-ChildItem $extracted -Recurse -Directory -Filter "Net F-T Viewer.app")
  if ($apps.Count -ne 1) { throw "Expected exactly one application bundle." }
  $results = @()
  foreach ($check in @(
    @{ name="codesign"; command="codesign"; arguments=@("--verify", "--deep", "--strict", $apps[0].FullName) },
    @{ name="gatekeeper"; command="spctl"; arguments=@("--assess", "--type", "execute", "--verbose=2", $apps[0].FullName) },
    @{ name="stapler"; command="xcrun"; arguments=@("stapler", "validate", $apps[0].FullName) }
  )) {
    $command = $check.command
    $arguments = $check.arguments
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $command @arguments 2>&1 | Out-String
    $status = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    $results += [ordered]@{check=$check.name; exit_code=$status; output=$output.Trim()}
  }
} else { throw "Use a native Windows or macOS runner." }
$report = [ordered]@{
  inspection_only = $true
  artifact_run_id = $env:NETFT_ARTIFACT_RUN_ID
  archive_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archives[0].FullName).Hash
  results = $results
}
$json = $report | ConvertTo-Json -Depth 5
$json | Set-Content -LiteralPath artifact-trust.json -Encoding utf8
Write-Output $json
