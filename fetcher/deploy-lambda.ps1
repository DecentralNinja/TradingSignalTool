# Packages fetcher/ and updates the trading-signal-fetch Lambda function code.
# Run this after any change to fetcher/src, index.js, or lambda.js.
$ErrorActionPreference = "Stop"

$fetcherDir = $PSScriptRoot
$stagingDir = Join-Path $fetcherDir "..\lambda-deploy"
$zipPath = Join-Path $fetcherDir "..\lambda-deploy.zip"

if (Test-Path $stagingDir) { Remove-Item -Recurse -Force $stagingDir }
New-Item -ItemType Directory -Path $stagingDir | Out-Null

Copy-Item (Join-Path $fetcherDir "index.js") $stagingDir
Copy-Item (Join-Path $fetcherDir "lambda.js") $stagingDir
Copy-Item (Join-Path $fetcherDir "package.json") $stagingDir
Copy-Item (Join-Path $fetcherDir "package-lock.json") $stagingDir
Copy-Item (Join-Path $fetcherDir "src") (Join-Path $stagingDir "src") -Recurse
Copy-Item (Join-Path $fetcherDir "node_modules") (Join-Path $stagingDir "node_modules") -Recurse

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipPath

aws lambda update-function-code --function-name trading-signal-fetch --zip-file "fileb://$zipPath"

Remove-Item -Recurse -Force $stagingDir
Remove-Item -Force $zipPath

Write-Host "Deployed trading-signal-fetch."
