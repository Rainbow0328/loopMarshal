param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$NodeVersion
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($ArchivePath))
try {
  $prefix = "node-v$NodeVersion-win-x64/"
  $files = @{
    "$($prefix)node.exe" = "node.exe"
    "$($prefix)LICENSE" = "LICENSE"
    "$($prefix)README.md" = "README.md"
    "$($prefix)npm.cmd" = "npm.cmd"
    "$($prefix)npx.cmd" = "npx.cmd"
  }
  $root = [System.IO.Path]::GetFullPath($OutputDirectory)
  [System.IO.Directory]::CreateDirectory($root) | Out-Null
  foreach ($entryName in $files.Keys) {
    $entry = $archive.GetEntry($entryName)
    if ($null -eq $entry) { throw "Required Node distribution file is missing: $entryName" }
    $destination = [System.IO.Path]::Combine($root, $files[$entryName])
    $sourceStream = $entry.Open()
    $targetStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $sourceStream.CopyTo($targetStream) }
    finally { $targetStream.Dispose(); $sourceStream.Dispose() }
  }
  # npm is shipped in the same checksum-verified Node distribution. This keeps
  # one-click Worker installation available without a system Node/npm install.
  foreach ($entry in $archive.Entries) {
    if (-not $entry.FullName.StartsWith("$($prefix)node_modules/npm/", [System.StringComparison]::Ordinal)) { continue }
    if ($entry.FullName.EndsWith("/")) { continue }
    $relativeName = $entry.FullName.Substring($prefix.Length).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $destination = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $relativeName))
    if (-not $destination.StartsWith($root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Unexpected path in npm distribution"
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null
    $sourceStream = $entry.Open()
    $targetStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $sourceStream.CopyTo($targetStream) }
    finally { $targetStream.Dispose(); $sourceStream.Dispose() }
  }
  if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($root, "node_modules", "npm", "bin", "npm-cli.js"))) {
    throw "Bundled npm entry is missing"
  }
}
finally {
  $archive.Dispose()
}
