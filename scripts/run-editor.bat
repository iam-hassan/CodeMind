@echo off
set VSCODE_DEV=1
setlocal EnableDelayedExpansion
rem
rem Launch the CodeMind development build, on Windows (editor only).
rem
rem   scripts\run-editor.bat              open a fresh, empty window
rem   scripts\run-editor.bat <folder>     open <folder> in a new window
rem
rem Usually called by run.bat / run-brain.ps1, which also bring up the Project Brain.
rem

set "ROOT=%~dp0.."
set "VSCODE=%ROOT%\vscodium\vscode"
set "BIN=%VSCODE%\.build\electron\CodeMind.exe"

if not exist "%VSCODE%\out\" (
	echo run-editor.bat: vscodium\vscode\out is missing -- run scripts\setup.bat first. 1>&2
	exit /b 1
)

if not exist "%BIN%" (
	echo run-editor.bat: %BIN% is missing -- run scripts\setup.bat, which downloads the 1>&2
	echo          Electron runtime. 1>&2
	exit /b 1
)

rem Optional folder argument. With no argument, CodeMind always opens a fresh empty
rem window (--new-window) instead of restoring the last workspace.
set "FOLDERARG="
if not "%~1"=="" (
	for %%f in ("%~1") do set "FOLDERARG=%%~ff"
	if not exist "!FOLDERARG!\" (
		echo run-editor.bat: no such folder: %~1 1>&2
		exit /b 2
	)
)

echo CodeMind: %BIN%
if defined FOLDERARG (
	echo folder:   !FOLDERARG!
) else (
	echo folder:   (new empty window^)
)
echo.

rem Dev mode (same flags the upstream scripts\code.bat sets): the compiled
rem workbench in out\ is unbundled, and its CSS imports only load when the
rem window is told this is a development build (VSCODE_DEV).
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1

rem cwd has to be the checkout: the workbench loads out\ relative to it. "." is the
rem Electron app path; --new-window forces a fresh window, and the folder follows it.
pushd "%VSCODE%"
if defined FOLDERARG (
	"%BIN%" . --new-window "!FOLDERARG!"
) else (
	"%BIN%" . --new-window
)
set "CODE=%ERRORLEVEL%"
popd
if %CODE% neq 0 pause
exit /b %CODE%