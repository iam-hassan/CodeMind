@echo off
setlocal EnableDelayedExpansion
rem
rem First-time setup for a CodeMind development build, on Windows.
rem
rem   scripts\setup.bat             full setup
rem   scripts\setup.bat --check     check the prerequisites and stop
rem   scripts\setup.bat --compile   re-overlay the CodeMind sources and recompile
rem
rem VSCodium's build scripts are bash scripts, so this checks the two things that
rem are specific to Windows -- Git Bash, and the C++ build tools the native
rem modules need -- and then hands over to scripts\setup.sh through Git Bash,
rem which checks the rest of the prerequisites and does the work.
rem

set "ROOT=%~dp0.."
set "FAILED=0"

echo.
echo == Windows prerequisites

rem Git, and the bash.exe that ships with it. Windows also has a bash.exe in
rem System32 that starts WSL, which cannot see the Windows toolchain, so look
rem for Git's own copy instead of taking whatever "where bash" finds first.
set "BASH="
for %%c in (
	"%ProgramFiles%\Git\bin\bash.exe"
	"%ProgramFiles(x86)%\Git\bin\bash.exe"
	"%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
) do if not defined BASH if exist %%c set "BASH=%%~c"

if not defined BASH (
	for /f "delims=" %%g in ('where git 2^>nul') do (
		if not defined BASH (
			for %%r in ("%%~dpg..") do (
				if exist "%%~fr\bin\bash.exe" set "BASH=%%~fr\bin\bash.exe"
			)
		)
	)
)

if defined BASH (
	echo    ok       Git Bash  "!BASH!"
) else (
	echo    MISSING  Git Bash  runs the VSCodium build scripts
	echo             install Git for Windows: https://git-scm.com/download/win
	set "FAILED=1"
)

rem The C++ toolchain for VS Code's native modules. A missing one only shows up
rem much later, in the middle of npm ci, so say something now.
set "HAVE_MSVC="
for %%c in (
	"%ProgramFiles%\Microsoft Visual Studio\2022"
	"%ProgramFiles(x86)%\Microsoft Visual Studio\2022"
	"%ProgramFiles(x86)%\Microsoft Visual Studio\2019"
) do if not defined HAVE_MSVC if exist %%c set "HAVE_MSVC=1"

if defined HAVE_MSVC (
	echo    ok       MSVC      Visual Studio build tools found
) else (
	echo    WARNING  MSVC      not found; npm ci will fail while building the
	echo             native modules. Install the Visual Studio Build Tools with
	echo             the "Desktop development with C++" workload:
	echo             https://visualstudio.microsoft.com/visual-cpp-build-tools/
)

if "%FAILED%"=="1" (
	echo.
	echo setup.bat: prerequisite missing -- install it and run this again.
	exit /b 1
)

echo.
echo == Handing over to scripts\setup.sh through Git Bash
"%BASH%" "%~dp0setup.sh" %*
exit /b %ERRORLEVEL%
