try {
    $r = Invoke-WebRequest -Uri 'http://localhost:8080/health' -TimeoutSec 5
    Write-Host "Health Status: $($r.StatusCode)"
    Write-Host "Content: $($r.Content)"
} catch {
    Write-Host "Health Error: $($_.Exception.Message)"
}

try {
    $r2 = Invoke-WebRequest -Uri 'http://localhost:8080/' -TimeoutSec 5
    Write-Host "Admin UI Status: $($r2.StatusCode)"
} catch {
    Write-Host "Admin UI Error: $($_.Exception.Message)"
}
