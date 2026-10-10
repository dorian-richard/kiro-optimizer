@echo off
rem Windows shim for the kiro-cli simulator. kopt bench ab runs the .mjs next to it directly with Node;
rem this file is for calling the simulator by hand from cmd.exe or PowerShell.
node "%~dp0fake-kiro-cli.mjs" %*
