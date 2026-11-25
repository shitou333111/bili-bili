# 点歌机本地音乐控制 worker（常驻进程）
# 协议：stdin 每行一个 JSON 请求；stdout 每行一个**单行** JSON 响应；日志一律走 stderr。
# 请求：
#   {"cmd":"state","platform":"kugou|qq|netease|soda"}
#   {"cmd":"play","platform":"kugou|qq|netease|soda","song_id":"...","mode":"replace|next"}
#         mode=next：插到「下一首播放」（目前仅网易云 + 已开启 CDP 调试端口时可用）
#   {"cmd":"restart","platform":"netease"}
#         带调试端口重启网易云（会中断当前播放）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File music_worker.ps1
$ErrorActionPreference = 'Continue'

# ---------- 编码：stdout 固定 UTF-8（并显式用 StreamWriter，避免宿主编码污染） ----------
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$script:StdOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$script:StdOut.AutoFlush = $true
$script:StdErr = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), (New-Object System.Text.UTF8Encoding($false)))
$script:StdErr.AutoFlush = $true

function Write-Log([string]$msg) {
    # 绝不能用 Write-Host / Write-Output：在重定向场景它们会污染 stdout 的 JSON 行。
    try { $script:StdErr.WriteLine("[music-worker] $msg") } catch {}
}

function Write-Resp($obj) {
    try {
        if ($null -eq $obj) { $obj = [ordered]@{ ok = $false; error = 'empty response' } }
        $script:StdOut.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    } catch {
        try { $script:StdOut.WriteLine('{"ok":false,"error":"encode response failed"}') } catch {}
    }
}

function New-StateResp([string]$platform, [string]$source) {
    [ordered]@{
        ok       = $true
        platform = $platform
        playing  = $false
        status   = 'Stopped'
        title    = ''
        artist   = ''
        position = -1
        duration = -1
        source   = $source
    }
}

# ==================== 酷狗：WorkBuddy 本地 HTTP ====================
$script:KugouHandshakePath = Join-Path $env:USERPROFILE '.config\kugou-cli\handshake.json'

function Get-KugouHandshake([switch]$Force, [int]$WaitMs = 5000) {
    if (-not $Force -and (Test-Path $script:KugouHandshakePath)) {
        try {
            $hs = Get-Content $script:KugouHandshakePath -Raw | ConvertFrom-Json
            if ($hs.addr -and $hs.token) { return $hs }
        } catch {}
    }
    # 握手失效：走 kugou://workbuddy 协议让客户端重新写握手文件（客户端没开时协议处理器会顺带拉起）
    Remove-Item $script:KugouHandshakePath -Force -ErrorAction SilentlyContinue
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path $script:KugouHandshakePath) | Out-Null
        $payload = @{ out = $script:KugouHandshakePath; session = "kugou-cli-$PID"; silent = $true } | ConvertTo-Json -Compress
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
        $cmdline = 'rundll32.exe url.dll,FileProtocolHandler "kugou://workbuddy/?p=' + $b64 + '"'
        $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
    } catch { Write-Log "kugou handshake 触发失败: $($_.Exception.Message)" }
    $rounds = [math]::Max(1, [math]::Ceiling($WaitMs / 500))
    for ($i = 0; $i -lt $rounds; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $script:KugouHandshakePath) {
            try {
                $hs = Get-Content $script:KugouHandshakePath -Raw | ConvertFrom-Json
                if ($hs.addr -and $hs.token) { return $hs }
            } catch {}
        }
    }
    Write-Log 'kugou 握手超时'
    return $null
}

# 酷狗进程是否在运行（不同版本进程名可能是 KuGou / KGMusic）
function Test-KugouRunning {
    $procs = Get-Process -Name KuGou, KGMusic -ErrorAction SilentlyContinue
    return [bool]$procs
}

# 客户端未启动时统一行为：先拉起酷狗（协议拉起，失败再直接启动 exe），再等它可用
function Ensure-KugouRunning([int]$WaitMs = 12000) {
    if (Test-KugouRunning) { return $true }
    Write-Log 'kugou 未运行，尝试启动客户端'
    try {
        $cmdline = 'rundll32.exe url.dll,FileProtocolHandler "kugou://workbuddy/"'
        $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
    } catch { Write-Log "kugou 协议拉起失败: $($_.Exception.Message)" }

    $candidates = @()
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'KuGou\KGMusic\KuGou.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'KuGou\KGMusic\KuGou.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'KuGou\KGMusic\KuGou.exe') }

    $triedExe = $false
    $rounds = [math]::Max(1, [math]::Ceiling($WaitMs / 500))
    for ($i = 0; $i -lt $rounds; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-KugouRunning) { Write-Log 'kugou 已启动'; return $true }
        # 协议 3 秒还没拉起 → 直接按安装路径启动
        if (-not $triedExe -and $i -ge 6) {
            $triedExe = $true
            $started = $false
            foreach ($exe in $candidates) {
                if (-not (Test-Path $exe)) { continue }
                try {
                    $cmdline = '"' + $exe + '"'
                    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
                    if ($null -eq $r.ReturnValue -or $r.ReturnValue -eq 0) { Write-Log "kugou 直接启动: $exe"; $started = $true; break }
                } catch { Write-Log "kugou exe 启动失败: $($_.Exception.Message)" }
            }
            # 协议没拉起、本机也找不到安装路径 → 判定未安装，不再干等
            if (-not $started -and -not ($candidates | Where-Object { Test-Path $_ })) {
                Write-Log 'kugou 未安装'
                return $false
            }
        }
    }
    return (Test-KugouRunning)
}

