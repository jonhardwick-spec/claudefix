#!/usr/bin/env node
/**
 * claudefix interactive installer
 * Asks permission before doing anything - no sneaky stuff
 *
 * Developed by Hardwick Software Services @ https://justcalljon.pro
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const readline = require('readline');

const VERSIONS_DIR = path.join(os.homedir(), '.local/share/claude/versions');
const isRoot = process.getuid && process.getuid() === 0;

// Colors for terminal output
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function log(color, msg) {
  console.log(`${color}[claudefix]${RESET} ${msg}`);
}

/**
 * Find install locations based on user type and platform
 */
function getInstallLocations() {
  const locations = [];
  const isMac = process.platform === 'darwin';

  if (isRoot) {
    // Root user - can install to system paths
    locations.push({ path: '/usr/local/bin/claude', desc: 'system-wide (all users)' });
    if (!isMac) {
      locations.push({ path: '/usr/bin/claude', desc: 'system bin' });
    }
  }

  // Always offer user-local install
  const localBin = path.join(os.homedir(), '.local/bin/claude');
  locations.push({ path: localBin, desc: 'user-local (~/.local/bin)' });

  // macOS: also check Homebrew location
  if (isMac) {
    const brewBin = '/opt/homebrew/bin/claude';
    if (fs.existsSync(path.dirname(brewBin))) {
      locations.push({ path: brewBin, desc: 'Homebrew (Apple Silicon)' });
    }
  }

  return locations;
}

/**
 * Generate the wrapper script - node script that calls claude-fixed
 * Works with both npm Claude and native Claude installs on Linux AND macOS
 */
function generateWrapper() {
  return `#!/usr/bin/env node
/**
 * claudefix wrapper - fixes memory leaks & screen glitches
 * Supports Linux and macOS
 * Developed by Hardwick Software Services @ https://justcalljon.pro
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const VERSIONS_DIR = path.join(os.homedir(), '.local/share/claude/versions');

// Find claudefix wherever npm installed it
function findClaudefix() {
  const candidates = [
    '/usr/lib/node_modules/claudefix/bin/claude-fixed.js',
    '/usr/local/lib/node_modules/claudefix/bin/claude-fixed.js',
    // Homebrew (macOS)
    '/opt/homebrew/lib/node_modules/claudefix/bin/claude-fixed.js',
    path.join(os.homedir(), '.npm-global/lib/node_modules/claudefix/bin/claude-fixed.js'),
    path.join(os.homedir(), 'node_modules/claudefix/bin/claude-fixed.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
const CLAUDEFIX_SCRIPT = findClaudefix();

const TOTAL_MB = Math.floor(os.totalmem() / 1024 / 1024);
const MAX_HEAP = Math.floor(TOTAL_MB * 0.35);

function findClaude() {
  // Check versions directory first
  if (fs.existsSync(VERSIONS_DIR)) {
    try {
      const versions = fs.readdirSync(VERSIONS_DIR)
        .filter(v => /^\\d+\\.\\d+\\.\\d+$/.test(v))
        .sort((a, b) => {
          const [aMaj, aMin, aPat] = a.split('.').map(Number);
          const [bMaj, bMin, bPat] = b.split('.').map(Number);
          return bMaj - aMaj || bMin - aMin || bPat - aPat;
        });
      if (versions.length) return path.join(VERSIONS_DIR, versions[0]);
    } catch {}
  }
  // Fallback: check common binary locations
  const fallbacks = [
    path.join(os.homedir(), '.local/bin/claude-original'),
    '/usr/local/bin/claude-original',
    '/opt/homebrew/bin/claude-original',
  ];
  for (const f of fallbacks) {
    if (fs.existsSync(f)) return f;
  }
  console.error('No Claude binary found'); process.exit(1);
}

const bin = findClaude();
const supported = process.platform === 'linux' || process.platform === 'darwin';
const disabled = process.env.CLAUDEFIX_DISABLED === '1';

if (!supported || disabled || !CLAUDEFIX_SCRIPT) {
  const c = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });
  c.on('exit', code => process.exit(code || 0));
} else {
  process.env.CLAUDE_REAL_BINARY = bin;
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=' + MAX_HEAP;
  try { require(CLAUDEFIX_SCRIPT); }
  catch (e) {
    const c = spawn(bin, process.argv.slice(2), {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=' + MAX_HEAP }
    });
    c.on('exit', code => process.exit(code || 0));
  }
}
`;
}

