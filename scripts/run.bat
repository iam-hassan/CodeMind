@echo off
rem
rem Start CodeMind. The Project Brain is part of CodeMind now, so this also brings up
rem its backing services (PostgreSQL + pgvector, Neo4j, the local embedding service and the
rem dashboard), sets the brain environment, and enables it — then launches the editor.
rem
rem   scripts\run.bat              fresh empty window
rem   scripts\run.bat <folder>     open <folder> in a new window
rem
rem The service work lives in run-brain.ps1; the editor launch lives in run-editor.bat.
rem

setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-brain.ps1" %*
exit /b %ERRORLEVEL%