# ============================================================================
# 一条命令发到 npm（含 2FA 验证码提示）
# ----------------------------------------------------------------------------
#   powershell -ExecutionPolicy Bypass -File tools\publish-npm.ps1
#
# 背景：本账号开了双重验证，npm publish 需要一次性验证码；若遇到
#   「account has been temporarily suspended due to a recent security-sensitive
#     action」→ 那是风控冷却（建 token / 改 2FA 之后常见），等 1 小时左右再跑。
# ============================================================================
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '[1/3] 跑自检（30 + 29 项断言）…' -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { throw '自检没过，已中止发布' }

Write-Host '[2/3] 检查 npm 登录状态…' -ForegroundColor Cyan
$who = (npm whoami 2>&1 | Select-Object -First 1)
if ($LASTEXITCODE -ne 0) {
  Write-Host '  未登录，先跑：npm login --auth-type=web' -ForegroundColor Yellow
  throw 'not logged in'
}
Write-Host "  已登录：$who" -ForegroundColor Green

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host "[3/3] 准备发布 $($pkg.name)@$($pkg.version)" -ForegroundColor Cyan
$otp = Read-Host '  验证器里的 6 位码（直接回车则不带验证码发布）'

if ([string]::IsNullOrWhiteSpace($otp)) {
  npm publish --access public
} else {
  npm publish --access public --otp=$otp
}

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n发布成功 ✅  https://www.npmjs.com/package/$($pkg.name)" -ForegroundColor Green
  Write-Host "别人现在可以直接：dsh plugin --profile web add $($pkg.name)"
} else {
  Write-Host "`n发布失败（见上面的 npm error）。常见两种：" -ForegroundColor Red
  Write-Host '  · 403 ... 需要 2FA → 重新跑本脚本并输入动态码'
  Write-Host '  · 403 ... temporarily suspended → 风控冷却，等 1 小时再试'
}
