<#
.SYNOPSIS
    Bili-Live 上传功能自动测试脚本
    启动应用，监控收益记录是否成功上传到服务器

.DESCRIPTION
    两种模式：
    - dev 模式（默认）：使用 cargo tauri dev，同时启动开发服务器和 Tauri 窗口
    - prod 模式：使用已构建的 bili-live.exe + 独立服务器

    脚本会轮询 .data/uploads/ 目录，检测新上传的 pay-records.json，
    验证数据完整性，并输出测试报告。

.PARAMETER Mode
    "dev"（默认）: cargo tauri dev（快速，无需重建）
    "prod": 使用 bili-live.exe + npm start

.PARAMETER TimeoutSeconds
    等待上传的超时秒数，默认 180

.EXAMPLE
    .\scripts\test-upload.ps1
    .\scripts\test-upload.ps1 -Mode prod -TimeoutSeconds 300
#>

param(
    [ValidateSet("dev", "prod")]
    [string]$Mode = "dev",
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir\.."
$UploadsDir = "$ProjectRoot\.data\uploads"
$ExePath = "$ProjectRoot\src-tauri\target\release\bili-live.exe"
$ServerPort = 3000
$ServerUrl = "http://localhost:$ServerPort"

# ==================== 工具函数 ====================

function Write-Step($msg) { Write-Host "[$msg]" -ForegroundColor Yellow }
function Write-Ok($msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "  WARN  $msg" -ForegroundColor Magenta }
function Write-Info($msg) { Write-Host "  INFO  $msg" -ForegroundColor Gray }

function Wait-ForServer($url, $maxRetries = 60) {
    for ($i = 0; $i -lt $maxRetries; $i++) {
        try {
            $null = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 2 -UseBasicParsing
            return $true
        } catch {}
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-UploadSnapshot {
    $snapshot = @{}
    if (Test-Path $UploadsDir) {
        Get-ChildItem $UploadsDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $metaPath = Join-Path $_.FullName "_upload_meta.json"
            if (Test-Path $metaPath) {
                try {
                    $meta = Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    $snapshot[$meta.mid] = @{
                        uname = $meta.uname
                        lastUpload = $meta.last_upload
                        files = @($meta.files)
                    }
                } catch {}
            }
        }
    }
    return $snapshot
}

function Test-PayRecords($filePath) {
    try {
        $data = Get-Content $filePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $errors = @()

        if (-not $data.records) { $errors += "缺少 records 字段" }
        elseif ($data.records -isnot [array]) { $errors += "records 不是数组" }
        else {
            $count = $data.records.Count
            if ($data.totalRecords -and $count -ne $data.totalRecords) {
                $errors += "记录数不匹配: totalRecords=$($data.totalRecords) 实际=$count"
            }
            if ($count -gt 0) {
                $r = $data.records[0]
                foreach ($f in @("id", "gift_name", "gift_id", "coin", "timestamp", "ruid")) {
                    if (-not $r.$f) { $errors += "记录缺少字段: $f" }
                }
            }
        }

        if ($errors.Count -gt 0) {
            Write-Fail "pay-records.json 验证失败:"
            $errors | ForEach-Object { Write-Host "      $_" -ForegroundColor Red }
            return $false
        }
        return $true
    } catch {
        Write-Fail "pay-records.json 解析失败: $_"
        return $false
    }
}

# ==================== 主流程 ====================

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Bili-Live 上传功能测试" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  模式:     $Mode" -ForegroundColor Gray
Write-Host "  超时:     ${TimeoutSeconds}s" -ForegroundColor Gray
Write-Host "  项目:     $ProjectRoot" -ForegroundColor Gray
Write-Host "  上传目录: $UploadsDir" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ===== 1. 环境检查 =====
Write-Step "1/5 环境检查"

Push-Location $ProjectRoot

# 检查 Rust 环境
$rustOk = $false
try {
    $env:Path = "C:\Users\song\.cargo\bin;$env:Path"
    $rustVer = rustc --version 2>&1
    if ($LASTEXITCODE -eq 0) { $rustOk = $true; Write-Ok "Rust $rustVer" }
} catch {}
if (-not $rustOk) {
    Write-Fail "Rust 未安装，请先安装 https://rustup.rs/"
    Pop-Location; exit 1
}

# 检查 node_modules
if (-not (Test-Path "node_modules")) {
    Write-Fail "node_modules 不存在，请先运行 npm install"
    Pop-Location; exit 1
}
Write-Ok "node_modules 存在"

# 检查 EXE（prod 模式）
if ($Mode -eq "prod") {
    if (Test-Path $ExePath) {
        $info = Get-Item $ExePath
        Write-Ok "bili-live.exe: $([math]::Round($info.Length/1MB,1)) MB ($($info.LastWriteTime))"
    } else {
        Write-Fail "找不到 bili-live.exe，请先构建: cargo tauri build"
        Pop-Location; exit 1
    }
}

# ===== 2. 记录初始状态 =====
Write-Step "2/5 记录初始上传状态"
$before = Get-UploadSnapshot
Write-Info "已有 $($before.Count) 个用户的上传数据"
if ($before.Count -gt 0) {
    $before.GetEnumerator() | ForEach-Object {
        Write-Info "  UID $($_.Key): $($_.Value.uname) (上次: $($_.Value.lastUpload))"
    }
}

# ===== 3. 启动服务 =====
Write-Step "3/5 启动服务"

$serverProcess = $null
$appProcess = $null

if ($Mode -eq "dev") {
    # dev 模式: cargo tauri dev 同时启动 Next.js 和 Tauri 窗口
    Write-Info "启动 cargo tauri dev（开发服务器 + Tauri 窗口）..."
    Write-Host ""
    Write-Host "  +--------------------------------------------------+" -ForegroundColor DarkCyan
    Write-Host "  |  请在 Tauri 窗口中执行：                           |" -ForegroundColor DarkCyan
    Write-Host "  |  1. 登录 B站 账号                                  |" -ForegroundColor DarkCyan
    Write-Host "  |  2. 进入首页，点击「刷新数据」                      |" -ForegroundColor DarkCyan
    Write-Host "  |  3. 等待数据加载，应用会自动上传到服务器            |" -ForegroundColor DarkCyan
    Write-Host "  +--------------------------------------------------+" -ForegroundColor DarkCyan
    Write-Host ""

    # 设置环境变量让 Tauri app 知道上传到本地服务器
    $env:NEXT_PUBLIC_SERVER_URL = $ServerUrl

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cargo"
    $psi.Arguments = "tauri dev"
    $psi.WorkingDirectory = $ProjectRoot
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Environment["PATH"] = "C:\Users\song\.cargo\bin;$env:PATH"
    $psi.Environment["NEXT_PUBLIC_SERVER_URL"] = $ServerUrl

    $serverProcess = [System.Diagnostics.Process]::Start($psi)
    Write-Info "cargo tauri dev 已启动 (PID: $($serverProcess.Id))"
} else {
    # prod 模式: 独立启动 Next.js 服务器 + bili-live.exe
    Write-Info "启动 Next.js 服务器..."

    $serverProcess = Start-Process -FilePath "node" `
        -ArgumentList ".next\standalone\server.js" `
        -WorkingDirectory $ProjectRoot `
        -PassThru `
        -WindowStyle Hidden

    if (-not (Wait-ForServer $ServerUrl)) {
        Write-Fail "服务器启动超时"
        Stop-Process $serverProcess.Id -Force -ErrorAction SilentlyContinue
        Pop-Location; exit 1
    }
    Write-Ok "服务器运行中: $ServerUrl"

    Write-Info "启动 bili-live.exe..."
    $appProcess = Start-Process -FilePath $ExePath -PassThru
    Write-Info "应用 PID: $($appProcess.Id)"
}

# ===== 4. 等待服务器就绪（dev 模式需要等 Next.js 启动） =====
if ($Mode -eq "dev") {
    Write-Step "4/5 等待开发服务器就绪..."
    if (-not (Wait-ForServer $ServerUrl 90)) {
        Write-Fail "开发服务器启动超时"
        if ($serverProcess) { $serverProcess.Kill() }
        Pop-Location; exit 1
    }
    Write-Ok "开发服务器就绪: $ServerUrl"
} else {
    Write-Step "4/5 服务器已就绪"
}

# ===== 5. 监控上传 =====
Write-Step "5/5 监控上传（超时: ${TimeoutSeconds}s）"
Write-Host ""

$startTime = Get-Date
$uploadDetected = $false
$detectedUser = $null

do {
    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds)
    Write-Host "`r  等待中... ${elapsed}s / ${TimeoutSeconds}s" -NoNewline -ForegroundColor Gray

    $current = Get-UploadSnapshot

    # 检查新用户
    $newUsers = @($current.Keys | Where-Object { -not $before.ContainsKey($_) })
    if ($newUsers.Count -gt 0) {
        $uploadDetected = $true
        $detectedUser = $current[$newUsers[0]]
        $detectedUser | Add-Member -NotePropertyName mid -NotePropertyValue $newUsers[0]
        break
    }

    # 检查已有用户的新上传
    foreach ($mid in $current.Keys) {
        if ($before.ContainsKey($mid)) {
            $beforeTime = $before[$mid].lastUpload
            $currentTime = $current[$mid].lastUpload
            if ($currentTime -and $currentTime -gt $beforeTime) {
                $uploadDetected = $true
                $detectedUser = $current[$mid]
                $detectedUser | Add-Member -NotePropertyName mid -NotePropertyValue $mid
                break
            }
        }
    }
    if ($uploadDetected) { break }

    Start-Sleep -Seconds 3
} while ($elapsed -lt $TimeoutSeconds)

Write-Host ""
Write-Host ""

# ===== 结果输出 =====
if ($uploadDetected -and $detectedUser) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  检测到上传！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  用户:   $($detectedUser.uname)" -ForegroundColor White
    Write-Host "  UID:    $($detectedUser.mid)" -ForegroundColor White
    Write-Host "  时间:   $($detectedUser.lastUpload)" -ForegroundColor White
    Write-Host "  文件:   $($detectedUser.files -join ', ')" -ForegroundColor White
    Write-Host ""

    $safeName = $detectedUser.uname -replace '[\\/:*?"<>|]', '_'
    $userDir = "$UploadsDir\uid_$($detectedUser.mid)_$safeName"
    $allValid = $true

    Write-Host "--- 文件验证 ---" -ForegroundColor Yellow
    foreach ($fileName in $detectedUser.files) {
        $filePath = Join-Path $userDir $fileName
        if (-not (Test-Path $filePath)) {
            Write-Fail "$fileName - 文件不存在"
            $allValid = $false
            continue
        }

        $sizeKB = [math]::Round((Get-Item $filePath).Length / 1KB, 1)
        if ($fileName -eq "pay-records.json") {
            if (Test-PayRecords $filePath) {
                Write-Ok "$fileName ($sizeKB KB) - 数据完整性验证通过"
            } else {
                $allValid = $false
            }
        } else {
            Write-Ok "$fileName ($sizeKB KB) - 存在"
        }
    }
    Write-Host ""

    if ($allValid) {
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  测试通过！收益记录已成功上传到服务器" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        $exitCode = 0
    } else {
        Write-Host "========================================" -ForegroundColor Red
        Write-Host "  部分验证失败" -ForegroundColor Red
        Write-Host "========================================" -ForegroundColor Red
        $exitCode = 1
    }
} else {
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  测试超时：${TimeoutSeconds}s 内未检测到上传" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  可能原因:" -ForegroundColor Gray
    Write-Host "  1. 未在应用中登录 B站 账号" -ForegroundColor Gray
    Write-Host "  2. 未点击「刷新数据」按钮" -ForegroundColor Gray
    Write-Host "  3. B站 Cookie 已过期" -ForegroundColor Gray
    Write-Host "  4. 网络连接问题" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  当前上传目录: $UploadsDir" -ForegroundColor Gray
    $exitCode = 1
}

# ===== 清理 =====
Write-Host ""
Write-Host "--- 清理 ---" -ForegroundColor Yellow

if ($serverProcess) {
    Write-Info "停止服务进程 (PID: $($serverProcess.Id))..."
    try {
        $serverProcess.Kill()
        $serverProcess.WaitForExit(3000)
    } catch {}
}

if ($appProcess) {
    Write-Info "关闭应用 (PID: $($appProcess.Id))..."
    Stop-Process $appProcess.Id -Force -ErrorAction SilentlyContinue
}

# 确保 cargo tauri dev 的子进程也被清理
if ($Mode -eq "dev") {
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.MainWindowTitle -eq "" -and $_.StartTime -gt $startTime.AddMinutes(-1)
    } | Stop-Process -Force -ErrorAction SilentlyContinue
}

Pop-Location
Write-Ok "清理完成"
Write-Host ""

exit $exitCode