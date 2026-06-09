param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# SwarmGCS dependency installer for Windows.
# It prepares Python packages and a portable Node.js runtime for this project.

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronDir = Join-Path $ProjectRoot "electron"
$RuntimeDir = Join-Path $PSScriptRoot "runtime"
$DownloadsDir = Join-Path $PSScriptRoot "downloads"
$NodeVersion = "v20.18.1"
$NodeFolder = "node-$NodeVersion-win-x64"
$NodeZip = Join-Path $DownloadsDir "$NodeFolder.zip"
$NodeDir = Join-Path $RuntimeDir $NodeFolder
$PortableNpm = Join-Path $NodeDir "npm.cmd"
$PythonInstaller = Join-Path $DownloadsDir "python-3.12.8-amd64.exe"

function Write-Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-Directory($Path) {
  if (!(Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Download-File($Url, $OutFile) {
  Ensure-Directory (Split-Path -Parent $OutFile)
  if (Test-Path $OutFile) {
    Write-Host "Using cached download: $OutFile"
    return
  }

  Write-Host "Downloading $Url"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Url -OutFile $OutFile
}

function Get-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    return @{ Exe = "py"; Args = @("-3") }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ Exe = "python"; Args = @() }
  }
  return $null
}

function Run-Python($Python, $Args) {
  & $Python.Exe @($Python.Args + $Args)
}

function Ensure-Python {
  Write-Step "Checking Python"
  $python = Get-PythonCommand
  if ($python) {
    Run-Python $python @("--version")
    return $python
  }

  Write-Host "Python was not found. Installing Python 3.12 for the current user..."
  Download-File "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe" $PythonInstaller
  Start-Process -FilePath $PythonInstaller -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1" -Wait

  $python = Get-PythonCommand
  if (!$python) {
    throw "Python installation finished, but Python is still not visible in PATH. Restart this terminal and run install_windows.bat again."
  }

  Run-Python $python @("--version")
  return $python
}

function Ensure-Node {
  Write-Step "Checking Node.js"
  if (Test-Path $PortableNpm) {
    Write-Host "Using portable Node.js: $NodeDir"
    return $PortableNpm
  }

  if (Get-Command npm -ErrorAction SilentlyContinue) {
    $npm = (Get-Command npm).Source
    Write-Host "Using system npm:"
    & $npm --version
    return $npm
  }

  Write-Host "Node.js was not found. Downloading portable Node.js $NodeVersion..."
  Ensure-Directory $RuntimeDir
  Download-File "https://nodejs.org/dist/$NodeVersion/$NodeFolder.zip" $NodeZip
  Expand-Archive -Path $NodeZip -DestinationPath $RuntimeDir -Force

  if (!(Test-Path $PortableNpm)) {
    throw "Portable Node.js install failed: $PortableNpm was not created."
  }

  & $PortableNpm --version
  return $PortableNpm
}

function Install-PythonPackages($Python) {
  Write-Step "Installing Python packages"
  $ReqFile = Join-Path $ProjectRoot "requirements.txt"
  Run-Python $Python @("-m", "pip", "install", "--upgrade", "pip")
  Run-Python $Python @("-m", "pip", "install", "-r", $ReqFile)
}

function Install-NodePackages($NpmCmd) {
  Write-Step "Installing Electron packages"
  Push-Location $ElectronDir
  try {
    & $NpmCmd install
  } finally {
    Pop-Location
  }
}

function Write-PortableLauncher($NpmCmd) {
  Write-Step "Creating portable launcher"
  $Launcher = Join-Path $ProjectRoot "Run_SwarmGCS_Portable.bat"
  $NodeBin = Split-Path -Parent $NpmCmd
  $Content = @"
@echo off
title SwarmGCS Portable Launcher
cd /d "%~dp0"
set "PATH=$NodeBin;%PATH%"
call Launch_SwarmGCS.bat
"@
  Set-Content -Path $Launcher -Value $Content -Encoding ASCII
  Write-Host "Created: $Launcher"
}

Ensure-Directory $RuntimeDir
Ensure-Directory $DownloadsDir

if ($DryRun) {
  Write-Step "Dry run validation"
  $RequiredFiles = @(
    (Join-Path $ProjectRoot "requirements.txt"),
    (Join-Path $ElectronDir "package.json"),
    (Join-Path $ProjectRoot "Launch_SwarmGCS.bat")
  )
  foreach ($file in $RequiredFiles) {
    if (!(Test-Path $file)) {
      throw "Missing required file: $file"
    }
    Write-Host "Found: $file"
  }
  Write-Host "Runtime directory: $RuntimeDir"
  Write-Host "Downloads directory: $DownloadsDir"
  Write-Host "Dry run OK. No downloads or installs were performed." -ForegroundColor Green
  exit 0
}

$python = Ensure-Python
$npmCmd = Ensure-Node
Install-PythonPackages $python
Install-NodePackages $npmCmd
Write-PortableLauncher $npmCmd

Write-Host ""
Write-Host "SwarmGCS requirements are ready." -ForegroundColor Green
Write-Host "Use Run_SwarmGCS_Portable.bat to start the app on this machine."