function Invoke-KugouOnce($hs, [string]$Path, $BodyBytes) {
    $headers = @{ Authorization = "Bearer $($hs.token)" }
    if ($null -ne $BodyBytes) {
        $headers['Content-Type'] = 'application/json; charset=utf-8'
        return Invoke-RestMethod -Uri "http://$($hs.addr)$Path" -Method Post -Headers $headers -Body $BodyBytes -TimeoutSec 6
    }
    return Invoke-RestMethod -Uri "http://$($hs.addr)$Path" -Headers $headers -TimeoutSec 6
}

function Invoke-KugouApi([string]$Path, $BodyObj, [switch]$RetryHandshakeOnError) {
    $bodyBytes = $null
    if ($null -ne $BodyObj) { $bodyBytes = [Text.Encoding]::UTF8.GetBytes(($BodyObj | ConvertTo-Json -Compress)) }
    $hs = Get-KugouHandshake
    if (-not $hs) { return $null }
    try {
        return Invoke-KugouOnce $hs $Path $bodyBytes
    } catch {
        $first = $_.Exception.Message
        # 读状态：仅鉴权类失败才重新握手（连接被拒 = 客户端没开，不该在读状态时误拉启动）
        # 播放：连接类失败重试一次；超时/中断可能「已经执行成功」，重放会让酷狗重复加歌
        $ambiguous = $first -match '超时|timed out|timeout|abort|取消'
        if (($RetryHandshakeOnError -and -not $ambiguous) -or $first -match '401|403|Unauthorized|Forbidden') {
            Write-Log "kugou 握手失效，重新握手: $first"
            $hs = Get-KugouHandshake -Force
            if (-not $hs) { return $null }
            try { return Invoke-KugouOnce $hs $Path $bodyBytes } catch { Write-Log "kugou 请求失败: $($_.Exception.Message)"; return $null }
        }
        Write-Log "kugou 请求失败: $first"
        return $null
    }
}

function Get-KugouState {
    $resp = New-StateResp 'kugou' 'http'
    $r = Invoke-KugouApi '/v1/player/current' $null
    $d = $null
    if ($null -ne $r -and $null -ne $r.code -and $r.code -eq 0) { $d = $r.data }

    if ($null -eq $d) {
        # HTTP 不可用：只有 SMTC 仍有会话时才如实上报状态，否则按「已停止」返回默认值
        $smtcStatus = Get-SmtcPlaybackStatus '^kugou'
        if (-not $smtcStatus) { return $resp }
        $resp['status'] = $smtcStatus
        $resp['playing'] = ($smtcStatus -eq 'Playing')
        $resp['source'] = 'smtc'
        return $resp
    }

    $hasSong = [bool]$d.has_song
    $stopped = [bool]$d.stopped
    if (-not $hasSong) { return $resp }   # 无歌 = 已停止
    if (-not $stopped) {
        $resp['playing'] = $true
        $resp['status'] = 'Playing'
    } else {
        # 酷狗 HTTP 只有一个 stopped 布尔值，分不清「暂停」和「停止」。
        # 酷狗同时注册了 SMTC（AUMID=kugou），用它的 PlaybackStatus 判定；
        # 拿不到时按「暂停」保守处理——宁可等，也不打断主播。
        $smtcStatus = Get-SmtcPlaybackStatus '^kugou'
        if ($smtcStatus -eq 'Playing') {
            $resp['playing'] = $true
            $resp['status'] = 'Playing'
        } elseif ($smtcStatus -eq 'Stopped' -or $smtcStatus -eq 'Closed') {
            $resp['status'] = 'Stopped'
        } else {
            $resp['status'] = 'Paused'
        }
    }
    if ($d.song) {
        if ($d.song.song_name) { $resp['title'] = [string]$d.song.song_name }
        if ($d.song.singer_name) { $resp['artist'] = [string]$d.song.singer_name }
    }
    if ($null -ne $d.position_ms -and [double]$d.position_ms -ge 0) {
        $resp['position'] = [math]::Round([double]$d.position_ms / 1000.0, 1)
    }
    if ($null -ne $d.duration_ms -and [double]$d.duration_ms -gt 0) {
        $resp['duration'] = [math]::Round([double]$d.duration_ms / 1000.0, 1)
    }
    return $resp
}

