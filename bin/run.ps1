param(
  [Parameter(Mandatory=$true)][ValidateSet('check-template','inspect','draft')][string]$Action,
  [string]$Folder
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
Set-Location -LiteralPath $project

if (-not $Folder) {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择含 product.txt 和 images 文件夹的商品模板'
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
  $Folder = $dialog.SelectedPath
}
if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { throw "模板文件夹不存在：$Folder" }

if ($Action -ne 'check-template') {
  & (Join-Path $PSScriptRoot 'start-edge.ps1')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $node (Join-Path $project 'src\cli.js') $Action $Folder
exit $LASTEXITCODE
