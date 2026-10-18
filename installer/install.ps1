<#
SparkCode installer for Windows.

  irm https://sparkcode.unlockedspark.org/install.ps1 | iex
  .\install.ps1 -Version 2.0.32-sparkcode.1
  .\install.ps1 -Uninstall

Runs on Windows PowerShell 5.1 and PowerShell 7 with built-in cmdlets only.
Installs to %LOCALAPPDATA%\Programs\sparkcode without administrator rights
and adds that directory to the user PATH. Every step is one plain line of
output, so a screen reader can follow it; there are no progress bars.
#>
[CmdletBinding()]
param(
  # A specific release instead of the latest one, for example 2.0.32-sparkcode.1.
  [string]$Version,
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\sparkcode'),
  # A local zip instead of a download (smoke tests). The checksum is checked only when -Sha256 is given.
  [string]$Archive,
  [string]$Sha256,
  [switch]$Uninstall
)

# Piped through iex the script runs in the caller's scope, so the preferences
# it changes are put back at the end (see the finally block at the bottom).
$SavedErrorActionPreference = $ErrorActionPreference
$SavedProgressPreference = $ProgressPreference
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Site = 'https://sparkcode.unlockedspark.org'
$Repository = 'https://github.com/unlocked-spark/sparkcode'
$AssetName = 'sparkcode-windows-x64.zip'
$ExeName = 'sparkcode.exe'
$OldName = 'sparkcode.old.exe'
$NewName = 'sparkcode.new.exe'
# Piped through iex there is no script file and `exit` would close the caller's shell;
# run as a file (also by `sparkcode update`) the exit code is what the caller reads.
$RunAsFile = [bool]$PSCommandPath

function Say([string]$Text) { Write-Host $Text }

function Fail([string]$Step, [string]$Cause) {
  throw ("{0} failed: {1}" -f $Step, $Cause)
}

function Use-Tls12 {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
    # PowerShell 7 negotiates TLS 1.2 on its own.
  }
}

function Get-Text([string]$Url, [string]$Step) {
  try {
    return [string](Invoke-RestMethod -UseBasicParsing -Uri $Url)
  } catch {
    Fail $Step ("could not read {0}: {1}" -f $Url, $_.Exception.Message)
  }
}

function Get-Feed([string]$FeedUrl, [string]$Step) {
  try {
    $feed = Invoke-RestMethod -UseBasicParsing -Uri $FeedUrl
  } catch {
    $status = $null
    if ($_.Exception.Response) { try { $status = [int]$_.Exception.Response.StatusCode } catch {} }
    if ($status -eq 404 -and -not $Version) { Fail $Step ("no SparkCode release is published yet ({0})" -f $FeedUrl) }
    if ($status -eq 404) { Fail $Step ("there is no release {0} ({1})" -f $Version, $FeedUrl) }
    Fail $Step ("could not read {0}: {1}" -f $FeedUrl, $_.Exception.Message)
  }
  if ($feed -is [string]) { try { $feed = $feed | ConvertFrom-Json } catch { Fail $Step ("the feed at {0} is not valid" -f $FeedUrl) } }
  $asset = $null
  if ($feed.assets) { $asset = $feed.assets.'windows-x64' }
  if (-not $feed.version -or -not $asset -or -not $asset.url -or -not $asset.sha256) {
    Fail $Step ("the feed at {0} has no windows-x64 release" -f $FeedUrl)
  }
  $size = 0
  if ($asset.size) { $size = [long]$asset.size }
  return @{ Version = [string]$feed.version; Url = [string]$asset.url; Sha256 = [string]$asset.sha256; Size = $size }
}

function Get-Release {
  # Every release carries its own copy of the feed, so a pinned version reads
  # the same shape from the release instead of the latest one from the site.
  if ($Version) {
    $v = $Version.Trim().TrimStart('v')
    return Get-Feed "$Repository/releases/download/v$v/sparkcode.json" 'Reading the release'
  }
  return Get-Feed "$Site/update/sparkcode.json" 'Checking the latest version'
}