# ==================== SMTC（QQ 音乐 / 网易云 / 酷狗） ====================
$script:SmtcReady = $false
$script:AsTaskGeneric = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
    $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    # PowerShell 对象调 IAsyncOperation.GetResults 不可靠，统一转成 Task 再 Wait（同 probe-media.ps1）
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    if ($null -ne $script:AsTaskGeneric) { $script:SmtcReady = $true }
} catch { Write-Log "SMTC 初始化失败: $($_.Exception.Message)" }

function Await($op, $type) {
    $t = $script:AsTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
}

function Get-SmtcSession([string]$match) {
    if (-not $script:SmtcReady) { return $null }
    try {
        $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    } catch { Write-Log "SMTC RequestAsync 失败: $($_.Exception.Message)"; return $null }
    if ($null -eq $mgr) { return $null }
    try {
        $sessions = $mgr.GetSessions()
        if (-not $sessions) { return $null }
        return ($sessions | Where-Object { $_.SourceAppUserModelId -match $match } | Select-Object -First 1)
    } catch { Write-Log "SMTC GetSessions 失败: $($_.Exception.Message)"; return $null }
}

function Get-SmtcState([string]$platform, [string]$match) {
    $resp = New-StateResp $platform 'smtc'
    $s = Get-SmtcSession $match
    if ($null -eq $s) { return $resp }

    $props = $null
    try {
        $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    } catch {}
    $info = $null
    try { $info = $s.GetPlaybackInfo() } catch {}
    $tl = $null
    try { $tl = $s.GetTimelineProperties() } catch {}

    if ($null -ne $info) {
        $status = [string]$info.PlaybackStatus
        if ($status) {
            $resp['status'] = $status
            $resp['playing'] = ($status -eq 'Playing')
        }
    }
    if ($null -ne $props) {
        if ($props.Title) { $resp['title'] = [string]$props.Title }
        if ($props.Artist) { $resp['artist'] = [string]$props.Artist }
    }
    if ($null -ne $tl) {
        $pos = [double]$tl.Position.TotalSeconds
        $end = [double]$tl.EndTime.TotalSeconds
        # 网易云常给 0，约定拿不到就用 -1
        if ($pos -gt 0) { $resp['position'] = [math]::Round($pos, 1) }
        if ($end -gt 0) { $resp['duration'] = [math]::Round($end, 1) }
    }
    return $resp
}

function Get-SmtcPlaybackStatus([string]$match) {
    # 返回 SMTC 的 PlaybackStatus（Playing/Paused/Stopped/Closed…）；无会话时返回 $null。
    # 注意不能用 Get-SmtcState 代替：它在无会话时也会返回默认的 'Stopped'，无法区分「没开播放器」和「真停止」。
    $s = Get-SmtcSession $match
    if ($null -eq $s) { return $null }
    try {
        $info = $s.GetPlaybackInfo()
        if ($null -ne $info -and $info.PlaybackStatus) { return [string]$info.PlaybackStatus }
    } catch {}
    return $null
}

# ==================== 汽水音乐（SMTC 状态） ====================
# 汽水 PC 端注册的 SMTC AUMID 是中文「汽水音乐」。
# 关键差异：汽水的 SMTC 时间线只在开始/跳转时上报一次，Position 会一直停在起点，
# 不能当播放进度用；但 LastUpdatedTime 记录了那次上报的真实时刻，
# 用「LastUpdatedTime - Position」可还原本曲真正的开始时间，队列据此做结束前预判。
function Get-SodaState {
    $st = Get-SmtcState 'soda' '汽水音乐'
    $s = Get-SmtcSession '汽水音乐'
    if ($null -eq $s) { return $st }
    try {
        $tl = $s.GetTimelineProperties()
        $pos = [double]$tl.Position.TotalSeconds
        $end = [double]$tl.EndTime.TotalSeconds
        $lu = $tl.LastUpdatedTime
        if ($end -gt 0 -and $lu.Year -ge 2000) {
            $start = $lu.AddSeconds(-$pos)
            $startMs = [long]$start.ToUnixTimeMilliseconds()
            $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            if ($startMs -gt 0 -and $startMs -le $nowMs + 1000) { $st['startedAt'] = $startMs }
            $st['duration'] = [math]::Round($end, 1)
        }
    } catch { Write-Log "soda 时间线读取失败: $($_.Exception.Message)" }
    # Position 是固定值，继续上报会让队列误判剩余时长 → 去掉，交给队列用
    # startedAt + duration 自己倒计时（暂停时长由队列补偿）
    $st.Remove('position')
    return $st
}

