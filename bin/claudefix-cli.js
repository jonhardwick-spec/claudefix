#!/usr/bin/env node
/**
 * claudefix CLI - setup, uninstall, status
 * Usage: claudefix --setup | --uninstall | --status
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const cmd = args[0] || '--help';

const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function log(color, msg) {
  console.log(`${color}[claudefix]${RESET} ${msg}`);
}

const WRAPPER_LOCATIONS = [
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  path.join(os.homedir(), '.local/bin/claude'),
  // macOS Homebrew
  '/opt/homebrew/bin/claude',
];

function isClaudefixInstalled(location) {
  try {
    if (!fs.existsSync(location)) return false;
    const content = fs.readFileSync(location, 'utf8');
    return content.includes('claudefix') || content.includes('Hardwick');
  } catch (e) {
    return false;
  }
}

function getStatus() {
  log(CYAN, 'Checking installation status...\n');
  let found = false;

  for (const loc of WRAPPER_LOCATIONS) {
    if (fs.existsSync(loc)) {
      const isWrapper = isClaudefixInstalled(loc);
      const status = isWrapper ? `${GREEN}✓ claudefix wrapper${RESET}` : `${YELLOW}○ original claude${RESET}`;
      console.log(`  ${loc}: ${status}`);
      if (isWrapper) found = true;
    } else {
      console.log(`  ${loc}: ${RED}✗ not found${RESET}`);
    }
  }

  console.log('');
  if (found) {
    log(GREEN, 'claudefix is active!');
  } else {
    log(YELLOW, 'claudefix wrapper not installed. Run: claudefix --setup');
  }
}

function uninstall() {
  log(YELLOW, 'Uninstalling claudefix wrapper...\n');
  let removed = 0;
  const isMac = process.platform === 'darwin';

  for (const loc of WRAPPER_LOCATIONS) {
    if (isClaudefixInstalled(loc)) {
      try {
        // Remove immutable flag (Linux only)
        if (!isMac) {
          try { execSync(`chattr -i "${loc}" 2>/dev/null`, { stdio: 'pipe' }); } catch (e) {}
        }
        fs.unlinkSync(loc);
        log(GREEN, `✓ Removed: ${loc}`);
        removed++;

        // Restore backup if it exists
        const backupPath = loc + '-original';
        if (fs.existsSync(backupPath)) {
          try {
            const stat = fs.lstatSync(backupPath);
            if (stat.isSymbolicLink()) {
              const target = fs.readlinkSync(backupPath);
              fs.symlinkSync(target, loc);
            } else {
              fs.copyFileSync(backupPath, loc);
              fs.chmodSync(loc, 0o755);
            }
            fs.unlinkSync(backupPath);
            log(GREEN, `✓ Restored original: ${loc}`);
          } catch (e) {
            log(YELLOW, `Could not restore backup ${backupPath}: ${e.message}`);
          }
        }
      } catch (e) {
        log(RED, `✗ Could not remove ${loc}: ${e.message}`);
      }
    }
  }

  if (removed > 0) {
    console.log('');
    log(GREEN, 'Wrapper removed and original claude restored!');
    log(CYAN, 'To reinstall: claudefix --setup');
  } else {
    log(YELLOW, 'No claudefix wrappers found to remove.');
  }
}

function checkAndInstall() {
  const isRoot = process.getuid && process.getuid() === 0;

  // Check if we can write to npm prefix
  let canWrite = false;
  try {
    const prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    fs.accessSync(prefix, fs.constants.W_OK);
    canWrite = true;
  } catch {}

  if (!isRoot && !canWrite) {
    console.log('');
    console.log(`${RED}╔════════════════════════════════════════════════════════════════╗${RESET}`);
    console.log(`${RED}║${RESET}  ${BOLD}claudefix requires a global install with sudo${RESET}                ${RED}║${RESET}`);
    console.log(`${RED}╠════════════════════════════════════════════════════════════════╣${RESET}`);
    console.log(`${RED}║${RESET}                                                                ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}  To install claudefix, run:                                   ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}                                                                ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}    ${CYAN}${BOLD}sudo npm install -g claudefix${RESET}                            ${RED}║${RESET}`);
    console.log(`${RED}║${RESET}                                                                ${RED}║${RESET}`);
    console.log(`${RED}╚════════════════════════════════════════════════════════════════╝${RESET}`);
    console.log('');
    console.log(`${DIM}Developed by Hardwick Software Services @ https://justcalljon.pro${RESET}`);
    console.log('');
    process.exit(1);
  }

  // We have permissions, do the install
  log(GREEN, 'Installing claudefix globally...');
  try {
    execSync('npm install -g claudefix', { stdio: 'inherit' });
    console.log('');
    log(GREEN, 'claudefix installed successfully!');
    log(CYAN, 'Run "claudefix --setup" to configure, or use "claude-fixed" directly.');
  } catch (e) {
    log(RED, 'Installation failed. See errors above.');
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
${BOLD}${CYAN}claudefix${RESET} - Memory Leak & Screen Glitch Fix for Claude Code
${CYAN}Developed by Hardwick Software @ https://justcalljon.pro${RESET}

${BOLD}Usage:${RESET}
  claudefix install      Install globally (checks for sudo first!)
  claudefix --setup      Install the wrapper (replaces 'claude' command)
  claudefix --config     Re-run the feature configurator
  claudefix --uninstall  Remove the wrapper
  claudefix --status     Check if wrapper is installed
  claudefix --help       Show this help

${BOLD}Alternative:${RESET}
  claude-fixed           Run Claude with fix applied (no wrapper needed)

${BOLD}Environment Variables (all features optional):${RESET}

  ${YELLOW}CLAUDEFIX_MEM_PERCENT=35${RESET}
    ${DIM}Set V8 heap limit as % of RAM (1-100, default 35)${RESET}

  ${YELLOW}CLAUDEFIX_CPU_PERCENT=50${RESET}
    ${DIM}Limit CPU usage via cgroup/nice (1-100, default: no limit)${RESET}

  ${YELLOW}CLAUDEFIX_NO_FOOTER=1${RESET}
    ${DIM}Disable footer bar showing "claudefix by Hardwick Software"${RESET}

  ${YELLOW}CLAUDE_TERMINAL_FIX_DISABLED=1${RESET}
    ${DIM}Disable scrollback buffer clearing${RESET}

  ${YELLOW}CLAUDE_STRIP_BG_COLORS=0${RESET}
    ${DIM}Keep background colors (may cause VTE glitches)${RESET}

  ${YELLOW}CLAUDEFIX_NO_DARKMODE=1${RESET}
    ${DIM}Don't force dark mode on terminal startup${RESET}

  ${YELLOW}CLAUDEFIX_DISABLED=1${RESET}
    ${DIM}Disable all claudefix modifications${RESET}

  ${YELLOW}CLAUDEFIX_DEBUG=1${RESET}
    ${DIM}Show detailed claudefix operation logs${RESET}
`);
}

switch (cmd) {
  case 'install':
  case '--install':
    checkAndInstall();
    break;

  case '--setup':
  case 'setup':
    // Run the interactive installer
    require('../setup-interactive.cjs');
    break;

  case '--config':
  case 'config':
  case '--configure':
  case 'configure':
    // Re-run the configurator
    require('../install-hook.cjs');
    break;

  case '--uninstall':
  case 'uninstall':
  case '--remove':
  case 'remove':
    uninstall();
    break;

  case '--status':
  case 'status':
    getStatus();
    break;

  case '--help':
  case 'help':
  case '-h':
  default:
    showHelp();
    break;
}
