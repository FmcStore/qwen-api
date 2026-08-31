@echo off
title Qwen Proxy Server

rem No CV captcha sidecar ships in this tree: farmer/captcha_solver.py is a class
rem module (no __main__, no HTTP server), so launching it never bound port 5555.
rem CAPTCHA_SOLVER_URL is optional — without it the simple Aliyun slider still
rem solves via the heuristic drag path; only the puzzle captcha needs CV.

echo Starting Node Proxy...
start "Node Proxy" cmd /c "node --env-file=.env server.js"

echo ==============================================
echo [Qwen Proxy]
echo - Node Proxy is listening on port 8787
echo - No CV captcha sidecar (see comment in this file)
echo ==============================================
pause