# ==================== 网易云 CDP（精确进度 + 插播下一首） ====================
# 网易云桌面端是 Electron 应用：带 --remote-debugging-port 启动时，可以从本机
# 调试端口进页面读 Redux store / DOM。比 orpheus 协议强的地方有两点：
#   1) 能读到精确播放进度（播放条里隐藏的 input[type=range] 的 value 就是秒数）；
#   2) 能派发 addToPlayList，把歌插到「下一首播放」——不打断当前曲，
#      播完继续主播原来的播放列表（orpheus 点播是 replace 语义，会劫持列表）。
# 调试端口只能由启动参数开启，所以这里全部是「有就用、没有就退化」的可选增强。
$script:CdpPorts = @(9229, 9222)
try {
    $envCdpPort = [int]$env:BILI_MUSIC_CDP_PORT
    if ($envCdpPort -gt 0) { $script:CdpPorts = @($envCdpPort) }
} catch {}
# 连不上后冷却 5 秒，避免每次轮询都空等连接超时
$script:CdpFailUntil = 0

# 从 React fiber 树里把 Redux store 捞出来（网易云桌面端没有对外 IPC）。
# 页面重载后 window._reduxStore 会失效，所以每次都先确认一遍。
$script:CDP_STORE_JS = @'
function _ensureStore(){if(window._reduxStore)return true;try{var rootEl=document.querySelector('#root');var root=window._fiberRoot||(rootEl&&rootEl._reactRootContainer&&rootEl._reactRootContainer._internalRoot);if(!root&&rootEl){var rk=Object.keys(rootEl).find(function(k){return k.indexOf('__reactContainer')===0||k.indexOf('__reactFiber')===0;});if(rk){var holder=rootEl[rk];root=(holder&&(holder._reactRootContainer||holder))||null;if(root&&root._internalRoot)root=root._internalRoot;}}if(!root)return false;var queue=[root.current||root];var visited=0;var cand=null;while(queue.length>0){var node=queue.shift();if(!node)continue;visited++;if(visited>40000)break;var st=null;if(node.memoizedProps&&node.memoizedProps.store)st=node.memoizedProps.store;else if(node.pendingProps&&node.pendingProps.store)st=node.pendingProps.store;else if(node.stateNode&&node.stateNode.store)st=node.stateNode.store;if(st){try{var g=st.getState();if(g&&g.playing&&Object.keys(g.playing).length>0){window._reduxStore=st;return true;}}catch(e){}if(!cand)cand=st;}var child=node.child;while(child){queue.push(child);child=child.sibling;}}if(cand){window._reduxStore=cand;return true;}}catch(e){return false;}return false;}
'@

# 读当前曲目 + 精确进度 + 「下一首」是谁（用来判断插播是否还占着位置）
$script:CDP_STATE_JS = @'
(function(){
__STORE__
if(!_ensureStore())return null;
var s=window._reduxStore.getState();
var pl=s.playing||{};
var id=String(pl.resourceTrackId||pl.onlineResourceId||'');
var name=String(pl.resourceName||'');
var artists='';
var ar=pl.resourceArtists;
if(ar){if(!Array.isArray(ar))ar=[ar];artists=ar.map(function(a){return typeof a==='string'?a:((a&&a.name)||'');}).filter(Boolean).join('/');}
var dur=Number(pl.resourceDuration||0)||0;
var ps=Number(pl.playingState);
if(!isFinite(ps))ps=-1;
var pos=-1;
var slider=document.querySelector('[aria-label="播放进度调节"]');
if(slider){
  var inp=slider.querySelector('input[type=range]');
  if(inp){
    var p=parseFloat(inp.value),d=parseFloat(inp.max);
    if(isFinite(p)&&isFinite(d)&&d>0){pos=p;if(dur<=0)dur=d;}
  }
}
// 新版客户端播放条选择器可能变了：退回到页面上「时长最长」的 range（就是播放进度条）
if(pos<0||dur<=0){
  var ranges=document.querySelectorAll('input[type=range]');
  for(var k=0;k<ranges.length;k++){
    var rp=parseFloat(ranges[k].value),rd=parseFloat(ranges[k].max);
    if(isFinite(rp)&&isFinite(rd)&&rd>30){pos=rp;if(dur<=0)dur=rd;break;}
  }
}
var nextId='';
var curItem=null;
var cp=(s.playingList||{}).curPlayingList;
if(cp&&cp.length){
  for(var i=0;i<cp.length;i++){
    if(String(cp[i]&&cp[i].id)===id){curItem=cp[i];if(cp[i+1])nextId=String(cp[i+1].id||'');break;}
  }
}
// 播放条结构变化时拿不到 duration：退回当前曲目自身的时长（毫秒）
if(dur<=0&&curItem){var _d=Number(curItem.duration||0)||0;if(_d>0)dur=_d>10000?_d/1000:_d;}
if(dur<0)dur=0;
return {id:id,name:name,artists:artists,duration:dur,position:pos,nextId:nextId,playingState:ps};
})()
'@

