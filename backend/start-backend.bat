@echo off
rem Start local petcare backend (uat, port 8000)
cd /d %~dp0
echo Starting backend on http://0.0.0.0:8000 (env=uat, MySQL petcare_uat) ...
.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
