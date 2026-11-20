@echo off
rem Kartal RTS - arkadasinla internet uzerinden oynamak icin.
rem Oyun sunucusunu baslatir ve localhost.run uzerinden gecici bir internet adresi acar.
rem Bu pencere acik kaldigi surece adres calisir; kapatinca adres de kapanir.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. https://nodejs.org adresinden kurun.
  pause
  exit /b 1
)
where ssh >nul 2>nul
if errorlevel 1 (
  echo OpenSSH bulunamadi. Windows Ayarlar ^> Uygulamalar ^> Istege bagli ozellikler ^> OpenSSH Istemcisi'ni kurun.
  pause
  exit /b 1
)

rem Sunucu zaten aciksa ikinci kopya kendiliginden kapanir, sorun degil.
start "Kartal RTS sunucu" /min cmd /c "for /l %%i in (1,1,9999) do (node server.js & timeout /t 1 /nobreak >nul)"
timeout /t 2 /nobreak >nul

rem Cloudflare tuneli kuruluysa onu kullan: cok daha hizli.
where cloudflared >nul 2>nul
if not errorlevel 1 (
  echo.
  echo ================================================================
  echo  Birazdan asagida  https://XXXX.trycloudflare.com  seklinde bir
  echo  adres cikacak. O adresi arkadasina gonder; ikiniz de O ADRESTEN
  echo  girin. Sonra: Cok Oyunculu ^> Oda Kur ^> kodu arkadasina soyle.
  echo  Bu pencereyi kapatma. Kapatinca adres calismaz.
  echo ================================================================
  echo.
  cloudflared tunnel --url http://127.0.0.1:5173 --no-autoupdate
  echo.
  echo Tunel kapandi. Yeniden acmak icin bu dosyayi tekrar calistir.
  pause
  exit /b 0
)

echo.
echo  (Cloudflare tuneli kurulu degil, yavas olan yedek tunel kullaniliyor.)
echo ================================================================
echo  Birazdan asagida  https://XXXXXXXX.lhr.life  seklinde bir adres
echo  cikacak. O adresi arkadasina gonder; ikiniz de O ADRESTEN girin.
echo  Sonra: Cok Oyunculu ^> Oda Kur ^> kodu arkadasina soyle.
echo  Bu pencereyi kapatma. Kapatinca adres calismaz.
echo ================================================================
echo.

ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:5173 nokey@localhost.run

echo.
echo Tunel kapandi. Yeniden acmak icin bu dosyayi tekrar calistir.
pause
