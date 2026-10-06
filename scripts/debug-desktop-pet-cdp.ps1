param(
    [string]$Url = "http://127.0.0.1:8000/desktop-pet/",
    [int]$Port = 9223
)

$ErrorActionPreference = "Stop"

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    throw "Chrome not found: $chrome"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $projectRoot ".runtime\chrome-cdp"
New-Item -ItemType Directory -Force $profile | Out-Null

$process = Start-Process `
    -FilePath $chrome `
    -ArgumentList @("--headless=new", "--remote-debugging-port=$Port", "--user-data-dir=$profile", $Url) `
    -PassThru

try {
    $tabs = $null
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $tabs = Invoke-RestMethod "http://127.0.0.1:$Port/json"
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $tabs) {
        throw "Chrome DevTools endpoint did not start."
    }

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $socket.ConnectAsync([Uri]$tabs[0].webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()

    function Send-Cdp($socket, $obj) {
        $json = $obj | ConvertTo-Json -Compress -Depth 20
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $segment = [ArraySegment[byte]]::new($bytes)
        $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
    }

    function Receive-Cdp($socket) {
        $buffer = New-Object byte[] 262144
        $segment = [ArraySegment[byte]]::new($buffer)
        $result = $socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).Result
        [Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
    }

    $expression = @'
(() => {
  const app = window.__petApp;
  const renderer = app?.spineRenderer;
  const canvas = document.querySelector(".spine-canvas");
  const fallback = document.querySelector("#petCanvas");
  const sample = { alphaPixels: 0, total: 0 };
  if (canvas) {
    try {
      const gl = canvas.getContext("webgl");
      if (gl) {
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] > 0) sample.alphaPixels += 1;
        }
        sample.total = canvas.width * canvas.height;
      }
    } catch (error) {
      sample.error = String(error);
    }
  }
  return {
    profile: app?.currentProfile?.()?.id,
    state: app?.state,
    mountClass: document.querySelector("#spineMount")?.className,
    canvasRect: canvas?.getBoundingClientRect().toJSON?.(),
    canvasWidth: canvas?.width,
    canvasHeight: canvas?.height,
    fallbackDisplay: fallback ? getComputedStyle(fallback).display : null,
    active: renderer?.active,
    loadedKey: renderer?.loadedKey,
    animations: renderer?.skeletonData?.animations?.map((item) => item.name),
    boundsOffset: renderer?.boundsOffset,
    boundsSize: renderer?.boundsSize,
    skeleton: renderer?.skeleton ? {
      x: renderer.skeleton.x,
      y: renderer.skeleton.y,
      scaleX: renderer.skeleton.scaleX,
      scaleY: renderer.skeleton.scaleY
    } : null,
    sample
  };
})()
'@

    Send-Cdp $socket @{
        id = 1
        method = "Runtime.evaluate"
        params = @{
            expression = $expression
            returnByValue = $true
            awaitPromise = $true
        }
    }

    do {
        $message = Receive-Cdp $socket
        $payload = $message | ConvertFrom-Json
    } until ($payload.id -eq 1)

    $payload.result.result.value | ConvertTo-Json -Depth 20
    $socket.Dispose()
} finally {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
