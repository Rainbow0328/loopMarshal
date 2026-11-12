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
}
finally {
  $archive.Dispose()
}
