$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$directory = Split-Path -Parent $MyInvocation.MyCommand.Path

# The application, favicon and Windows resources share the rendered master.
$masterPath = Join-Path $directory "../../web/public/loopmarshal.png"
$master = [System.Drawing.Image]::FromFile($masterPath)
if ($master.Width -ne $master.Height -or $master.Width -lt 512) {
    $master.Dispose()
    throw 'The icon master must be square and at least 512 pixels wide.'
}

function Render-Icon([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $attributes = New-Object System.Drawing.Imaging.ImageAttributes
    $stream = New-Object System.IO.MemoryStream
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # Mirrored sampling avoids dark or transparent fringes at the image boundary.
        $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $target = New-Object System.Drawing.Rectangle 0, 0, $size, $size
        $graphics.DrawImage($master, $target, 0, 0, $master.Width, $master.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally {
        $stream.Dispose(); $attributes.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
try { $images = @($sizes | ForEach-Object { ,(Render-Icon $_) }) }
finally { $master.Dispose() }
[System.IO.File]::WriteAllBytes((Join-Path $directory 'icon.png'), $images[$images.Count - 1])
$stream = [System.IO.File]::Create((Join-Path $directory 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
try {
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = $sizes[$index] % 256
        $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension)
        $writer.Write([Byte]0); $writer.Write([Byte]0)
        $writer.Write([UInt16]1); $writer.Write([UInt16]32)
        $writer.Write([UInt32]$images[$index].Length); $writer.Write([UInt32]$offset)
        $offset += $images[$index].Length
    }
    foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
} finally { $writer.Dispose(); $stream.Dispose() }

# Content-based paths refresh Explorer even when the product version stays fixed.
$hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $iconHash = [System.BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $directory 'icon.ico')))).Replace('-', '').ToLowerInvariant().Substring(0, 12)
} finally { $hasher.Dispose() }
[System.IO.File]::WriteAllText((Join-Path $directory 'icon-name.nsh'), ('!define LOOPMARSHAL_SHORTCUT_ICON "loopmarshal-icon-' + $iconHash + '.ico"'), [System.Text.Encoding]::ASCII)
