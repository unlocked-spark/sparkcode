<#
Smoke test for install.ps1, run by hand on a Windows machine:

  .\installer\smoke.ps1
  .\installer\smoke.ps1 -Exe C:\path\to\sparkcode.exe

It packages an executable into sparkcode-windows-x64.zip (a copy of ping.exe
when none is given), installs it from that archive into a temporary directory,
installs it again while the fake program is running, rejects a wrong checksum,
and uninstalls. The user PATH is changed and restored in the process. Prints
one PASS or FAIL line per check and exits 1 when any check failed. No Pester
required. The running-binary check runs only with the default fake, which
stays alive on its own; a real sparkcode.exe is only installed and removed.
#>
param(
  [string]$Exe
)

$ErrorActionPreference = 'Stop'
$failures = 0

function Check([string]$Name, [bool]$Ok) {
  if ($Ok) { Write-Host ("PASS {0}" -f $Name) } else { Write-Host ("FAIL {0}" -f $Name); $script:failures++ }
}

function UserPathCount([string]$Dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { return 0 }
  return @($current -split ';' | Where-Object { $_ -and ($_.Trim().TrimEnd('\').ToLowerInvariant() -eq $Dir.Trim().TrimEnd('\').ToLowerInvariant()) }).Count
}

$installer = Join-Path $PSScriptRoot 'install.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('sparkcode-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$dir = Join-Path $work 'install'

try {
  $fake = -not $Exe
  $source = if ($Exe) { (Resolve-Path -LiteralPath $Exe).Path } else { Join-Path $env:SystemRoot 'System32\ping.exe' }
  $stage = Join-Path $work 'stage'
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'sparkcode.exe')
  $zip = Join-Path $work 'sparkcode-windows-x64.zip'
  Compress-Archive -Path (Join-Path $stage 'sparkcode.exe') -DestinationPath $zip
  $sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()

  Write-Host '--- first install'
  & $installer -Archive $zip -Sha256 $sha -InstallDir $dir
  Check 'installer exits 0' ($LASTEXITCODE -eq 0)
  Check 'sparkcode.exe is in place' (Test-Path -LiteralPath (Join-Path $dir 'sparkcode.exe'))
  Check 'install directory is in the user PATH once' ((UserPathCount $dir) -eq 1)

  Write-Host '--- second install (idempotent)'
  & $installer -Archive $zip -Sha256 $sha -InstallDir $dir
  Check 'reinstall exits 0' ($LASTEXITCODE -eq 0)
  Check 'PATH entry is not duplicated' ((UserPathCount $dir) -eq 1)
  Check 'no sparkcode.old.exe when nothing was running' (-not (Test-Path -LiteralPath (Join-Path $dir 'sparkcode.old.exe')))

  if ($fake) {
    Write-Host '--- install while the program is running'
    $running = Start-Process -FilePath (Join-Path $dir 'sparkcode.exe') -ArgumentList '-n', '60', '127.0.0.1' -WindowStyle Hidden -PassThru
    try {
      Start-Sleep -Seconds 1
      & $installer -Archive $zip -Sha256 $sha -InstallDir $dir
      Check 'install over a running binary exits 0' ($LASTEXITCODE -eq 0)
      Check 'running binary was kept as sparkcode.old.exe' (Test-Path -LiteralPath (Join-Path $dir 'sparkcode.old.exe'))
      Check 'new sparkcode.exe is in place' (Test-Path -LiteralPath (Join-Path $dir 'sparkcode.exe'))
    } finally {
      try { Stop-Process -Id $running.Id -Force } catch {}
      Start-Sleep -Seconds 1
    }
  }

  Write-Host '--- wrong checksum'
  $before = (Get-FileHash -LiteralPath (Join-Path $dir 'sparkcode.exe') -Algorithm SHA256).Hash
  & $installer -Archive $zip -Sha256 ('0' * 64) -InstallDir $dir
  Check 'checksum mismatch exits 1' ($LASTEXITCODE -eq 1)
  $after = (Get-FileHash -LiteralPath (Join-Path $dir 'sparkcode.exe') -Algorithm SHA256).Hash
  Check 'installed file untouched after mismatch' ($before -eq $after)
  Check 'no staged file left behind' (-not (Test-Path -LiteralPath (Join-Path $dir 'sparkcode.new.exe')))

  Write-Host '--- uninstall'
  & $installer -Uninstall -InstallDir $dir
  Check 'uninstall exits 0' ($LASTEXITCODE -eq 0)
  Check 'install directory removed' (-not (Test-Path -LiteralPath $dir))
  Check 'PATH entry removed' ((UserPathCount $dir) -eq 0)
} finally {
  if ((UserPathCount $dir) -gt 0) {
    $kept = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and ($_.Trim().TrimEnd('\').ToLowerInvariant() -ne $dir.Trim().TrimEnd('\').ToLowerInvariant()) })
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
  }
  try { Remove-Item -LiteralPath $work -Recurse -Force } catch {}
}

if ($failures -gt 0) { Write-Host ("{0} check(s) failed." -f $failures); exit 1 }
Write-Host 'All checks passed.'
exit 0
