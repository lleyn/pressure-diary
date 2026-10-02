param(
    [string]$SdkPath = "$env:LOCALAPPDATA/Android/Sdk",
    [string]$JdkPath = '',
    [string]$BuildToolsVersion = '36.0.0',
    [string]$Platform = 'android-36'
)

# Self-contained SDK build: no Gradle or network dependency resolution required.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $JdkPath) {
    $javacCommand = Get-Command javac.exe -ErrorAction Stop
    $JdkPath = Split-Path (Split-Path $javacCommand.Source -Parent) -Parent
}
$env:JAVA_HOME = $JdkPath
$sdkTools = Join-Path $SdkPath "build-tools/$BuildToolsVersion"
$androidJar = Join-Path $SdkPath "platforms/$Platform/android.jar"
$aapt2 = Join-Path $sdkTools 'aapt2.exe'
$zipalign = Join-Path $sdkTools 'zipalign.exe'
$apksigner = Join-Path $sdkTools 'apksigner.bat'
$d8 = Join-Path $sdkTools 'd8.bat'
$javac = Join-Path $JdkPath 'bin/javac.exe'
$jar = Join-Path $JdkPath 'bin/jar.exe'
$keytool = Join-Path $JdkPath 'bin/keytool.exe'
foreach ($requiredFile in @($androidJar, $aapt2, $zipalign, $apksigner, $d8, $javac, $jar, $keytool)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) { throw "Missing build tool: $requiredFile" }
}

function Invoke-BuildTool {
    param([string]$Program, [string[]]$ToolArgs)
    & $Program @ToolArgs
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE" }
}

$sourceDir = Join-Path $PSScriptRoot 'app/src/main'
$assetDir = Join-Path $sourceDir 'assets'
if (-not (Test-Path -LiteralPath (Join-Path $assetDir 'index.html'))) {
    throw 'Missing app/src/main/assets/index.html. Build only after app assets are ready.'
}
$buildId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$workDir = Join-Path $PSScriptRoot "app/build/manual/$buildId"
$classDir = Join-Path $workDir 'classes'
$dexDir = Join-Path $workDir 'dex'
$generatedDir = Join-Path $workDir 'generated'
$outputDir = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug'
$keyDir = Join-Path $PSScriptRoot '.tooling'
New-Item -ItemType Directory -Force -Path $workDir, $classDir, $dexDir, $generatedDir, $outputDir, $keyDir | Out-Null

# Gradle normally inserts the application package into the manifest.
$manifestPath = Join-Path $workDir 'AndroidManifest.xml'
[xml]$manifest = Get-Content -LiteralPath (Join-Path $sourceDir 'AndroidManifest.xml') -Raw -Encoding utf8
$manifest.DocumentElement.SetAttribute('package', 'ru.pressurediary.app')
$manifest.Save($manifestPath)

$resourcesZip = Join-Path $workDir 'resources.zip'
$unsignedApk = Join-Path $workDir 'app-unsigned.apk'
$alignedApk = Join-Path $workDir 'app-aligned.apk'
$classesJar = Join-Path $workDir 'classes.jar'
$finalApk = Join-Path $outputDir 'app-debug.apk'
$debugKeystore = Join-Path $keyDir 'debug.keystore'

Invoke-BuildTool $aapt2 @('compile', '--dir', (Join-Path $sourceDir 'res'), '-o', $resourcesZip)
Invoke-BuildTool $aapt2 @('link', '-o', $unsignedApk, '-I', $androidJar, '--manifest', $manifestPath,
    '--java', $generatedDir, '--min-sdk-version', '26', '--target-sdk-version', '36',
    '--version-code', '3', '--version-name', '1.1.0', '--debug-mode', '--auto-add-overlay', '-A', $assetDir, '-R', $resourcesZip)

$javaSources = @(Get-ChildItem -LiteralPath (Join-Path $sourceDir 'java'), $generatedDir -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
Invoke-BuildTool $javac (@('-encoding', 'UTF-8', '--release', '8', '-classpath', $androidJar, '-d', $classDir) + $javaSources)
Invoke-BuildTool $jar @('--create', '--file', $classesJar, '-C', $classDir, '.')
Invoke-BuildTool $d8 @('--min-api', '26', '--lib', $androidJar, '--output', $dexDir, $classesJar)
Invoke-BuildTool $jar @('--update', '--file', $unsignedApk, '-C', $dexDir, 'classes.dex')
Invoke-BuildTool $zipalign @('-f', '4', $unsignedApk, $alignedApk)

if (-not (Test-Path -LiteralPath $debugKeystore)) {
    Invoke-BuildTool $keytool @('-genkeypair', '-keystore', $debugKeystore, '-storepass', 'android',
        '-keypass', 'android', '-alias', 'androiddebugkey', '-dname', 'CN=Pressure Diary Debug,O=Local Development,C=RU',
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-noprompt')
}
Invoke-BuildTool $apksigner @('sign', '--ks', $debugKeystore, '--ks-key-alias', 'androiddebugkey',
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', $finalApk, $alignedApk)
Invoke-BuildTool $apksigner @('verify', '--verbose', $finalApk)
Invoke-BuildTool $zipalign @('-c', '4', $finalApk)

Write-Output "APK: $finalApk"
Get-FileHash -LiteralPath $finalApk -Algorithm SHA256 | Format-List
