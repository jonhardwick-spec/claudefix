#!/usr/bin/env node
/**
 * claudefix pre-install - ensures build dependencies for node-pty
 *
 * node-pty requires native compilation. This script:
 * 1. Checks for required build tools (python, make, g++)
 * 2. Attempts to install them if running as root
 * 3. Warns user if they need to install manually
 *
 * Developed by Hardwick Software Services @ https://justcalljon.pro
 */

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function log(msg) {
  console.log(`${CYAN}[claudefix]${RESET} ${msg}`);
}

function warn(msg) {
  console.log(`${YELLOW}[claudefix]${RESET} ${msg}`);
}

function error(msg) {
  console.log(`${RED}[claudefix]${RESET} ${msg}`);
}

function success(msg) {
  console.log(`${GREEN}[claudefix]${RESET} ${msg}`);
}

// Check if a command exists
function hasCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if running as root
function isRoot() {
  return process.getuid && process.getuid() === 0;
}

// Detect package manager
function getPackageManager() {
  if (hasCommand('apt-get')) return 'apt';
  if (hasCommand('dnf')) return 'dnf';
  if (hasCommand('yum')) return 'yum';
  if (hasCommand('pacman')) return 'pacman';
  if (hasCommand('apk')) return 'apk';
  if (hasCommand('brew')) return 'brew';
  return null;
}

// Install build dependencies
function installBuildDeps() {
  const pm = getPackageManager();
  if (!pm) {
    warn('Could not detect package manager');
    return false;
  }

  log(`Detected package manager: ${pm}`);

  try {
    switch (pm) {
      case 'apt':
        log('Installing build-essential python3...');
        execSync('apt-get update -qq && apt-get install -y build-essential python3', {
          stdio: 'inherit',
          timeout: 120000
        });
        break;
      case 'dnf':
      case 'yum':
        log('Installing gcc-c++ make python3...');
        execSync(`${pm} install -y gcc-c++ make python3`, {
          stdio: 'inherit',
          timeout: 120000
        });
        break;
      case 'pacman':
        log('Installing base-devel python...');
        execSync('pacman -Sy --noconfirm base-devel python', {
          stdio: 'inherit',
          timeout: 120000
        });
        break;
      case 'apk':
        log('Installing build-base python3...');
        execSync('apk add --no-cache build-base python3', {
          stdio: 'inherit',
          timeout: 120000
        });
        break;
      case 'brew':
        // macOS usually has build tools, just need to ensure
        log('Checking Xcode CLI tools...');
        try {
          execSync('xcode-select --install 2>/dev/null || true', { stdio: 'pipe' });
        } catch {}
        break;
    }
    return true;
  } catch (e) {
    error(`Failed to install build dependencies: ${e.message}`);
    return false;
  }
}

// Check required build tools
function checkBuildTools() {
  const required = [
    { cmd: 'python3', alt: 'python', name: 'Python' },
    { cmd: 'make', name: 'Make' },
    { cmd: 'g++', alt: 'clang++', name: 'C++ Compiler' }
  ];

  const missing = [];

  for (const tool of required) {
    if (!hasCommand(tool.cmd) && (!tool.alt || !hasCommand(tool.alt))) {
      missing.push(tool.name);
    }
  }

  return missing;
}

// Check if this is a global install
function isGlobalInstall() {
  // npm sets npm_config_global when installing globally
  return process.env.npm_config_global === 'true' ||
         process.argv.includes('-g') ||
         process.argv.includes('--global');
}

// Check if we can write to npm prefix
function canWriteToNpmPrefix() {
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    fs.accessSync(prefix, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Main
function main() {
  // Check for global install without sudo/root permissions
  if (isGlobalInstall() && !isRoot() && !canWriteToNpmPrefix()) {
    console.log('');
    console.log(`${RED}╔════════════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${RED}║${RESET}  ${BOLD}claudefix requires sudo for global installation${RESET}              ${RED}║${RESET}`);
    console.log(`${RED}╠════════════════════════════════════════════════════════════════╣${RESET}`);
    console.log(`${RED}║${RESET}                                                                ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}  Please run:                                                  ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}    ${CYAN}sudo npm install -g claudefix${RESET}                            ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}                                                                ${RED}║${RESET}`);
    console.log(`${RED}╚════════════════════════════════════════════════════════════════╝${RESET}`);
    console.log('');
    console.log(`${DIM}Developed by Hardwick Software Services @ https://justcalljon.pro${RESET}`);
    console.log('');
    process.exit(1);
  }

  // Skip on Windows - node-pty has prebuilt binaries
  if (os.platform() === 'win32') {
    success('Windows detected - using prebuilt binaries');
    return;
  }

  // Skip on macOS if Xcode tools are present
  if (os.platform() === 'darwin') {
    try {
      execSync('xcode-select -p', { stdio: 'pipe' });
      success('macOS with Xcode tools detected');
      return;
    } catch {
      warn('macOS without Xcode tools - attempting install...');
    }
  }

  log('Checking build dependencies for node-pty...');

  const missing = checkBuildTools();

  if (missing.length === 0) {
    success('All build dependencies present');
    return;
  }

  warn(`Missing: ${missing.join(', ')}`);

  if (isRoot()) {
    log('Running as root - attempting to install build dependencies...');
    if (installBuildDeps()) {
      // Recheck
      const stillMissing = checkBuildTools();
      if (stillMissing.length === 0) {
        success('Build dependencies installed successfully');
        return;
      }
    }
  }

  // Can't auto-install - show manual instructions
  console.log('');
  warn('node-pty requires build tools to compile.');
  console.log('');
  console.log(`${BOLD}Install them with:${RESET}`);

  const pm = getPackageManager();
  switch (pm) {
    case 'apt':
      console.log(`  ${CYAN}sudo apt-get install build-essential python3${RESET}`);
      break;
    case 'dnf':
    case 'yum':
      console.log(`  ${CYAN}sudo ${pm} install gcc-c++ make python3${RESET}`);
      break;
    case 'pacman':
      console.log(`  ${CYAN}sudo pacman -S base-devel python${RESET}`);
      break;
    case 'apk':
      console.log(`  ${CYAN}apk add build-base python3${RESET}`);
      break;
    default:
      console.log(`  ${CYAN}Install: gcc, g++, make, python3${RESET}`);
  }

  console.log('');
  console.log(`${DIM}Then re-run: npm install -g claudefix${RESET}`);
  console.log('');

  // Don't fail the install - let npm try anyway
  // Some systems might have the tools in non-standard locations
}

main();
