# 创建桌面快捷方式「ZCode (soul)」：指向 VBS 隐藏启动器，使用 ZCode 图标
# 目录按脚本所在位置推导（项目整体移动后重跑即可），不写死绝对路径
$root = Split-Path -Parent $PSScriptRoot
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'ZCode (soul).lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $root 'zcode-soul.vbs'
$lnk.WorkingDirectory = $root
# 图标取 ZCode.exe：优先配置的 zcodePath（config.local.json 覆盖 config.json），
# 留空则探测常见安装位置，均未命中退回 wscript 图标
$configured = ''
$localConfig = Join-Path $root 'config.local.json'
if (Test-Path -LiteralPath $localConfig) {
    try { $configured = [string](Get-Content $localConfig -Raw | ConvertFrom-Json).zcodePath } catch {}
}
if (-not $configured) {
    try { $configured = [string](Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).zcodePath } catch {}
}
$zcodeExe = @($configured, "$env:LOCALAPPDATA\Programs\ZCode\ZCode.exe", "$env:ProgramFiles\ZCode\ZCode.exe") |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$lnk.IconLocation = if ($zcodeExe) { "$zcodeExe,0" } else { "$env:WINDIR\System32\wscript.exe,0" }
$lnk.Description = 'ZCode 增强启动器：带调试端口启动 ZCode 并自动注入扩展插件'
$lnk.Save()
Write-Output ("已创建: " + $lnkPath)
