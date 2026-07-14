@echo off
chcp 65001 >nul
title نظام الحضور والانصراف - وضع التطوير

echo ============================================
echo   نظام الحضور والانصراف - وضع التطوير
echo ============================================
echo.

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [خطأ] Node.js غير موجود. الرجاء تثبيته أولاً.
    pause
    exit /b 1
)

REM Check MySQL
sc query MySQL80 >nul 2>&1
if %errorlevel% neq 0 (
    sc query MySQL >nul 2>&1
    if %errorlevel% neq 0 (
        echo [تحذير] لم يتم اكتشاف MySQL تلقائياً. تأكد من تشغيله يدوياً.
    )
)

REM Check .env
if not exist "backend\.env" (
    echo [إعداد] إنشاء ملف إعدادات البيئة...
    copy "backend\.env.example" "backend\.env" >nul
    echo [تحذير] تم إنشاء backend\.env - قم بتحديث DATABASE_URL بكلمة المرور الصحيحة
    echo.
    notepad "backend\.env"
)

REM Start backend
echo [1/3] تشغيل الخادم الخلفي (المنفذ 5000)...
start "Backend - نظام الحضور" cmd /k "cd backend && node src/index.js"

REM Wait for backend
timeout /t 3 /nobreak >nul

REM Start Vite
echo [2/3] تشغيل واجهة المستخدم (المنفذ 3002)...
start "Frontend - نظام الحضور" cmd /k "cd frontend && npm run dev"

REM Wait for Vite
timeout /t 4 /nobreak >nul

REM Start Electron
echo [3/3] فتح برنامج الحضور...
cd frontend
npx electron .
cd ..