/**
 * Ask user a yes/no question
 */
function askQuestion(question) {
  return new Promise((resolve) => {
    // Check if we're in a TTY - if not, skip interactive mode
    if (!process.stdin.isTTY) {
      log(YELLOW, 'Non-interactive mode detected. Run "claudefix --setup" manually to install wrapper.');
      resolve(false);
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

/**
 * Main installer
 */
async function main() {
  console.log('');
  console.log(`${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  ${BOLD}claudefix${RESET} - Memory Leak & Screen Glitch Fix for Claude Code  ${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}║${RESET}  Developed by Hardwick Software @ https://justcalljon.pro     ${CYAN}║${RESET}`);
  console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log('');

  // Check if Claude is installed (native or npm)
  const npmClaudePaths = [
    '/usr/lib/node_modules/@anthropic-ai/claude-code',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
    path.join(os.homedir(), '.npm-global/lib/node_modules/@anthropic-ai/claude-code'),
  ];
  const hasNativeClaude = fs.existsSync(VERSIONS_DIR);
  const hasNpmClaude = npmClaudePaths.some(p => fs.existsSync(p));

  if (!hasNativeClaude && !hasNpmClaude) {
    log(YELLOW, 'Claude not installed yet. Install Claude first, then run: claudefix --setup');
    log(CYAN, 'Native: https://docs.anthropic.com/claude-code');
    log(CYAN, 'NPM: npm install -g @anthropic-ai/claude-code');
    process.exit(0);
  }

  log(GREEN, `Detected Claude: ${hasNativeClaude ? 'Native' : ''}${hasNativeClaude && hasNpmClaude ? ' + ' : ''}${hasNpmClaude ? 'NPM' : ''}`);
  console.log('');

  // Show what we'll do
  log(CYAN, 'This will create a wrapper script that:');
  console.log('    1. Limits V8 heap to 35% of RAM (prevents memory leaks)');
  console.log('    2. Strips background colors that cause VTE glitches');
  console.log('    3. Adds a footer with hotkey to open our website');
  console.log('');

  const locations = getInstallLocations();

  log(CYAN, `Running as: ${isRoot ? 'root (system install available)' : 'non-root user (local install only)'}`);
  console.log('');

  // Explain options clearly
  if (isRoot) {
    console.log(`${BOLD}${YELLOW}  INSTALL OPTIONS:${RESET}`);
    console.log(`${GREEN}  [y]${RESET} Install to /usr/local/bin (affects all users)`);
    console.log(`${CYAN}  [n]${RESET} Skip wrapper install, use 'claude-fixed' command instead`);
    console.log('');
    console.log(`${YELLOW}  Don't want system-wide install?${RESET}`);
    console.log(`  Press N and just use the 'claude-fixed' command directly.`);
    console.log(`  Same fix, no system changes. Your call.`);
  } else {
    console.log(`${BOLD}${GREEN}  NON-ROOT INSTALL:${RESET}`);
    console.log(`  Will install to: ~/.local/bin/claude`);
    console.log(`  This only affects YOUR user account, not the whole system.`);
    console.log('');
    console.log(`${CYAN}  [y]${RESET} Install wrapper to ~/.local/bin`);
    console.log(`${CYAN}  [n]${RESET} Skip, use 'claude-fixed' command instead`);
  }
  console.log('');

  // Ask for permission
  const proceed = await askQuestion(`${YELLOW}[claudefix]${RESET} Install wrapper? [y/N] `);

  if (!proceed) {
    console.log('');
    log(GREEN, 'No problem! You can use "claude-fixed" command instead.');
    log(CYAN, 'Just run: claude-fixed');
    log(CYAN, 'Same exact fix, no wrapper needed.');
    console.log('');
    log(CYAN, 'To install the wrapper later: claudefix --setup');
    process.exit(0);
  }

  // Install to first available location
  let installed = false;
  const wrapper = generateWrapper();
  const isMac = process.platform === 'darwin';

  for (const loc of locations) {
    try {
      const dir = path.dirname(loc.path);

      // Create directory if needed
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log(GREEN, `Created directory: ${dir}`);
      }

      // Check write permission
      fs.accessSync(dir, fs.constants.W_OK);

      // Remove immutable flag if exists (Linux only, macOS uses different flags)
      if (!isMac) {
        try {
          execSync(`chattr -i "${loc.path}" 2>/dev/null`, { stdio: 'pipe' });
        } catch (e) {}
      }

      // Back up original claude binary if it exists and isn't already our wrapper
      if (fs.existsSync(loc.path)) {
        try {
          const content = fs.readFileSync(loc.path, 'utf8').slice(0, 500);
          if (!content.includes('claudefix') && !content.includes('Hardwick')) {
            const backupPath = loc.path + '-original';
            if (!fs.existsSync(backupPath)) {
              // If it's a symlink, preserve the symlink target
              const stat = fs.lstatSync(loc.path);
              if (stat.isSymbolicLink()) {
                const target = fs.readlinkSync(loc.path);
                fs.symlinkSync(target, backupPath);
              } else {
                fs.copyFileSync(loc.path, backupPath);
                fs.chmodSync(backupPath, 0o755);
              }
              log(GREEN, `✓ Backed up original: ${backupPath}`);
            }
          }
        } catch (e) {
          log(YELLOW, `Could not backup ${loc.path}: ${e.message}`);
        }
      }

      // Write wrapper (NOT immutable)
      // Remove existing file/symlink first
      try { fs.unlinkSync(loc.path); } catch {}
      fs.writeFileSync(loc.path, wrapper, { mode: 0o755 });
      log(GREEN, `✓ Installed to: ${loc.path}`);

      // Also ensure ~/.local/bin/claude points to this wrapper
      // This is critical for screen sessions which resolve ~/.local/bin first
      const localClaude = path.join(os.homedir(), '.local', 'bin', 'claude');
      if (loc.path !== localClaude && fs.existsSync(localClaude)) {
        try {
          const stat = fs.lstatSync(localClaude);
          if (stat.isSymbolicLink()) {
            const target = fs.readlinkSync(localClaude);
            if (!target.includes('claudefix')) {
              // Back up the original symlink target
              const localBackup = localClaude + '-original';
              if (!fs.existsSync(localBackup)) {
                fs.symlinkSync(target, localBackup);
                log(GREEN, `✓ Backed up: ${localBackup} -> ${target}`);
              }
              fs.unlinkSync(localClaude);
              fs.symlinkSync(loc.path, localClaude);
              log(GREEN, `✓ Symlinked: ${localClaude} -> ${loc.path}`);
            }
          }
        } catch (e) {
          log(YELLOW, `Could not symlink ${localClaude}: ${e.message}`);
        }
      }

      installed = true;
      break; // Only install to first successful location
    } catch (e) {
      log(YELLOW, `Skipped ${loc.path}: ${e.message}`);
    }
  }

  if (installed) {
    console.log('');
    log(GREEN, '✓ Installation complete!');
    log(CYAN, 'The "claude" command now runs through claudefix.');
    log(CYAN, 'To disable: CLAUDEFIX_DISABLED=1 claude');
    log(CYAN, 'To uninstall: claudefix --uninstall');
    if (isMac) {
      log(CYAN, 'macOS Terminal.app and iTerm2 are both supported.');
    }
  } else {
    log(RED, 'Could not install to any location.');
    log(YELLOW, 'You can still use "claude-fixed" command directly.');
  }
}

// Run if called directly or as postinstall
main().catch(e => {
  log(RED, `Error: ${e.message}`);
  process.exit(1);
});
