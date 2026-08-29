@echo off
setlocal EnableExtensions
rem ============================================================
rem install.bat - instala/remove o dsh-explorer-plugin (Windows)
rem
rem Uso:
rem   install.bat                instala o plugin (profile padrao: web)
rem   install.bat --check        valida pre-requisitos sem instalar
rem   install.bat --remove       remove o plugin do profile
rem   install.bat --help         mostra esta ajuda
rem
rem Variaveis de ambiente:
rem   DSH_PROFILE   nome do profile (padrao: web)
rem   DSH_HOME      diretorio home do DSH (padrao: %USERPROFILE%\.dsh)
rem
rem O que faz:
rem   1. Valida node, o CLI 'dsh' e o pnpm (PATH primeiro; se ausente,
rem      usa a copia local em .pnpm-home\, criando um shim em .bin\).
rem   2. Executa: dsh plugin --profile <profile> add -w <checkout>
rem   3. Imprime o proximo passo: reiniciar o 'dsh web' e recarregar a GUI.
rem
rem Observacao: o 'dsh' e um shim npm (.cmd) que termina com um
rem `goto #_undefined_#`; por isso ele precisa ser invocado com `call`
rem dentro de um batch, senao o goto falho encerra o batch inteiro.
rem ============================================================

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "CHECKOUT_DIR=%%~fI"

set "PROFILE=web"
if not "%DSH_PROFILE%"=="" set "PROFILE=%DSH_PROFILE%"

set "MODE=install"
set "ARG1=%~1"
if "%ARG1%"=="--check"  set "MODE=check"
if "%ARG1%"=="check"    set "MODE=check"
if "%ARG1%"=="--remove" set "MODE=remove"
if "%ARG1%"=="remove"   set "MODE=remove"
if "%ARG1%"=="uninstall" set "MODE=remove"
if "%ARG1%"=="--help"   set "MODE=help"
if "%ARG1%"=="-h"       set "MODE=help"
if "%ARG1%"=="/?"       set "MODE=help"
if "%ARG1%"=="help"     set "MODE=help"

if "%MODE%"=="help"    goto :do_help
goto :validate

rem ============================================================
rem Validacao de pre-requisitos (node, dsh, pnpm)
rem ============================================================
:validate

rem --- node ---
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
if not defined NODE_BIN (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo        Instale o Node.js 20 ou mais recente e tente novamente.
  echo        Dica: winget install OpenJS.NodeJS.LTS
  exit /b 1
)
for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
echo [OK] node %NODE_VERSION% (%NODE_BIN%)

rem --- dsh CLI ---
set "DSH_BIN="
where dsh >nul 2>nul && set "DSH_BIN=dsh"
if not defined DSH_BIN if exist "%APPDATA%\npm\dsh.cmd" (
  set "DSH_BIN=%APPDATA%\npm\dsh.cmd"
  set "PATH=%APPDATA%\npm;%PATH%"
)
if not defined DSH_BIN (
  echo [ERRO] CLI 'dsh' nao encontrado no PATH.
  echo        Instale com: npm install -g @deepseek-ai/dsh
  exit /b 1
)
echo [OK] dsh (%DSH_BIN%)

rem --- pnpm ---
set "PNPM_BIN="
where pnpm >nul 2>nul && set "PNPM_BIN=pnpm"
if defined PNPM_BIN goto :pnpm_done
if not exist "%CHECKOUT_DIR%\.pnpm-home\node_modules\pnpm\bin\pnpm.cjs" goto :pnpm_missing
if "%MODE%"=="check" goto :pnpm_use_vendored
if not exist "%CHECKOUT_DIR%\.bin" mkdir "%CHECKOUT_DIR%\.bin"
> "%CHECKOUT_DIR%\.bin\pnpm.cmd" echo @echo off
>> "%CHECKOUT_DIR%\.bin\pnpm.cmd" echo node "%%~dp0..\.pnpm-home\node_modules\pnpm\bin\pnpm.cjs" %%*
:pnpm_use_vendored
set "PNPM_BIN=%CHECKOUT_DIR%\.bin\pnpm.cmd"
set "PATH=%CHECKOUT_DIR%\.bin;%PATH%"
if "%MODE%"=="check" goto :pnpm_check_msg
echo [OK] pnpm via copia local (.pnpm-home; shim criado em .bin\pnpm.cmd)
goto :pnpm_msg_done
:pnpm_check_msg
echo [OK] pnpm via copia local (.pnpm-home; o shim .bin\pnpm.cmd seria criado)
:pnpm_msg_done
goto :pnpm_done
:pnpm_missing
echo [ERRO] pnpm nao encontrado no PATH nem em .pnpm-home\.
echo        Instale o pnpm (corepack enable ou npm install -g pnpm) e tente novamente.
exit /b 1
:pnpm_done
echo [OK] pnpm (%PNPM_BIN%)

set "PROFILE_DIR=%USERPROFILE%\.dsh\profiles\%PROFILE%"
if not "%DSH_HOME%"=="" set "PROFILE_DIR=%DSH_HOME%\profiles\%PROFILE%"

echo.
if "%MODE%"=="check" (
  echo [OK] Tudo pronto. Comando que seria executado:
  echo      dsh plugin --profile %PROFILE% add -w "%CHECKOUT_DIR%"
  echo      profile: %PROFILE_DIR%
  exit /b 0
)

rem --- roteia para instalacao/remocao apos a validacao ---
if "%MODE%"=="remove" goto :do_remove
goto :do_install

rem ============================================================
rem Instalacao
rem ============================================================
:do_install
echo ==^> Instalando dsh-explorer-plugin no profile '%PROFILE%'...
echo      comando: dsh plugin --profile %PROFILE% add -w "%CHECKOUT_DIR%"
call dsh plugin --profile "%PROFILE%" add -w "%CHECKOUT_DIR%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERRO] A instalacao falhou ^(codigo %RC%^).
  echo        Confira a mensagem do pnpm acima e tente novamente.
  exit /b %RC%
)
echo.
echo Instalacao concluida!
echo.
echo Proximo passo - reinicie o servidor web para o novo bundle entrar no boot:
echo   * Pare o 'dsh web' (Ctrl+C no terminal onde ele esta rodando) e suba de novo:
echo        dsh web
echo   * Depois recarregue a GUI: http://127.0.0.1:3080
echo.
echo Para remover depois: scripts\install.bat --remove
exit /b 0

rem ============================================================
rem Remocao
rem ============================================================
:do_remove
echo ==^> Removendo dsh-explorer-plugin do profile '%PROFILE%'...
call dsh plugin --profile "%PROFILE%" remove dsh-explorer-plugin
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [ERRO] A remocao falhou ^(codigo %RC%^). Confira a mensagem acima.
  exit /b %RC%
)
echo.
echo [OK] Plugin removido. Reinicie o 'dsh web' e recarregue a pagina.
exit /b 0

rem ============================================================
rem Ajuda
rem ============================================================
:do_help
echo Uso:
echo   install.bat                instala o plugin (profile padrao: web)
echo   install.bat --check        valida pre-requisitos sem instalar
echo   install.bat --remove       remove o plugin do profile
echo   install.bat --help         mostra esta ajuda
echo.
echo Variaveis de ambiente:
echo   DSH_PROFILE   nome do profile (padrao: web)
echo   DSH_HOME      diretorio home do DSH (padrao: %%USERPROFILE%%\.dsh)
exit /b 0
