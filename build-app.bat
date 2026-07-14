@echo off
chcp 65001 >nul
title بناء نظام الحضور والانصراف

echo ============================================
echo   بناء نظام الحضور والانصراف
echo   AttendanceSystem.exe
echo ============================================
echo.

REM Check Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [خطأ] Node.js غير موجود.
    pause
    exit /b 1
)

REM Install backend deps
echo [1/4] تثبيت مكتبات الخادم الخلفي...
cd backend
call npm install --omit=dev
cd ..
echo.

REM Install frontend deps
echo [2/4] تثبيت مكتبات الواجهة...
cd frontend
call npm install
echo.

REM Build Vite
echo [3/4] بناء واجهة المستخدم...
call npm run build
if %errorlevel% neq 0 (
    echo [خطأ] فشل بناء الواجهة
    pause
    exit /b 1
)
echo.

REM Package with electron-builder
echo [4/4] تحزيم التطبيق...
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo [خطأ] فشل التحزيم
    pause
    exit /b 1
)
cd ..

echo.
echo ============================================
echo   تم البناء بنجاح!
echo   الملف: dist-electron\
echo ============================================
pause
