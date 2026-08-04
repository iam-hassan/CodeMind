@echo off
set VSCODE_DEV=1
setlocal
rem
rem Launch the CodeMind development build, on Windows.
rem
rem   scripts\run.bat              open the folder you are standing in
rem   scripts\run.bat <folder>     open <folder>
rem
rem This runs the compiled workbench out of vscodium\vscode\out through the
rem Electron runtime in vscodium\vscode\.build -- it is not a packaged
rem application. Run scripts\setup.bat first; scripts\setup.bat --compile picks
rem up later edits to the panel sources.
rem

set "ROOT=%~dp0.."
set "VSCODE=%ROOT%\vscodium\vscode"
set "BIN=%VSCODE%\.build\electron\CodeMind.exe"

if not exist "%VSCODE%\out\" (
	echo run.bat: vscodium\vscode\out is missing -- run scripts\setup.bat first. 1>&2
	exit /b 1
)

if not exist "%BIN%" (
	echo run.bat: %BIN% is missing -- run scripts\setup.bat, which downloads the 1>&2
	echo          Electron runtime. 1>&2
	exit /b 1
)

set "FOLDER=%~1"
if not defined FOLDER set "FOLDER=%ROOT%"
if not exist "%FOLDER%\" (
	echo run.bat: no such folder: %FOLDER% 1>&2
	exit /b 2
)
for %%f in ("%FOLDER%") do set "FOLDER=%%~ff"

echo CodeMind: %BIN%
echo folder:   %FOLDER%
echo.

rem cwd has to be the checkout: the workbench loads out\ relative to it, and the
rem leading "." tells Electron which app to run -- the folder follows it.
pushd "%VSCODE%"
"%BIN%" . "%FOLDER%"
set "CODE=%ERRORLEVEL%"
popd
if %CODE% neq 0 pause
exit /b %CODE%