# 插播：addToPlayList = 客户端自己的「下一首播放」
$script:CDP_INSERT_JS = @'
(function(){
__STORE__
if(!_ensureStore())return false;
try{
  window._reduxStore.dispatch({type:'async:action/doAction',payload:{actionId:'addToPlayList',data:{resource:{id:'__ID__',duration:0},resourceType:'track',eventType:'click'}}});
  return true;
}catch(e){return false;}
})()
'@

function Get-CdpTargetUrls {
    foreach ($port in $script:CdpPorts) {
        try {
            $list = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2 -UseBasicParsing
        } catch { continue }
        if ($null -eq $list) { continue }
        $pages = @($list | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl })
        if ($pages.Count -eq 0) { continue }
        # 注意：PowerShell 的 -match 默认忽略大小写，"subApp.html" 也会命中 'app.html'，
        # 必须用 -cmatch + 路径分隔符，否则会连到「桌面宠物」子窗口（那里没有播放器状态）。
        # 主播放器页排在最前，其余非宠物页面依次兜底：客户端长时间闲置后主窗口的
        # 渲染进程可能被重建（target id 变化），按顺序逐个尝试比只认第一个更可靠。
        $main = @($pages | Where-Object { [string]$_.url -cmatch '/app\.html' })
        $rest = @($pages | Where-Object { [string]$_.url -cnotmatch '/subApp\.html' -and [string]$_.url -cnotmatch '/app\.html' })
        $urls = @()
        foreach ($p in ($main + $rest)) { $urls += [string]$p.webSocketDebuggerUrl }
        if ($urls.Count -gt 0) { return $urls }
    }
    return @()
}

function Invoke-CdpEval([string]$Expression, [int]$TimeoutMs = 3000) {
    foreach ($wsUrl in (Get-CdpTargetUrls)) {
        $v = Invoke-CdpEvalOn $wsUrl $Expression $TimeoutMs
        if ($null -ne $v) { return $v }
    }
    return $null
}

