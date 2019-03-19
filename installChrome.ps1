
$url = "http://dl.google.com/chrome/install/375.126/chrome_installer.exe"
$path = "C:\temp\chrome_installer.exe"

if(!(Split-Path -parent $path) -or !(Test-Path -pathType Container (Split-Path -parent $path))) {
    $path = Join-Path $pwd (Split-Path -leaf $path)
}

"Downloading Chrome..."
$client = new-object System.Net.WebClient
$client.DownloadFile($url, $path)


"Installing Chrome..."
Start-Process $path -ArgumentList "/silent /install"