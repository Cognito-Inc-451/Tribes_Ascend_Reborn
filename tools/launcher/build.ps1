<#
Build the Ascend Reborn launcher with the compiler that ships with Windows.

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\launcher\build.ps1

Output: tools\launcher\bin\AscendRebornLauncher.exe

No .NET SDK, no MSBuild and no NuGet are required: the launcher is plain
WinForms compiled with .NET Framework's csc.exe (C# 5 language level).
#>
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'src'
$bin = Join-Path $here 'bin'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    throw 'csc.exe (.NET Framework 4.x compiler) not found. Enable it under Windows Features > .NET Framework 4.8 Advanced Services > .NET Framework 4.8 SDK.'
}

if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

# --- Icon -------------------------------------------------------------------
# Drawn at build time so the repository never carries a binary asset it does not
# own. The launcher loads the game's own splash art at runtime when the player
# has imported it, which keeps every Hi-Rez asset on the player's own machine.
$icon = $null
try {
    Add-Type -AssemblyName System.Drawing
    $png = Join-Path $bin 'launcher.png'
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $rect = New-Object System.Drawing.Rectangle 0, 0, 256, 256
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
        [System.Drawing.Color]::FromArgb(18, 52, 56), [System.Drawing.Color]::FromArgb(4, 10, 12), 90)
    $g.FillRectangle($brush, $rect)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(140, 95, 224, 180), 12)
    $g.DrawEllipse($pen, 26, 26, 204, 204)
    $font = New-Object System.Drawing.Font('Segoe UI', 92, [System.Drawing.FontStyle]::Bold)
    $g.DrawString('AR', $font, [System.Drawing.Brushes]::White, 40, 60)
    $g.Dispose()
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    # An .ico may embed a PNG directly (Vista and later), so wrap the bytes in an icon header.
    $pngBytes = [System.IO.File]::ReadAllBytes($png)
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($out)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$pngBytes.Length); $w.Write([uint32]22)
    $w.Write($pngBytes)
    $w.Flush()
    $icon = Join-Path $bin 'launcher.ico'
    [System.IO.File]::WriteAllBytes($icon, $out.ToArray())
    $w.Dispose()
    Remove-Item $png -ErrorAction SilentlyContinue
} catch {
    Write-Warning "Icon generation failed ($($_.Exception.Message)); building without an icon."
    $icon = $null
}

# --- Compile ----------------------------------------------------------------
$refs = @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Core.dll')
$files = Get-ChildItem -Path $src -Filter '*.cs' -Recurse | ForEach-Object { $_.FullName }
$exe = Join-Path $bin 'AscendRebornLauncher.exe'

$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', "/out:$exe")
if ($icon) { $cscArgs += "/win32icon:$icon" }
foreach ($r in $refs) { $cscArgs += "/reference:$r" }
$cscArgs += $files

Write-Host ("csc " + (($files | ForEach-Object { Split-Path -Leaf $_ }) -join ' '))
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host "Built $exe"
Write-Host 'Attach it to a GitHub Release as an asset - players save it anywhere and run it.' -ForegroundColor Green