function Invoke-CdpEvalOn([string]$wsUrl, [string]$Expression, [int]$TimeoutMs = 3000) {
    $ws = $null
    try {
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $ct = [System.Threading.CancellationToken]::None
        $t = $ws.ConnectAsync([Uri]$wsUrl, $ct)
        if (-not $t.Wait($TimeoutMs)) { throw 'connect timeout' }
        $payload = [ordered]@{
            id     = 1
            method = 'Runtime.evaluate'
            params = [ordered]@{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
        } | ConvertTo-Json -Compress -Depth 8
        $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
        $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
        $s = $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct)
        if (-not $s.Wait($TimeoutMs)) { throw 'send timeout' }
        $buf = New-Object byte[] 262144
        $ms = New-Object System.IO.MemoryStream
        while ($true) {
            $rseg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
            $rt = $ws.ReceiveAsync($rseg, $ct)
            if (-not $rt.Wait($TimeoutMs)) { throw 'recv timeout' }
            $res = $rt.Result
            if ($res.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { throw 'closed' }
            $ms.Write($buf, 0, $res.Count)
            if ($res.EndOfMessage) { break }
        }
        $obj = ([Text.Encoding]::UTF8.GetString($ms.ToArray())) | ConvertFrom-Json
        if ($null -ne $obj.result.exceptionDetails) { throw ('js: ' + $obj.result.exceptionDetails.text) }
        return $obj.result.result.value
    } catch {
        Write-Log "cdp: $($_.Exception.Message)"
        return $null
    } finally {
        if ($null -ne $ws) { try { $ws.Dispose() } catch {} }
    }
}

function Get-CdpNeteaseState {
    if ([Environment]::TickCount -lt $script:CdpFailUntil) { return $null }
    $v = Invoke-CdpEval ($script:CDP_STATE_JS.Replace('__STORE__', $script:CDP_STORE_JS))
    if ($null -eq $v) {
        $script:CdpFailUntil = [Environment]::TickCount + 5000
        return $null
    }
    $script:CdpFailUntil = 0
    return $v
}

function Invoke-CdpNeteaseInsertNext([string]$songId) {
    if ($songId -notmatch '^\d+$') {
        return [ordered]@{ ok = $false; error = 'netease 插播需要数字歌曲 id' }
    }
    $js = $script:CDP_INSERT_JS.Replace('__STORE__', $script:CDP_STORE_JS).Replace('__ID__', $songId)
    $v = Invoke-CdpEval $js
    if ($null -eq $v) { return [ordered]@{ ok = $false; error = 'cdp-unavailable' } }
    if ($v -eq $true) { return [ordered]@{ ok = $true; mode = 'next' } }
    return [ordered]@{ ok = $false; error = 'netease-cdp-unsupported' }
}

# 网易云最终状态：CDP 负责播放状态 / id / 精确进度 / 下一首，SMTC 只做兜底
function Get-NeteaseState {
    $resp = Get-SmtcState 'netease' 'cloudmusic|CloudMusic|netease'
    $c = Get-CdpNeteaseState
    if ($null -eq $c) { return $resp }
    # CDP 能拿到 store 就说明调试端口可用、具备「插播下一首」能力。
    # 当前没有曲目时 id 为空，也必须如实上报——否则启动自检会把「空闲」误判成「未开启端口」。
    $resp['insertNext'] = $true
    $resp['source'] = 'cdp'
    $cdpId = [string]$c.id
    if (-not $cdpId) { return $resp }
    $resp['id'] = $cdpId
    # SMTC 不可靠：实测音乐在播（进度在推进）时它仍报 Stopped，导致点歌被判成「没在放」
    # 而直接顶掉当前曲。有 CDP 时以客户端自己的 playingState 为准（2 = 播放中）。
    $ps = -1
    if ($null -ne $c.playingState) { try { $ps = [int]$c.playingState } catch {} }
    if ($ps -ge 0) {
        $resp['playing'] = ($ps -eq 2)
        $resp['status'] = if ($ps -eq 2) { 'Playing' } else { 'Paused' }
    }
    if (-not $resp['title'] -and $c.name) { $resp['title'] = [string]$c.name }
    if (-not $resp['artist'] -and $c.artists) { $resp['artist'] = [string]$c.artists }
    if ($null -ne $c.duration -and [double]$c.duration -gt 0) {
        $resp['duration'] = [math]::Round([double]$c.duration, 1)
    }
    if ($null -ne $c.position -and [double]$c.position -ge 0) {
        $resp['position'] = [math]::Round([double]$c.position, 1)
    }
    if ($c.nextId) { $resp['nextId'] = [string]$c.nextId }
    return $resp
}

# ==================== 网易云：带调试端口重启 ====================
# 找客户端路径：优先 orpheus 协议注册的命令行，再退回运行中进程与默认安装路径
function Get-NeteaseExe {
    $candidates = @()
    foreach ($k in @('Registry::HKEY_CLASSES_ROOT\orpheus\shell\open\command', 'HKLM:\SOFTWARE\Classes\orpheus\shell\open\command')) {
        try {
            $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
            if ($v) {
                $m = [regex]::Match([string]$v, '"([^"]+\.exe)"')
                if ($m.Success) { $candidates += $m.Groups[1].Value }
            }
        } catch {}
    }
    try { $candidates += (Get-Process cloudmusic -ErrorAction Stop | Select-Object -First 1).Path } catch {}
    $candidates += 'C:\Program Files\NetEase\CloudMusic\cloudmusic.exe'
    $candidates += 'C:\Program Files (x86)\NetEase\CloudMusic\cloudmusic.exe'
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Test-PortOpen([int]$Port) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($iar) | Out-Null
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { $client.Close() }
    }
}

function Invoke-NeteaseRestart {
    $port = [int]$script:CdpPorts[0]
    # 端口已经开着就不动它，避免白打断播放
    if (Test-PortOpen $port) { return [ordered]@{ ok = $true; already = $true; port = $port } }

    $exe = Get-NeteaseExe
    if (-not $exe) { return [ordered]@{ ok = $false; error = '未找到网易云客户端（cloudmusic.exe）' } }

    $procs = @(Get-Process cloudmusic -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        Write-Log "netease 重启：关闭 $($procs.Count) 个进程"
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 400
            if (-not (Get-Process cloudmusic -ErrorAction SilentlyContinue)) { break }
        }
        # 单实例锁释放有延迟，过早启动新进程会直接退出
        Start-Sleep -Milliseconds 800
    }

    $cmdline = '"' + $exe + '" --remote-debugging-port=' + $port
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
    } catch {
        return [ordered]@{ ok = $false; error = "启动网易云失败: $($_.Exception.Message)" }
    }
    if ($null -ne $r.ReturnValue -and $r.ReturnValue -ne 0) {
        return [ordered]@{ ok = $false; error = "启动网易云失败: ReturnValue=$($r.ReturnValue)" }
    }

    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-PortOpen $port) {
            # 清掉 CDP 失败冷却，下一次轮询立即生效
            $script:CdpFailUntil = 0
            return [ordered]@{ ok = $true; port = $port; pid = [int]$r.ProcessId }
        }
        if (-not (Get-Process cloudmusic -ErrorAction SilentlyContinue)) {
            return [ordered]@{ ok = $false; error = '网易云启动后立即退出（可能被安全软件拦截，或端口被占用）' }
        }
    }
    return [ordered]@{ ok = $false; error = "网易云已启动，但 $port 端口未就绪" }
}

