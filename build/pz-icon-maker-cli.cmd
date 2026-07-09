@echo off
REM Headless CLI wrapper.
REM
REM The app binary doubles as a Node runtime when ELECTRON_RUN_AS_NODE is set, which
REM is how the command line gets a real stdout. Everything after this script's name
REM is passed straight through, e.g.:
REM
REM   pz-icon-maker-cli set-game-dir "D:\Steam\steamapps\common\ProjectZomboid"
REM   pz-icon-maker-cli build "C:\mods\MyMod" --write
REM   pz-icon-maker-cli slots "C:\mods\MyMod" --item Bicycle
REM
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0pz-icon-maker.exe" "%~dp0resources\app.asar\src\cli.js" %*
endlocal