function Test-SamePath([string]$A, [string]$B) {
  return $A.Trim().TrimEnd('\').ToLowerInvariant() -eq $B.Trim().TrimEnd('\').ToLowerInvariant()
}

# The user PATH is read and written through the registry, unexpanded and as
# REG_EXPAND_SZ: [Environment]::GetEnvironmentVariable returns it expanded and
# SetEnvironmentVariable would write it back as REG_SZ, turning Windows' own
# %USERPROFILE%\AppData\Local\Microsoft\WindowsApps into a fixed path.
function Get-UserPath {
  $key = Get-Item -LiteralPath 'HKCU:\Environment'
  $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $value) { return '' }
  return [string]$value
}

function Set-UserPath([string]$Value) {
  Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $Value -Type ExpandString
  # Tell Explorer and new terminals about the change. Setting a user variable
  # through .NET broadcasts WM_SETTINGCHANGE; a throwaway one does that without
  # rewriting Path itself.
  [Environment]::SetEnvironmentVariable('SPARKCODE_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('SPARKCODE_PATH_REFRESH', $null, 'User')
}

function Get-UserPathEntries {
  $current = Get-UserPath
  if (-not $current) { return @() }
  return @($current -split ';' | Where-Object { $_ -and $_.Trim() })
}

function Add-ToUserPath([string]$Dir) {
  $entries = Get-UserPathEntries
  foreach ($entry in $entries) {
    if (Test-SamePath ([Environment]::ExpandEnvironmentVariables($entry)) $Dir) { Say ("{0} is already in your PATH." -f $Dir); return }
  }
  Say ("Adding {0} to your PATH." -f $Dir)
  $joined = (@($entries) + $Dir) -join ';'
  try {
    Set-UserPath $joined
  } catch {
    Fail 'Adding to PATH' $_.Exception.Message
  }
  if ($joined.Length -gt 2047) {
    Say ("Your PATH is longer than 2047 characters and some programs truncate it. If sparkcode is not found, add {0} to PATH by hand." -f $Dir)
  }
  Say 'New terminals pick it up.'
}

function Remove-FromUserPath([string]$Dir) {
  $entries = Get-UserPathEntries
  $kept = @($entries | Where-Object { -not (Test-SamePath ([Environment]::ExpandEnvironmentVariables($_)) $Dir) })
  if ($kept.Count -eq $entries.Count) { return }
  Say ("Removing {0} from your PATH." -f $Dir)
  try {
    Set-UserPath ($kept -join ';')
  } catch {
    Fail 'Removing from PATH' $_.Exception.Message
  }
}

function Move-WithRetry([string]$From, [string]$To, [string]$Step) {
  $attempt = 0
  while ($true) {
    $attempt++
    try {
      Move-Item -LiteralPath $From -Destination $To -Force
      return
    } catch {
      if ($attempt -ge 3) { Fail $Step ("could not write {0}: {1}" -f $To, $_.Exception.Message) }
      Start-Sleep -Seconds 2
    }
  }
}

function Install-SparkCode {
  Say ("SparkCode installer. Installing to {0}." -f $InstallDir)
  Use-Tls12
  $work = Join-Path ([IO.Path]::GetTempPath()) ('sparkcode-install-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $staged = Join-Path $InstallDir $NewName
  try {
    if ($Archive) {
      $release = @{ Version = 'local archive'; Url = $Archive; Sha256 = $Sha256; Size = 0 }
      $zip = (Resolve-Path -LiteralPath $Archive).Path
      Say ("Using {0}." -f $zip)
    } else {
      $release = Get-Release
      $zip = Join-Path $work $AssetName
      if ($release.Size -gt 0) {
        Say ("Downloading SparkCode {0} ({1} MB)." -f $release.Version, [math]::Round($release.Size / 1MB))
      } else {
        Say ("Downloading SparkCode {0}." -f $release.Version)
      }
      try {
        Invoke-WebRequest -UseBasicParsing -Uri $release.Url -OutFile $zip
      } catch {
        Fail 'Downloading' ("could not download {0}: {1}" -f $release.Url, $_.Exception.Message)
      }
    }

    if ($release.Sha256) {
      Say 'Verifying checksum.'
      $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $release.Sha256.ToLowerInvariant()) {
        Fail 'Verifying checksum' ("the downloaded file does not match the published checksum (expected {0}, got {1})" -f $release.Sha256.ToLowerInvariant(), $actual)
      }
    }

    try { Unblock-File -LiteralPath $zip } catch {}
    $extract = Join-Path $work 'extract'
    try {
      Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    } catch {
      Fail 'Unpacking' $_.Exception.Message
    }
    $built = Join-Path $extract $ExeName
    if (-not (Test-Path -LiteralPath $built)) { Fail 'Unpacking' ("{0} does not contain {1}" -f $AssetName, $ExeName) }
    try { Unblock-File -LiteralPath $built } catch {}

    Say ("Installing to {0}." -f $InstallDir)
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $target = Join-Path $InstallDir $ExeName
    # Old binaries left by earlier updates go first; one that is still running stays until next time.
    foreach ($old in Get-ChildItem -LiteralPath $InstallDir -Filter 'sparkcode.old*.exe' -ErrorAction SilentlyContinue) {
      try { Remove-Item -LiteralPath $old.FullName -Force } catch { Say ("The previous {0} is still in use and will be removed at the next install." -f $old.Name) }
    }
    try {
      Copy-Item -LiteralPath $built -Destination $staged -Force
    } catch {
      Fail 'Installing' ("could not write {0}: {1}" -f $staged, $_.Exception.Message)
    }
    if (Test-Path -LiteralPath $target) {
      $removed = $false
      try { Remove-Item -LiteralPath $target -Force; $removed = $true } catch {}
      if (-not $removed) {
        # A running executable cannot be deleted, but Windows lets it be renamed:
        # it steps aside under a free name and the new one takes its place.
        $aside = Join-Path $InstallDir $OldName
        $n = 1
        while (Test-Path -LiteralPath $aside) { $n++; $aside = Join-Path $InstallDir ("sparkcode.old.{0}.exe" -f $n) }
        Move-WithRetry $target $aside 'Installing'
        Say ("The running SparkCode was kept as {0} until you restart it." -f (Split-Path -Leaf $aside))
      }
    }
    Move-WithRetry $staged $target 'Installing'

    Add-ToUserPath $InstallDir
    if (-not (($env:Path -split ';') | Where-Object { $_ -and (Test-SamePath $_ $InstallDir) })) { $env:Path = "$env:Path;$InstallDir" }

    Say 'Done. Open a new terminal and run: sparkcode'
    Say 'If Windows shows a SmartScreen warning at the first start, choose More info, then Run anyway.'
  } finally {
    if (Test-Path -LiteralPath $staged) { try { Remove-Item -LiteralPath $staged -Force } catch {} }
    try { Remove-Item -LiteralPath $work -Recurse -Force } catch {}
  }
}

function Uninstall-SparkCode {
  Say ("SparkCode uninstaller. Removing {0}." -f $InstallDir)
  if (Test-Path -LiteralPath $InstallDir) {
    try {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force
    } catch {
      Fail 'Removing the program' ("could not remove {0}: {1}. Close SparkCode and try again" -f $InstallDir, $_.Exception.Message)
    }
  } else {
    Say ("{0} does not exist; nothing to remove." -f $InstallDir)
  }
  Remove-FromUserPath $InstallDir
  Say ("Done. Your sessions and configuration under {0} were kept." -f (Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }) '.config\opencode'))
}

$code = 0
try {
  if ($Uninstall) { Uninstall-SparkCode } else { Install-SparkCode }
} catch {
  Say ("Error: {0}." -f $_.Exception.Message.TrimEnd('.'))
  $code = 1
} finally {
  $ErrorActionPreference = $SavedErrorActionPreference
  $ProgressPreference = $SavedProgressPreference
}
if ($RunAsFile) { exit $code }