# ==================== 播放 ====================
function Invoke-PlayKugou([string]$songId) {
    if (-not $songId) { return [ordered]@{ ok = $false; error = 'kugou 需要 song_id（mixsongid）' } }

    # 统一行为：客户端没开时先拉起酷狗，再播放（与网易云/QQ/汽水保持一致）
    $launched = $false
    if (-not (Test-KugouRunning)) {
        if (-not (Ensure-KugouRunning)) {
            return [ordered]@{ ok = $false; error = 'kugou 未安装或无法启动' }
        }
        $launched = $true
    }
    # 冷启动时握手文件要等客户端加载完才写入，这里给足等待
    $hs = Get-KugouHandshake
    if ($launched -or -not $hs) { $hs = Get-KugouHandshake -Force -WaitMs 20000 }
    if (-not $hs) { return [ordered]@{ ok = $false; error = 'kugou 握手失败（客户端未就绪）' } }

    # 已经在播同一首 → 直接成功。避免上层重试/连点被当成新歌再次加入播放列表（重复添加）
    $cur = Invoke-KugouApi '/v1/player/current' $null
    if ($cur -and $cur.code -eq 0 -and $cur.data -and $cur.data.has_song -and (-not $cur.data.stopped) -and $cur.data.song -and ([string]$cur.data.song.mixsongid) -eq [string]$songId) {
        return [ordered]@{ ok = $true; already = $true }
    }

    $body = [ordered]@{ mix_song_id = [string]$songId }
    $r = Invoke-KugouApi '/v1/player/play' $body -RetryHandshakeOnError
    if ($null -eq $r) { return [ordered]@{ ok = $false; error = 'kugou 播放失败（客户端未运行或握手失效）' } }
    if ($null -ne $r.code -and $r.code -ne 0) {
        return [ordered]@{ ok = $false; error = "kugou code=$($r.code)" }
    }

    # 客户端刚被拉起时指令可能被吞：只在「完全没有歌曲」时补发一次；已有歌就不补，避免重复入列
    # 冷启动加载较慢，最多观察 8 秒（一旦看到歌曲立即结束等待）
    $hasSong = $false
    for ($i = 0; $i -lt 16; $i++) {
        Start-Sleep -Milliseconds 500
        $after = Invoke-KugouApi '/v1/player/current' $null
        if ($after -and $after.code -eq 0 -and $after.data -and $after.data.has_song) { $hasSong = $true; break }
    }
    if (-not $hasSong) {
        Write-Log 'kugou 播放未生效，补发一次'
        $r2 = Invoke-KugouApi '/v1/player/play' $body
        if ($null -eq $r2 -or ($null -ne $r2.code -and $r2.code -ne 0)) {
            return [ordered]@{ ok = $false; error = 'kugou 播放未生效' }
        }
    }
    return [ordered]@{ ok = $true }
}

function Invoke-PlayQq([string]$songId) {
    if ($songId -notmatch '^\d+$') { return [ordered]@{ ok = $false; error = 'qq 歌曲 id 无效（需要十进制 songid）' } }
    $exe = 'C:\Program Files (x86)\Tencent\QQMusic\QQMusic.exe'
    if (-not (Test-Path $exe)) { $exe = 'C:\Program Files\Tencent\QQMusic\QQMusic.exe' }
    if (-not (Test-Path $exe)) { return [ordered]@{ ok = $false; error = '未找到 QQMusic.exe' } }
    $arg = 'cmd_count==1&&id_0==' + $songId + '&&songtype_0==0'
    $cmdline = '"' + $exe + '" /playbysongid "' + $arg + '"'
    # 用 Win32_Process Create：Start-Process 起的子进程会随 worker 生命周期被牵连
    try {
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
    } catch { return [ordered]@{ ok = $false; error = "qq 启动失败: $($_.Exception.Message)" } }
    if ($null -ne $r.ReturnValue -and $r.ReturnValue -ne 0) {
        return [ordered]@{ ok = $false; error = "qq Create ReturnValue=$($r.ReturnValue)" }
    }
    return [ordered]@{ ok = $true }
}

function Invoke-PlayNetease([string]$songId) {
    if (-not $songId) { return [ordered]@{ ok = $false; error = 'netease 需要 song_id' } }
    # 协议未注册说明没装网易云：明确报错，避免"命令成功但什么都没发生"
    if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\orpheus')) {
        return [ordered]@{ ok = $false; error = '未检测到网易云音乐（orpheus 协议未注册）' }
    }
    $json = '{"type":"song","id":"' + $songId + '","cmd":"play"}'
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $uri = 'orpheus://' + $b64
    $firstErr = ''
    # 用 rundll32 转 ShellExecute：它是 GUI 子系统，不会像 cmd /c start 那样闪黑框；
    # WMI 被禁用时退回 Start-Process（同样走 ShellExecute，也无控制台）。
    try {
        $cmdline = 'rundll32.exe url.dll,FileProtocolHandler "' + $uri + '"'
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
        if ($null -eq $r.ReturnValue -or $r.ReturnValue -eq 0) { return [ordered]@{ ok = $true } }
        $firstErr = "Create ReturnValue=$($r.ReturnValue)"
    } catch { $firstErr = $_.Exception.Message }
    try {
        Start-Process $uri
        return [ordered]@{ ok = $true }
    } catch {
        return [ordered]@{ ok = $false; error = "netease 启动失败: $firstErr | $($_.Exception.Message)" }
    }
}

