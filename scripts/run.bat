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

rem --- Optional: local Headroom compression proxy (Layer 6) -------------------
rem Entirely optional and non-fatal. CodeMind compresses the pre-fetched context
rem through this LOCAL proxy when it is up and passes it through unchanged when
rem it is not, so the launch never depends on it and nothing leaves the machine.
rem headroom-ai ships no CLI bin, so this only fires if a `headroom` command is
rem separately on PATH; otherwise we print one line and carry on.
where headroom >nul 2>&1
if %ERRORLEVEL%==0 (
	netstat -ano | findstr ":7878" | findstr /i "LISTENING" >nul 2>&1
	if errorlevel 1 (
		echo Headroom: starting local proxy on :7878
		start "" /b headroom proxy --port 7878
	) else (
		echo Headroom: proxy already running on :7878
	)
) else (
	echo Headroom: no 'headroom' CLI on PATH -- running without compression ^(optional^).
)
echo.

rem Dev mode (same flags the upstream scripts\code.bat sets): the compiled
rem workbench in out\ is unbundled, and its CSS imports only load when the
rem window is told this is a development build (VSCODE_DEV). Without this the
rem renderer fails to load every stylesheet and the window stays blank.
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1

rem cwd has to be the checkout: the workbench loads out\ relative to it, and the
rem leading "." tells Electron which app to run -- the folder follows it.
pushd "%VSCODE%"
"%BIN%" .
set "CODE=%ERRORLEVEL%"
popd
if %CODE% neq 0 pause
exit /b %CODE%
