#!/bin/bash
# claudefix installer - checks for sudo before running npm install
# Developed by Hardwick Software Services @ https://justcalljon.pro

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

echo ""
echo -e "${CYAN}╔════════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${CYAN}║${RESET}              ${BOLD}claudefix installer${RESET}                               ${CYAN}║${RESET}"
echo -e "${CYAN}║${RESET}      Fixes screen glitching in Claude Code on Linux           ${CYAN}║${RESET}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════════╝${RESET}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}╔════════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${RED}║${RESET}  ${BOLD}Error: claudefix requires sudo to install globally${RESET}          ${RED}║${RESET}"
    echo -e "${RED}╠════════════════════════════════════════════════════════════════╣${RESET}"
    echo -e "${RED}║${RESET}                                                                ${RED}║${RESET}"
    echo -e "${RED}║${RESET}  Please run:                                                  ${RED}║${RESET}"
    echo -e "${RED}║${RESET}    ${CYAN}curl -fsSL https://claudefix.dev/install.sh | sudo bash${RESET}   ${RED}║${RESET}"
    echo -e "${RED}║${RESET}                                                                ${RED}║${RESET}"
    echo -e "${RED}║${RESET}  Or:                                                          ${RED}║${RESET}"
    echo -e "${RED}║${RESET}    ${CYAN}sudo npm install -g claudefix${RESET}                            ${RED}║${RESET}"
    echo -e "${RED}║${RESET}                                                                ${RED}║${RESET}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -e "${BOLD}Developed by Hardwick Software Services @ https://justcalljon.pro${RESET}"
    echo ""
    exit 1
fi

# Check for npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed${RESET}"
    echo "Please install Node.js and npm first:"
    echo "  https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}Installing claudefix...${RESET}"
echo ""

npm install -g claudefix

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${GREEN}║${RESET}              ${BOLD}claudefix installed successfully!${RESET}                 ${GREEN}║${RESET}"
    echo -e "${GREEN}╠════════════════════════════════════════════════════════════════╣${RESET}"
    echo -e "${GREEN}║${RESET}                                                                ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}  Run Claude Code with fixes:                                  ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}    ${CYAN}claude-fixed${RESET}                                              ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}                                                                ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}  Or configure and apply to regular 'claude' command:         ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}    ${CYAN}claudefix setup${RESET}                                           ${GREEN}║${RESET}"
    echo -e "${GREEN}║${RESET}                                                                ${GREEN}║${RESET}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${RESET}"
    echo ""
else
    echo ""
    echo -e "${RED}Installation failed. Please check the errors above.${RESET}"
    exit 1
fi
