#!/usr/bin/env node
/**
 * claudefix post-install configurator
 * Interactive menu to select which fixes you want
 *
 * Developed by Hardwick Software Services @ https://justcalljon.pro
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const tty = require('tty');
const { spawnSync } = require('child_process');

const CONFIG_PATH = path.join(os.homedir(), '.claudefix.json');

// Check if we're being run as a child process for interactive mode
const IS_INTERACTIVE_CHILD = process.env.CLAUDEFIX_INTERACTIVE_CHILD === '1';

// Get a TTY stream even during npm postinstall (which doesn't have stdin as TTY)
function getTTYInput() {
  // First check if stdin is already a TTY
  if (process.stdin.isTTY) {
    return process.stdin;
  }

  // Try to open /dev/tty directly (works on Linux/macOS)
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    return new tty.ReadStream(fd);
  } catch (e) {
    return null;
  }
}

// Check if /dev/tty exists (we're in a real terminal)
function hasTTY() {
  try {
    fs.accessSync('/dev/tty', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

// Get TTY output stream (bypasses npm's output capture)
function getTTYOutput() {
  try {
    const fd = fs.openSync('/dev/tty', 'w');
    return new tty.WriteStream(fd);
  } catch (e) {
    return null;
  }
}

// Write directly to TTY (bypasses npm capturing stdout)
let ttyOut = null;
function ttyWrite(msg) {
  if (!ttyOut) ttyOut = getTTYOutput();
  if (ttyOut) {
    ttyOut.write(msg + '\n');
  } else {
    console.log(msg);
  }
}

// Colors
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// Default config - first run has footer enabled
const DEFAULT_CONFIG = {
  firstRun: true,
  footer: true,           // Forced on first run, optional after
  memoryLimit: true,      // Always recommended
  memPercent: 35,         // % of RAM for V8 heap (1-100)
  cpuPercent: 0,          // % CPU limit (0 = no limit)
  colorStripping: true,   // Fix VTE glitches
  darkMode: false,        // ASK user
  scrollbackClear: true,  // Memory optimization
  resizeDebounce: true,   // tmux/screen fix
  configured: false
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function createInterface(inputStream) {
  return readline.createInterface({
    input: inputStream,
    output: process.stdout
  });
}

async function askYesNo(rl, question, defaultYes = true) {
  return new Promise((resolve) => {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    rl.question(`${question} ${hint} `, (answer) => {
      const a = answer.toLowerCase().trim();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

async function runConfigurator() {
  // Check if this is being run directly (claudefix --config) or via postinstall
  const isPostInstall = !IS_INTERACTIVE_CHILD && !process.stdin.isTTY;

  // During npm postinstall, just show a message to run config manually
  if (isPostInstall) {
    // Write directly to TTY if available to bypass npm output capture
    const output = hasTTY() ? getTTYOutput() : null;
    const write = (msg) => {
      if (output) output.write(msg + '\n');
      else console.log(msg);
    };

    write('');
    write(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
    write(`${BOLD}${CYAN}║${RESET}  ${BOLD}claudefix${RESET} - Memory Leak & Screen Glitch Fix for Claude Code  ${CYAN}║${RESET}`);
    write(`${BOLD}${CYAN}║${RESET}  Developed by Hardwick Software @ ${YELLOW}https://justcalljon.pro${RESET}     ${CYAN}║${RESET}`);
    write(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
    write('');
    write(`${GREEN}✓ claudefix installed!${RESET}`);
    write('');
    write(`${BOLD}${YELLOW}Run this to configure your preferences:${RESET}`);
    write(`   ${CYAN}claudefix --config${RESET}`);
    write('');
    write(`${DIM}Or just run 'claude' - it works with sensible defaults!${RESET}`);
    write('');

    if (output) output.destroy();

    // Save defaults
    const config = { ...DEFAULT_CONFIG };
    saveConfig(config);
    return;
  }

  // Interactive mode (claudefix --config)
  console.log('');
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  ${BOLD}claudefix${RESET} - Memory Leak & Screen Glitch Fix for Claude Code  ${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  Developed by Hardwick Software @ ${YELLOW}https://justcalljon.pro${RESET}     ${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  // Try to get a TTY
  const ttyInput = getTTYInput();
  if (!ttyInput) {
    console.log(`${YELLOW}[claudefix]${RESET} No terminal available`);
    console.log(`${DIM}Run 'claudefix --config' from an interactive terminal${RESET}`);
    return;
  }

  console.log(`${GREEN}✓ claudefix installed!${RESET}`);
  console.log('');
  console.log(`${BOLD}Let's configure your preferences:${RESET}`);
  console.log(`${DIM}(You can change these later with 'claudefix --config')${RESET}`);
  console.log('');

  const rl = createInterface(ttyInput);
  const config = loadConfig();

  try {
    // 1. Memory limit - always recommended
    console.log(`${CYAN}1. Memory Limit (V8 Heap Cap)${RESET}`);
    console.log(`   ${DIM}Limits Claude to a % of RAM - prevents OOM crashes${RESET}`);
    config.memoryLimit = await askYesNo(rl, '   Enable memory limit?', true);
    if (config.memoryLimit) {
      const pct = await new Promise((resolve) => {
        rl.question(`   ${DIM}RAM percentage (1-100, default 35):${RESET} `, (answer) => {
          const val = parseInt(answer.trim(), 10);
          resolve((val >= 1 && val <= 100) ? val : 35);
        });
      });
      config.memPercent = pct;
      console.log(`   ${DIM}Set to ${pct}% of RAM${RESET}`);
    }
    console.log('');

    // 1b. CPU limit
    console.log(`${CYAN}1b. CPU Limit${RESET}`);
    console.log(`   ${DIM}Limit Claude's CPU usage (uses cpulimit or nice)${RESET}`);
    const wantCpu = await askYesNo(rl, '   Enable CPU limit?', false);
    if (wantCpu) {
      const cpuPct = await new Promise((resolve) => {
        rl.question(`   ${DIM}CPU percentage (1-100, default 50):${RESET} `, (answer) => {
          const val = parseInt(answer.trim(), 10);
          resolve((val >= 1 && val <= 100) ? val : 50);
        });
      });
      config.cpuPercent = cpuPct;
      console.log(`   ${DIM}Set to ${cpuPct}%${RESET}`);
    } else {
      config.cpuPercent = 0;
    }
    console.log('');

    // 2. Color stripping
    console.log(`${CYAN}2. Color Fix (Strip Background Colors)${RESET}`);
    console.log(`   ${DIM}Fixes VTE rendering glitches on Linux terminals${RESET}`);
    config.colorStripping = await askYesNo(rl, '   Enable color fix?', true);
    console.log('');

    // 3. Dark mode - ASK explicitly
    console.log(`${CYAN}3. Force Dark Mode${RESET}`);
    console.log(`   ${DIM}Automatically sets terminal to dark theme on startup${RESET}`);
    config.darkMode = await askYesNo(rl, '   Force dark mode?', false);
    console.log('');

    // 4. Scrollback clearing
    console.log(`${CYAN}4. Scrollback Buffer Clearing${RESET}`);
    console.log(`   ${DIM}Periodically clears terminal scrollback to save memory${RESET}`);
    config.scrollbackClear = await askYesNo(rl, '   Enable scrollback clearing?', true);
    console.log('');

    // 5. Resize debounce
    console.log(`${CYAN}5. Resize Debouncing${RESET}`);
    console.log(`   ${DIM}Prevents render thrashing in tmux/screen on resize${RESET}`);
    config.resizeDebounce = await askYesNo(rl, '   Enable resize debounce?', true);
    console.log('');

    // 6. Footer - explain first run policy
    console.log(`${CYAN}6. Footer Bar${RESET}`);
    console.log(`   ${DIM}Shows "claudefix by Hardwick Software" at bottom of terminal${RESET}`);
    console.log(`   ${YELLOW}Note: Footer shows on FIRST run regardless (cry me a river 😢)${RESET}`);
    console.log(`   ${DIM}After first run, your preference is respected${RESET}`);
    config.footer = await askYesNo(rl, '   Show footer after first run?', false);
    console.log('');

    config.configured = true;
    config.firstRun = true; // Will be set to false after first actual run

    rl.close();
    // Close TTY if we opened it separately
    if (ttyInput !== process.stdin && ttyInput.destroy) {
      ttyInput.destroy();
    }

    // Save config
    if (saveConfig(config)) {
      console.log(`${GREEN}✓ Configuration saved to ~/.claudefix.json${RESET}`);
    } else {
      console.log(`${YELLOW}⚠ Could not save config - using defaults${RESET}`);
    }

    showSummary(config);

  } catch (e) {
    rl.close();
    if (ttyInput !== process.stdin && ttyInput.destroy) {
      ttyInput.destroy();
    }
    console.log(`${RED}Error during configuration: ${e.message}${RESET}`);
    console.log(`${DIM}Using defaults - run 'claudefix --config' to try again${RESET}`);
  }
}

function showSummary(config) {
  console.log('');
  console.log(`${BOLD}${CYAN}═══ Your Configuration ═══${RESET}`);
  console.log('');
  console.log(`  Memory Limit:      ${config.memoryLimit ? GREEN + '✓ ON (' + (config.memPercent || 35) + '% RAM)' : RED + '✗ OFF'}${RESET}`);
  console.log(`  CPU Limit:         ${config.cpuPercent > 0 ? GREEN + '✓ ON (' + config.cpuPercent + '%)' : YELLOW + '○ OFF (no limit)'}${RESET}`);
  console.log(`  Color Fix:         ${config.colorStripping ? GREEN + '✓ ON' : RED + '✗ OFF'}${RESET}`);
  console.log(`  Dark Mode:         ${config.darkMode ? GREEN + '✓ ON' : RED + '✗ OFF'}${RESET}`);
  console.log(`  Scrollback Clear:  ${config.scrollbackClear ? GREEN + '✓ ON' : RED + '✗ OFF'}${RESET}`);
  console.log(`  Resize Debounce:   ${config.resizeDebounce ? GREEN + '✓ ON' : RED + '✗ OFF'}${RESET}`);
  console.log(`  Footer:            ${config.footer ? GREEN + '✓ ON' : YELLOW + '✓ First run only'}${RESET}`);
  console.log('');
  console.log(`${BOLD}${CYAN}═══ Usage ═══${RESET}`);
  console.log('');
  console.log(`  ${GREEN}claude-fixed${RESET}        Run Claude with your configured fixes`);
  console.log(`  ${GREEN}claudefix --setup${RESET}   Install as system 'claude' command`);
  console.log(`  ${GREEN}claudefix --config${RESET}  Re-run this configurator`);
  console.log(`  ${GREEN}claudefix --status${RESET}  Check installation status`);
  console.log('');
  console.log(`${DIM}Config file: ~/.claudefix.json${RESET}`);
  console.log(`${DIM}Override any setting with environment variables:${RESET}`);
  console.log(`${DIM}  CLAUDEFIX_NO_FOOTER=1, CLAUDE_STRIP_BG_COLORS=0, etc.${RESET}`);
  console.log('');
}

// Run configurator
runConfigurator().catch(e => {
  console.error(`${RED}[claudefix] Error: ${e.message}${RESET}`);
});