# ==================== 汽水音乐：luna:// deeplink ====================
# 汽水 PC 端是 Electron 应用，生产环境对 --remote-debugging-port / --inspect 会主动
# process.crash()，所以 CDP 走不通。可用的官方入口是自定义协议 luna://：
#   luna://luna.com/playing?track_id=<track_id>&media_type=track
# 客户端已运行时 → second-instance → handleDeeplink → play()（插入该曲并立即切播）；
# 未运行时由协议处理器拉起客户端再处理。客户端路由只看 pathname，host 任意。
function Invoke-PlaySoda([string]$songId) {
    if (-not $songId) { return [ordered]@{ ok = $false; error = 'soda 需要 song_id（track_id）' } }
    if ($songId -notmatch '^\d+$') { return [ordered]@{ ok = $false; error = 'soda 歌曲 id 无效（需要数字 track_id）' } }
    # 协议未注册说明没装汽水：明确报错，避免"命令成功但什么都没发生"
    if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\luna')) {
        return [ordered]@{ ok = $false; error = '未检测到汽水音乐（luna:// 协议未注册）' }
    }
    $uri = 'luna://luna.com/playing?track_id=' + $songId + '&media_type=track'
    $firstErr = ''
    try {
        # 与网易云一致：rundll32 是 GUI 子系统，不会闪黑框；WMI 被禁用时退回 Start-Process
        $cmdline = 'rundll32.exe url.dll,FileProtocolHandler "' + $uri + '"'
        $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
        if ($null -eq $r.ReturnValue -or $r.ReturnValue -eq 0) { return [ordered]@{ ok = $true } }
        $firstErr = "Create ReturnValue=$($r.ReturnValue)"
    } catch { $firstErr = $_.Exception.Message }
    try {
        Start-Process $uri
        return [ordered]@{ ok = $true }
    } catch {
        return [ordered]@{ ok = $false; error = "soda 启动失败: $firstErr | $($_.Exception.Message)" }
    }
}

# ==================== 主循环 ====================
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
while ($true) {
    $line = $null
    try { $line = $stdin.ReadLine() } catch { break }
    if ($null -eq $line) { break }          # stdin 关闭（父进程退出）→ 结束
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    try {
        $req = $line | ConvertFrom-Json
        $cmd = [string]$req.cmd
        $platform = [string]$req.platform

        switch ($cmd) {
            'state' {
                switch ($platform) {
                    'kugou' { Write-Resp (Get-KugouState) }
                    'qq' { Write-Resp (Get-SmtcState 'qq' 'QQMusic') }
                    'netease' { Write-Resp (Get-NeteaseState) }
                    'soda' { Write-Resp (Get-SodaState) }
                    default { Write-Resp ([ordered]@{ ok = $false; error = "unknown platform: $platform" }) }
                }
            }
            'play' {
                $mode = [string]$req.mode
                if ($mode -and $mode -notin @('replace', 'next')) {
                    Write-Resp ([ordered]@{ ok = $false; error = "unsupported mode: $mode" })
                    break
                }
                $songId = [string]$req.song_id
                switch ($platform) {
                    'kugou' { Write-Resp (Invoke-PlayKugou $songId) }
                    'qq' { Write-Resp (Invoke-PlayQq $songId) }
                    'netease' {
                        # next = 「下一首播放」：只支持 CDP 通道（不打断当前曲、保留原列表）
                        if ($mode -eq 'next') {
                            Write-Resp (Invoke-CdpNeteaseInsertNext $songId)
                        } else {
                            Write-Resp (Invoke-PlayNetease $songId)
                        }
                    }
                    'soda' { Write-Resp (Invoke-PlaySoda $songId) }
                    default { Write-Resp ([ordered]@{ ok = $false; error = "unknown platform: $platform" }) }
                }
            }
            'restart' {
                switch ($platform) {
                    'netease' { Write-Resp (Invoke-NeteaseRestart) }
                    default { Write-Resp ([ordered]@{ ok = $false; error = "restart 仅支持 netease" }) }
                }
            }
            default {
                Write-Resp ([ordered]@{ ok = $false; error = "unknown cmd: $cmd" })
            }
        }
    } catch {
        Write-Resp ([ordered]@{ ok = $false; error = "worker error: $($_.Exception.Message)" })
    }
}
Write-Log 'worker 退出'
