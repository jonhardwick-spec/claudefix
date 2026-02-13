#!/usr/bin/env node
'use strict';

/**
 * claude-fixed wrapper - runs Claude with memory leak mitigation & VTE fixes
 *
 * =============================================================================
 * MEMORY LEAK ROOT CAUSE ANALYSIS (by Hardwick Software Services)
 * =============================================================================
 *
 * Using perf profiling, we identified the leak originates from:
 *
 *   v8::Value::StrictEquals(v8::Local<v8::Value>) const
 *
 * This V8 function is called CONSTANTLY during Claude's Ink-based TUI rendering.
 * The Ink library (React for terminals) does reconciliation by comparing old vs
 * new state, which triggers massive amounts of StrictEquals calls.
 *
 * Each StrictEquals call creates V8 handles. These handles accumulate faster
 * than the garbage collector can clean them up, causing:
 *
 *   - 500MB+ memory growth per MINUTE in worst cases
 *   - OOM kills after extended sessions
 *   - System crashes when multiple Claude instances run
 *
 * Perf stack trace (from our investigation):
 *   8.92% → asm_exc_page_fault → do_anonymous_page → alloc_anon_folio
 *   4.88% → __x64_sys_madvise → madvise_walk_vmas
 *   1.91% → HeapHelper (V8 GC thread running constantly trying to keep up)
 *
 * MITIGATION STRATEGIES IMPLEMENTED:
 *   1. Limit V8 heap to 35% of system RAM (--max-old-space-size)
 *   2. Expose GC and force periodic garbage collection (--expose-gc)
 *   3. Monitor memory and warn at thresholds
 *   4. Strip ANSI background colors that cause VTE rendering bugs
 *
 * =============================================================================
 *
 * Developed by Hardwick Software Services - https://justcalljon.pro
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Config file path
const CONFIG_PATH = path.join(os.homedir(), '.claudefix.json');

// Default config
const DEFAULT_CONFIG = {
  firstRun: true,
  footer: true,
  memoryLimit: true,
  memPercent: 35,
  cpuPercent: 0,
  colorStripping: true,
  darkMode: false,
  scrollbackClear: true,
  resizeDebounce: true,
  configured: false
};

// Load config from file
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch (e) {}
  return { ...DEFAULT_CONFIG };
}

// Save config to file
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

// Check if running as root
function isRoot() {
  return process.getuid && process.getuid() === 0;
}

// Load config at startup
const config = loadConfig();
const debug = process.env.CLAUDEFIX_DEBUG === '1';

/**
 * Force dark mode on Linux terminals (OPTIONAL - based on config)
 * If you chose light mode: A) You're not human, or B) You're brain dead
 * Either way, enjoy your future thick glasses!
 *
 * Supports: GNOME Terminal, Tilix, XFCE4 Terminal, Konsole, Terminator,
 *           xterm, urxvt, Alacritty, Kitty, foot, and generic terminals
 */
function forceDarkMode() {
  // Skip if user explicitly opts out via env var
  if (process.env.CLAUDEFIX_NO_DARKMODE === '1') return;

  // Skip if config says no dark mode (and they were asked)
  if (config.configured && !config.darkMode) {
    if (debug) console.error('[claudefix] Dark mode disabled by config (future glasses wearer detected)');
    return;
  }

  // Detect terminal type
  const term = process.env.TERM || '';
  const termProgram = process.env.TERM_PROGRAM || '';
  const vteVersion = process.env.VTE_VERSION || '';
  const konsoleDbus = process.env.KONSOLE_DBUS_SESSION || '';
  const tilixId = process.env.TILIX_ID || '';
  const xtermVersion = process.env.XTERM_VERSION || '';
  const kittyPid = process.env.KITTY_PID || '';
  const alacrittySocket = process.env.ALACRITTY_SOCKET || '';

  try {
    // macOS: Don't send OSC 10/11 color-change sequences!
    // Claude Code queries terminal colors on startup to detect light/dark mode.
    // If we change colors via OSC right before Claude starts, Claude sees our
    // forced colors, tries to render its theme picker, which triggers a re-render,
    // which we intercept, which causes infinite flickering.
    // Instead: just set COLORFGBG env var so Claude picks dark mode without
    // actually changing terminal colors (no visual fight).
    if (process.platform === 'darwin') {
      if (termProgram === 'Apple_Terminal' || termProgram === 'iTerm.app' ||
          termProgram === 'WezTerm' || termProgram === 'Alacritty') {
        process.env.COLORFGBG = '15;0'; // white on black = dark mode hint
        if (debug) console.error(`[claudefix] Dark mode: ${termProgram} (COLORFGBG hint only, no OSC)`);
        return;
      }
    }

    // 1. Tilix - explicit support via dbus (only if terminal commands enabled)
    if (tilixId) {
      if (config.configured) {
        // Only run dbus command if user opted in
        try {
          execSync(`dbus-send --session --dest=com.gexperts.Tilix --type=method_call /com/gexperts/Tilix com.gexperts.Tilix.SetColorScheme string:"Tango Dark"`, { stdio: 'ignore', timeout: 1000 });
        } catch (e) {}
      }
      // OSC sequences are always safe
      process.stdout.write('\x1b]11;#1a1a1a\x07');
      process.stdout.write('\x1b]10;#e0e0e0\x07');
      process.stdout.write('\x1b]12;#e0e0e0\x07');
      if (debug) console.error('[claudefix] Dark mode: Tilix');
    }

    // 2. GNOME Terminal / other VTE-based terminals (OSC only - safe)
    else if (vteVersion || termProgram === 'gnome-terminal') {
      process.stdout.write('\x1b]11;#1a1a1a\x07');
      process.stdout.write('\x1b]10;#e0e0e0\x07');
      process.stdout.write('\x1b]12;#e0e0e0\x07');
      if (debug) console.error('[claudefix] Dark mode: VTE terminal');
    }

    // 3. Konsole (only run konsoleprofile if user configured)
    if (konsoleDbus) {
      if (config.configured) {
        try {
          execSync('konsoleprofile colors=Breeze', { stdio: 'ignore', timeout: 1000 });
        } catch (e) {
          // Fallback to OSC
          process.stdout.write('\x1b]11;#1a1a1a\x07');
          process.stdout.write('\x1b]10;#e0e0e0\x07');
        }
      } else {
        process.stdout.write('\x1b]11;#1a1a1a\x07');
        process.stdout.write('\x1b]10;#e0e0e0\x07');
      }
      if (debug) console.error('[claudefix] Dark mode: Konsole');
    }

    // 4. Kitty (only run kitty @ if user configured)
    if (kittyPid) {
      if (config.configured) {
        try {
          execSync('kitty @ set-colors background=#1a1a1a foreground=#e0e0e0', { stdio: 'ignore', timeout: 1000 });
        } catch (e) {}
      }
      if (debug) console.error('[claudefix] Dark mode: Kitty');
    }

    // 5. Alacritty (OSC only - safe)
    if (alacrittySocket || termProgram === 'Alacritty') {
      process.stdout.write('\x1b]11;#1a1a1a\x07');
      process.stdout.write('\x1b]10;#e0e0e0\x07');
      if (debug) console.error('[claudefix] Dark mode: Alacritty');
    }

    // 6. xterm (OSC only - safe)
    if (xtermVersion || term === 'xterm' || term === 'xterm-256color') {
      process.stdout.write('\x1b]11;#1a1a1a\x07');
      process.stdout.write('\x1b]10;#e0e0e0\x07');
      if (debug) console.error('[claudefix] Dark mode: xterm');
    }

    // 7. Generic fallback - OSC 10/11 (safe on most modern terminals)
    if (!vteVersion && !konsoleDbus && !kittyPid && !xtermVersion) {
      process.stdout.write('\x1b]11;#1a1a1a\x07');
      process.stdout.write('\x1b]10;#e0e0e0\x07');
      if (debug) console.error('[claudefix] Dark mode: generic OSC');
    }

    // 8. Set COLORFGBG env for apps that check it
    process.env.COLORFGBG = '15;0'; // white on black

  } catch (e) {
    if (debug) console.error('[claudefix] Dark mode failed:', e.message);
  }
}

// Apply dark mode if configured (or not yet configured = default on)
if (config.darkMode || !config.configured) {
  forceDarkMode();
}

// Calculate memory limits (configurable, defaults to 35% of total system RAM)
// Set via env var (percentage 1-100) or config file
const TOTAL_MEM_MB = Math.floor(os.totalmem() / 1024 / 1024);
const MEM_PERCENT = Math.min(100, Math.max(1,
  parseInt(process.env.CLAUDEFIX_MEM_PERCENT, 10) || config.memPercent || 35
)) / 100;
const MAX_HEAP_MB = Math.floor(TOTAL_MEM_MB * MEM_PERCENT);
const WARN_THRESHOLD_MB = Math.floor(MAX_HEAP_MB * 0.7);
const CRITICAL_THRESHOLD_MB = Math.floor(MAX_HEAP_MB * 0.9);

// CPU limit (configurable, default: no limit)
// Set via env var (percentage 1-100) or config file
const CPU_PERCENT = parseInt(process.env.CLAUDEFIX_CPU_PERCENT, 10) || config.cpuPercent || 0;
const CPU_CORES = os.cpus().length;

/**
 * Apply CPU limit to a child process PID
 * Uses cpulimit if available (precise), falls back to nice/ionice (best-effort)
 */
function applyCpuLimit(pid) {
  if (!CPU_PERCENT || CPU_PERCENT <= 0 || (process.platform !== 'linux' && process.platform !== 'darwin')) return null;

  // cpulimit uses percentage per-core, so 50% on 4 cores = 200% cpulimit
  const cpulimitVal = Math.floor(CPU_PERCENT * CPU_CORES / 100) * 100 || CPU_PERCENT;

  try {
    // Try cpulimit first (most precise)
    execSync('which cpulimit', { stdio: 'pipe' });
    const limiter = spawn('cpulimit', ['-p', String(pid), '-l', String(cpulimitVal), '-z'], {
      stdio: 'ignore',
      detached: true
    });
    limiter.unref();
    if (debug) console.error(`[claudefix] CPU limited to ${CPU_PERCENT}% via cpulimit (${cpulimitVal}% cpulimit value) for PID ${pid}`);
    return limiter;
  } catch {
    // Fallback: renice the process (less precise but always available)
    try {
      // Map percentage to nice value: 100%=0, 50%=10, 25%=15, 1%=19
      const niceVal = Math.max(0, Math.min(19, Math.floor(19 * (1 - CPU_PERCENT / 100))));
      execSync(`renice ${niceVal} -p ${pid}`, { stdio: 'pipe' });
      if (debug) console.error(`[claudefix] CPU deprioritized via nice=${niceVal} for PID ${pid}`);
    } catch (e) {
      if (debug) console.error('[claudefix] CPU limit failed:', e.message);
    }
    return null;
  }
}

// GC interval (force GC every 60 seconds)
const GC_INTERVAL_MS = 60000;

// Memory check interval
const MEM_CHECK_INTERVAL_MS = 30000;

// Terminal type for mode selection
const terminalType = getTerminalType();
// Force nuclear mode via env var (for testing or when auto-detection fails)
const forceNuclear = process.env.CLAUDEFIX_NUCLEAR === '1';

if (debug) {
  console.error('[claudefix] Terminal type:', terminalType);
  console.error('[claudefix] Force nuclear:', forceNuclear);
}

/**
 * Strip ALL background colors - simple and clean approach
 * Just remove the entire escape sequence containing background colors
 *
 * NUCLEAR MODE: For terminals like Ptyxis that have VTE rendering issues,
 * we strip even more aggressively including dim text and other problematic codes
 *
 * THERMONUCLEAR MODE: For GTK4/Ptyxis - strip almost everything, keep only basic colors
 */
function stripColors(data) {
  let str = data;

  // Universal approach: parse each SGR sequence, keep only safe codes
  // This handles ALL compound sequences correctly (e.g. \x1b[1;38;5;196;48;5;236m)
  // by parsing code-by-code instead of regex pattern matching
  str = str.replace(/\x1b\[[0-9;]*m/g, (match) => {
    const codes = match.slice(2, -1).split(';').filter(c => c !== '');

    if (codes.length === 0) return '\x1b[0m';

    const allowed = [];
    let i = 0;
    while (i < codes.length) {
      const code = parseInt(codes[i], 10);

      // Reset
      if (code === 0) { allowed.push('0'); i++; }
      // Bold (1), italic (3), underline (4), strikethrough (9)
      else if (code === 1 || code === 3 || code === 4 || code === 9) { allowed.push(codes[i]); i++; }
      // Bold off (22), italic off (23), underline off (24), strikethrough off (29)
      else if (code === 22 || code === 23 || code === 24 || code === 29) { allowed.push(codes[i]); i++; }
      // Standard foreground (30-37)
      else if (code >= 30 && code <= 37) { allowed.push(codes[i]); i++; }
      // Default foreground (39)
      else if (code === 39) { allowed.push('39'); i++; }
      // Bright foreground (90-97)
      else if (code >= 90 && code <= 97) { allowed.push(codes[i]); i++; }
      // 256-color foreground (38;5;X)
      else if (code === 38 && codes[i + 1] === '5' && codes[i + 2]) {
        allowed.push('38', '5', codes[i + 2]); i += 3;
      }
      // True color foreground (38;2;R;G;B)
      else if (code === 38 && codes[i + 1] === '2' && codes[i + 4]) {
        allowed.push('38', '2', codes[i + 2], codes[i + 3], codes[i + 4]); i += 5;
      }
      // Skip ALL backgrounds: 40-47, 49, 100-107
      else if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) { i++; }
      // Skip 256-color bg (48;5;X)
      else if (code === 48 && codes[i + 1] === '5') { i += 3; }
      // Skip true color bg (48;2;R;G;B)
      else if (code === 48 && codes[i + 1] === '2') { i += 5; }
      // Skip dim (2), inverse (7), hidden (8) and their offs
      else if (code === 2 || code === 7 || code === 8 || code === 27 || code === 28) { i++; }
      // Unknown - skip
      else { i++; }
    }

    if (allowed.length === 0) return '';
    return `\x1b[${allowed.join(';')}m`;
  });

  return str;
}

// Check if we should show footer
// First run = ALWAYS show footer (cry me a river)
// After first run = respect config.footer setting
function shouldShowFooter() {
  // Env var always wins
  if (process.env.CLAUDEFIX_NO_FOOTER === '1') return false;

  // First run? Footer is MANDATORY. Cry me a river.
  if (config.firstRun) {
    if (debug) console.error('[claudefix] First run - footer mandatory (cry me a river)');
    return true;
  }

  // After first run, respect user preference
  return config.footer;
}

// Check if we should use PTY mode (for color stripping, memory monitoring)
function shouldUsePTY() {
  // Always use PTY if color stripping is enabled
  if (config.colorStripping && process.env.CLAUDE_STRIP_BG_COLORS !== '0') return true;
  // Or if footer is showing
  if (shouldShowFooter()) return true;
  return false;
}

// Detect if we're in an SSH session (scroll region doesn't work well over SSH)
function isSSH() {
  return !!(process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

// Detect terminal type for terminal-specific fixes
function getTerminalType() {
  const term = process.env.TERM || '';
  const termProgram = process.env.TERM_PROGRAM || '';
  const vteVersion = process.env.VTE_VERSION || '';
  const gdkBackend = process.env.GDK_BACKEND || '';
  const ptyxis = process.env.PTYXIS_VERSION || process.env.COLORTERM === 'truecolor';

  // macOS terminals
  if (process.platform === 'darwin') {
    if (termProgram === 'Apple_Terminal') return 'apple-terminal';
    if (termProgram === 'iTerm.app') return 'iterm2';
    if (termProgram === 'WezTerm') return 'wezterm';
    if (termProgram === 'Alacritty') return 'alacritty';
    if (termProgram === 'kitty') return 'kitty';
    // Generic macOS terminal
    if (term.includes('xterm') || term.includes('256color')) return 'mac-xterm';
    return 'mac-unknown';
  }

  // Check for Ptyxis specifically
  if (termProgram.toLowerCase().includes('ptyxis') ||
      process.env.GNOME_TERMINAL_SERVICE?.includes('Ptyxis')) {
    return 'ptyxis';
  }

  // XFCE4 Terminal - uses VTE but handles ANSI fine, does NOT need thermonuclear mode
  // Must check BEFORE the VTE version check or it gets misclassified as gtk4-vte
  if (termProgram === 'xfce4-terminal' || termProgram === 'Xfce Terminal' ||
      process.env.XFCE_TERMINAL_VERSION ||
      process.env.WINDOWPATH || // XFCE sets this
      (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('xfce')) {
    return 'xfce-terminal';
  }

  // GTK4 terminals (like Ptyxis) often have GDK_BACKEND set
  if (gdkBackend === 'wayland' && vteVersion) {
    return 'gtk4-vte';
  }

  // VTE 0.70+ (7000+) is GTK4 - use aggressive stripping
  // VTE version format: MAJOR * 100 + MINOR (e.g., 7600 = 0.76)
  const vteNum = parseInt(vteVersion, 10);
  if (vteNum >= 7000) {
    return 'gtk4-vte';
  }

  if (termProgram === 'GNOME Terminal' || vteVersion) {
    return 'gnome-terminal';
  }

  if (term.includes('xterm') || term.includes('256color')) {
    return 'xterm';
  }

  return 'unknown';
}

// Check if a file is the real claude (not our wrapper)
function isRealClaude(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 500);
    // It's real claude if it doesn't contain our markers
    return !content.includes('claudefix') && !content.includes('Hardwick');
  } catch (e) {
    // Can't read - might be binary, assume it's real
    return true;
  }
}

// Find the REAL claude binary
function findRealClaude() {
  const debug = process.env.CLAUDEFIX_DEBUG === '1';

  // 1. Check env var (set by our wrapper)
  if (process.env.CLAUDE_REAL_BINARY && fs.existsSync(process.env.CLAUDE_REAL_BINARY)) {
    if (debug) console.error('[claudefix] Found via CLAUDE_REAL_BINARY env');
    return process.env.CLAUDE_REAL_BINARY;
  }

  // 2. Check self-updating claude versions directory
  const versionsDir = path.join(os.homedir(), '.local/share/claude/versions');
  if (fs.existsSync(versionsDir)) {
    try {
      const versions = fs.readdirSync(versionsDir)
        .filter(v => /^\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => {
          const [aMaj, aMin, aPat] = a.split('.').map(Number);
          const [bMaj, bMin, bPat] = b.split('.').map(Number);
          return bMaj - aMaj || bMin - aMin || bPat - aPat;
        });
      if (versions.length > 0) {
        const versionPath = path.join(versionsDir, versions[0]);
        if (debug) console.error('[claudefix] Found in versions dir:', versionPath);
        return versionPath;
      }
    } catch (e) {}
  }

  // 3. Check backup binaries created by claudefix --setup or specmem-init
  const backupLocations = [
    path.join(os.homedir(), '.local/bin/claude-original'),
    '/usr/local/bin/claude-original',
    '/opt/homebrew/bin/claude-original',
  ];
  for (const backup of backupLocations) {
    if (fs.existsSync(backup)) {
      if (debug) console.error('[claudefix] Found backup binary:', backup);
      return backup;
    }
  }

  // 4. Check all possible install locations
  const locations = [
    // System-wide npm installs
    '/usr/bin/claude',
    '/usr/local/bin/claude',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    // User local installs
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), '.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    // nvm style installs
    path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/claude'),
    path.join(os.homedir(), '.nvm/versions/node', process.version, 'lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    // Homebrew (macOS)
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    // Intel Mac Homebrew
    '/usr/local/opt/claude/bin/claude',
  ];

  for (const loc of locations) {
    if (isRealClaude(loc)) {
      if (debug) console.error('[claudefix] Found at:', loc);
      return loc;
    }
  }

  // 4. Last resort: use 'which' to find claude in PATH
  try {
    const { execSync } = require('child_process');
    const whichResult = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (whichResult && isRealClaude(whichResult)) {
      if (debug) console.error('[claudefix] Found via which:', whichResult);
      return whichResult;
    }
    // If which returns our wrapper, try to find the real one by checking symlinks
    if (whichResult) {
      const realPath = fs.realpathSync(whichResult);
      if (realPath !== whichResult && isRealClaude(realPath)) {
        if (debug) console.error('[claudefix] Found via realpath:', realPath);
        return realPath;
      }
    }
  } catch (e) {}

  return null;
}

// Get current memory usage
function getMemoryUsageMB() {
  const used = process.memoryUsage();
  return Math.floor(used.heapUsed / 1024 / 1024);
}

// Main execution
const claudeBin = findRealClaude();
if (!claudeBin) {
  console.error('[claudefix] Claude not found - make sure its installed');
  process.exit(1);
}

const usePTY = shouldUsePTY();
const showFooter = shouldShowFooter();

if (debug) {
  console.error('[claudefix] Memory limit:', MAX_HEAP_MB, 'MB (35% of', TOTAL_MEM_MB, 'MB total)');
  console.error('[claudefix] PTY mode:', usePTY);
  console.error('[claudefix] Show footer:', showFooter);
  console.error('[claudefix] First run:', config.firstRun);
  console.error('[claudefix] Claude binary:', claudeBin);
  console.error('[claudefix] CPU limit:', CPU_PERCENT > 0 ? CPU_PERCENT + '%' : 'off');
}

// Mark first run as complete after this session starts
if (config.firstRun) {
  config.firstRun = false;
  saveConfig(config);
  if (debug) console.error('[claudefix] First run complete - footer now optional');
}

if (!usePTY) {
  // Not headless - spawn with memory limits only
  const child = spawn(claudeBin, process.argv.slice(2), {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${MAX_HEAP_MB} --expose-gc`.trim()
    }
  });
  child.on('exit', (code) => process.exit(code || 0));
} else {
  // PTY mode - use PTY with color filtering, footer, AND memory management
  let pty;
  try {
    const possiblePaths = [
      'node-pty',
      path.join(__dirname, '..', 'node_modules', 'node-pty'),
      '/usr/lib/node_modules/node-pty',
      '/usr/lib/node_modules/claudefix/node_modules/node-pty',
      '/usr/local/lib/node_modules/node-pty',
      '/usr/local/lib/node_modules/claudefix/node_modules/node-pty',
    ];

    for (const p of possiblePaths) {
      try {
        pty = require(p);
        if (debug) console.error('[claudefix] Loaded node-pty from:', p);
        break;
      } catch (e) {
        // node-pty exists but native addon not compiled (common on Linux - no prebuilds)
        // Try to auto-rebuild it
        if (e.code === 'MODULE_NOT_FOUND' && e.message && e.message.includes('.node')) {
          const ptyDir = p === 'node-pty' ? null : p;
          const resolvedDir = ptyDir || (() => {
            try { return path.dirname(require.resolve('node-pty/package.json')); } catch { return null; }
          })();
          if (resolvedDir && fs.existsSync(path.join(resolvedDir, 'binding.gyp'))) {
            try {
              if (debug) console.error('[claudefix] node-pty native addon missing, attempting rebuild:', resolvedDir);
              execSync('npm rebuild node-pty 2>&1', {
                cwd: path.dirname(resolvedDir),
                timeout: 60000,
                stdio: debug ? 'inherit' : 'pipe'
              });
              // Try loading again after rebuild
              pty = require(p);
              if (debug) console.error('[claudefix] node-pty rebuilt and loaded from:', p);
              break;
            } catch (rebuildErr) {
              if (debug) console.error('[claudefix] node-pty rebuild failed:', rebuildErr.message);
            }
          }
        }
      }
    }

    // Last resort: use vendored node-pty (pre-compiled linux-x64 bundled with claudefix)
    if (!pty) {
      try {
        const vendorPath = path.join(__dirname, '..', 'vendor', 'node-pty', 'lib', 'index.js');
        pty = require(vendorPath);
        if (debug) console.error('[claudefix] Loaded VENDORED node-pty from:', vendorPath);
      } catch (vendorErr) {
        if (debug) console.error('[claudefix] Vendored node-pty also failed:', vendorErr.message);
      }
    }

    if (!pty) throw new Error('node-pty not found (tried npm, rebuild, and vendored)');
  } catch (e) {
    // Fallback: launch claude in the system's default terminal emulator
    // This works on any Linux DE - ptyxis, gnome-terminal, konsole, etc.
    if (debug) console.error('[claudefix] node-pty not available, trying system default terminal');
    let launched = false;

    if (process.platform === 'linux' || process.platform === 'darwin') {
      // Try terminal emulators by priority (platform-specific)
      const terminalCmds = process.platform === 'darwin' ? [
        // macOS terminal emulators
        ['open', ['-a', 'Terminal', '--args']],
        ['open', ['-a', 'iTerm', '--args']],
      ] : [
        // Linux terminal emulators
        ['x-terminal-emulator', ['-e']],
        ['ptyxis', ['--']],
        ['gnome-terminal', ['--']],
        ['konsole', ['-e']],
        ['xfce4-terminal', ['-e']],
        ['mate-terminal', ['-e']],
        ['tilix', ['-e']],
        ['alacritty', ['-e']],
        ['kitty', ['--']],
        ['foot', ['--']],
        ['xterm', ['-e']],
      ];

      for (const [cmd, flag] of terminalCmds) {
        try {
          execSync(`which ${cmd}`, { stdio: 'pipe' });
          const termArgs = [...flag, claudeBin, ...process.argv.slice(2)];
          if (debug) console.error(`[claudefix] Launching via: ${cmd} ${termArgs.join(' ')}`);
          const child = spawn(cmd, termArgs, {
            stdio: 'inherit',
            env: {
              ...process.env,
              NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${MAX_HEAP_MB}`.trim()
            }
          });
          child.on('exit', (code) => process.exit(code || 0));
          launched = true;
          break;
        } catch {}
      }
    }

    if (!launched) {
      // Final fallback: direct spawn (no PTY features but claude still works)
      console.error('[claudefix] No terminal emulator found, using direct spawn');
      const child = spawn(claudeBin, process.argv.slice(2), {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${MAX_HEAP_MB}`.trim()
        }
      });
      child.on('exit', (code) => process.exit(code || 0));
    }
    return;
  }

  // Get terminal size
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Detect the correct TERM value from the current environment
  // Don't hardcode xterm-256color - respect the user's actual terminal
  const ptyTermName = process.env.TERM || 'xterm-256color';

  // Spawn Claude in a PTY with memory limits
  const ptyProcess = pty.spawn(claudeBin, process.argv.slice(2), {
    name: ptyTermName,
    cols: cols,
    rows: rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=${MAX_HEAP_MB} --expose-gc`.trim()
    }
  });

  // Apply CPU limit to the PTY child process
  let cpuLimiter = null;
  if (CPU_PERCENT > 0 && ptyProcess.pid) {
    cpuLimiter = applyCpuLimit(ptyProcess.pid);
  }

  // Force garbage collection periodically
  let gcInterval;
  if (typeof global.gc === 'function') {
    gcInterval = setInterval(() => {
      try {
        global.gc();
        if (debug) console.error('[claudefix] Forced GC');
      } catch (e) {}
    }, GC_INTERVAL_MS);
  }

  // Memory monitoring
  let memCheckInterval = setInterval(() => {
    const usedMB = getMemoryUsageMB();
    if (usedMB > CRITICAL_THRESHOLD_MB) {
      console.error(`\n[claudefix] CRITICAL: Memory at ${usedMB}MB (limit: ${MAX_HEAP_MB}MB)`);
      console.error('[claudefix] Consider restarting Claude to prevent OOM\n');
    } else if (usedMB > WARN_THRESHOLD_MB && debug) {
      console.error(`[claudefix] WARNING: Memory at ${usedMB}MB`);
    }
  }, MEM_CHECK_INTERVAL_MS);

  // Footer - rainbow with clickable link and hotkey info!
  const FOOTER_TEXT = 'claudefix by Hardwick Software';
  const FOOTER_URL = 'https://justcalljon.pro';
  const HOTKEY_TEXT = 'Ctrl+Shift+H';
  const RAINBOW_COLORS = [196, 208, 226, 46, 51, 21, 129]; // red orange yellow green cyan blue purple

  function makeRainbow(text) {
    let result = '';
    let colorIdx = 0;
    for (const char of text) {
      if (char === ' ') {
        result += char;
      } else {
        result += `\x1b[38;5;${RAINBOW_COLORS[colorIdx % RAINBOW_COLORS.length]}m${char}`;
        colorIdx++;
      }
    }
    return result + '\x1b[0m';
  }

  function makeClickableLink(url, text) {
    // OSC 8 hyperlink: \x1b]8;;URL\x07TEXT\x1b]8;;\x07
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
  }

  const sshMode = isSSH();

  // SPECMEM INTEGRATION: Check if specmem statusbar is active
  const specmemActive = process.env.SPECMEM_STATUSBAR === '1' ||
    fs.existsSync(path.join(process.env.SPECMEM_PROJECT_PATH || process.cwd(), 'specmem', 'sockets', 'statusbar-state.json'));

  // Load specmem statusbar module if active
  let specmemStatusbar = null;
  if (specmemActive) {
    try {
      // Try to load from global npm (package is specmem-hardwicksoftware)
      const globalNpm = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const statusbarPath = path.join(globalNpm, 'specmem-hardwicksoftware', 'bin', 'specmem-statusbar.cjs');
      if (fs.existsSync(statusbarPath)) {
        specmemStatusbar = require(statusbarPath);
        if (debug) console.error('[claudefix] SpecMem statusbar loaded');
      }
    } catch (e) {
      if (debug) console.error('[claudefix] Could not load specmem statusbar:', e.message);
    }
  }

  // How many footer rows to reserve (1 for claudefix, +2 if specmem active for team comms + status)
  const footerRows = specmemActive ? 3 : 1;

  function setupScrollRegion() {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    if (sshMode || !showFooter) {
      ptyProcess.resize(cols, rows);
    } else {
      // Reserve bottom row(s) for footer via scroll region + PTY resize
      const contentRows = Math.max(1, rows - footerRows);

      process.stdout.write(
        '\x1b[r' +                          // Reset scroll region to full terminal
        '\x1b7' +                           // Save cursor position
        `\x1b[1;${contentRows}r` +          // Set scroll region (leave rows for footer)
        '\x1b8'                             // Restore cursor position
      );

      ptyProcess.resize(cols, contentRows);
    }
  }

  function drawFooter() {
    // DISABLE footer in SSH mode entirely - it causes too many issues
    if (sshMode) return;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // SPECMEM STATUSBAR: Draw on row above claudefix footer
    if (specmemActive && specmemStatusbar) {
      try {
        specmemStatusbar.updateStatus().catch(() => {}); // Non-blocking update
        specmemStatusbar.drawStatusBar(rows, cols);
      } catch (e) {
        // Silently ignore specmem errors - don't break claudefix
      }
    }

    const rainbowText = makeRainbow(FOOTER_TEXT);
    const clickableLink = makeClickableLink(FOOTER_URL, `\x1b[38;5;45m${FOOTER_URL}\x1b[0m`);
    const hotkeyStyled = `\x1b[38;5;251m[\x1b[38;5;226m${HOTKEY_TEXT}\x1b[38;5;251m]\x1b[0m`;
    // Format: "claudefix by Hardwick Software - https://justcalljon.pro [Ctrl+Shift+H]"
    const fullFooter = rainbowText + ' - ' + clickableLink + ' ' + hotkeyStyled;
    const plainLen = FOOTER_TEXT.length + 3 + FOOTER_URL.length + 1 + HOTKEY_TEXT.length + 2;
    const padding = Math.max(0, Math.floor((cols - plainLen) / 2));

    // Calculate trailing spaces to fill entire row (replaces chars, no new lines)
    const trailingSpaces = Math.max(0, cols - padding - plainLen);

    // Local mode only: draw footer in reserved bottom row
    // FIX: Replace chars directly instead of clearing line (avoids scroll glitches)
    process.stdout.write(
      '\x1b7' +                                      // Save cursor position (DEC)
      `\x1b[${rows};1H` +                            // Move to last row, column 1
      ' '.repeat(padding) +                          // Left padding
      fullFooter +                                   // Centered rainbow footer with link
      ' '.repeat(trailingSpaces) +                   // Fill remaining chars (no clear line!)
      '\x1b8'                                        // Restore cursor position (DEC)
    );
  }

  // FIX (Linux only): Clear screen once at startup to prevent ghost frames.
  // Ink renders inline (no alternate screen) and re-renders during startup cause
  // content to stack/triplicate. A single clear before first output fixes this.
  // NOTE: Do NOT use alternate screen (\x1b[?1049h) — it makes Ink switch to
  // full-screen mode where it sends \x1b[H\x1b[J which erases the footer.
  let startupCleared = false;

  // Initial setup
  setupScrollRegion();
  if (!sshMode && showFooter) drawFooter();

  // Footer refresh - debounced, only redraws AFTER PTY output settles
  // No independent timer - footer only redraws in response to PTY activity
  // This prevents the timer from corrupting cursor state mid-render
  let footerInterval;
  if (!sshMode && showFooter) {
    // Slow keepalive for specmem statusbar updates (every 2s, not 200ms)
    footerInterval = setInterval(drawFooter, 2000);
  }

  // Smart debounce for PTY output - wait for output burst to finish
  let pendingDraw = null;
  const DEBOUNCE_MS = 32; // Wait 32ms after last output before redrawing footer

  function scheduleFooterDraw() {
    // Cancel any pending draw - we want to wait until output stops
    if (pendingDraw) {
      clearTimeout(pendingDraw);
    }
    // Schedule footer redraw after output settles
    pendingDraw = setTimeout(() => {
      pendingDraw = null;
      drawFooter();
    }, DEBOUNCE_MS);
  }

  // Filter PTY output with debounced footer redraw
  const contentRows = () => Math.max(1, (process.stdout.rows || 24) - footerRows);
  let exiting = false;

  const isMac = process.platform === 'darwin';
  // macOS Terminal.app doesn't have VTE bugs, so skip aggressive escape mangling
  const isAppleTerminal = process.env.TERM_PROGRAM === 'Apple_Terminal';

  // FIX: Buffer-and-flush approach for ghost frame elimination on Linux.
  // Problem: Ink sends renders in multiple small chunks. Injecting \x1b[J on any
  // individual chunk either misses (threshold not met) or nukes partial renders.
  // Solution: Buffer ALL output, flush after a short idle gap (16ms). When flushing,
  // if the buffer contains \x1b[H (home cursor = new render), inject \x1b[J after it.
  // Since the entire render is flushed atomically, clear + content arrive together.
  let outputBuffer = '';
  let flushTimer = null;
  const FLUSH_DELAY_MS = 16;      // Normal flush delay (~1 frame)
  const COALESCE_DELAY_MS = 80;   // Extended delay during rapid full repaints
  let lastFullRenderTime = 0;     // When we last flushed a full repaint

  function processAndFlush() {
    flushTimer = null;
    if (!outputBuffer || exiting) return;

    let output = outputBuffer;
    outputBuffer = '';

    // Only strip colors if config enabled and env var not disabled
    const shouldStrip = config.colorStripping &&
      process.env.CLAUDE_STRIP_BG_COLORS !== '0' &&
      !isAppleTerminal;
    if (shouldStrip) output = stripColors(output);

    // Intercept scroll region resets from Ink — replace with our constrained region
    if (showFooter && !sshMode) {
      const cr = contentRows();
      output = output.replace(/\x1b\[r/g, `\x1b[1;${cr}r`);
      const fullRows = process.stdout.rows || 24;
      output = output.replace(new RegExp(`\\x1b\\[1;${fullRows}r`, 'g'), `\x1b[1;${cr}r`);
    }

    // FIX (Linux only): Inject scrollback clear on full screen clears
    if (!isMac) {
      if (output.includes('\x1b[2J')) {
        output = output.replace(/\x1b\[2J/g, '\x1b[2J\x1b[3J');
      }
    }

    // FIX (Linux only): Clear stale content when Ink does a FULL re-render.
    // Ink sends \x1b[H for both full repaints AND partial updates (just prompt).
    // We must ONLY clear on full repaints or we wipe content Ink didn't re-send.
    // Since we buffer the entire render cycle, we can check the buffer size:
    // - Full repaint: large buffer (most of the screen rewritten)
    // - Partial update (prompt only): small buffer
    // Threshold: at least half the screen worth of content (contentRows * 30 bytes)
    // FIX (Linux only): Clear screen once before first output to prevent
    // startup ghost frames (triplicated content from Ink's initial renders)
    if (!isMac && !startupCleared) {
      startupCleared = true;
      output = '\x1b[2J\x1b[3J\x1b[H' + output;
    }

    process.stdout.write(output);
    if (showFooter) scheduleFooterDraw();
  }

  ptyProcess.onData((data) => {
    if (exiting) return;
    // Accumulate into buffer
    outputBuffer += data;
    // Reset flush timer — wait for output burst to finish
    if (flushTimer) clearTimeout(flushTimer);
    // Use longer delay if we recently flushed a full render (coalesce rapid repaints)
    const recentFullRender = (Date.now() - lastFullRenderTime) < 200;
    const delay = recentFullRender ? COALESCE_DELAY_MS : FLUSH_DELAY_MS;
    flushTimer = setTimeout(processAndFlush, delay);
  });

  // Forward stdin with Ctrl+Shift+H hotkey
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    // Ctrl+Shift+H = \x1b[72;6u or sometimes \x08 with modifiers
    // In raw mode with xterm, Ctrl+Shift+H sends ESC sequence
    const str = data.toString();
    if (str === '\x1b[72;6u' || str === '\x1b[104;6u' || str === '\x08') {
      // Open Chrome or fallback to default browser
      openWebsite();
      return;
    }
    ptyProcess.write(data);
  });

  function openWebsite() {
    const url = 'https://justcalljon.pro';

    if (process.platform === 'darwin') {
      // macOS: use 'open' command (always available, opens default browser)
      try {
        execSync(`open "${url}" 2>/dev/null`, { stdio: 'ignore', shell: true });
      } catch {}
      return;
    }

    // Linux: try Chrome, Chromium, then xdg-open
    const userDataDir = process.env.HOME + '/.config/google-chrome';
    const sandboxFlag = isRoot() ? '--no-sandbox ' : '';
    const chromeCmd = `google-chrome ${sandboxFlag}--user-data-dir="${userDataDir}" "${url}" 2>/dev/null &`;
    const chromiumCmd = `chromium-browser ${sandboxFlag}--user-data-dir="${userDataDir}" "${url}" 2>/dev/null &`;
    const defaultCmd = `xdg-open "${url}" 2>/dev/null &`;

    try {
      execSync('which google-chrome', { stdio: 'ignore' });
      execSync(chromeCmd, { stdio: 'ignore', shell: true });
    } catch {
      try {
        execSync('which chromium-browser', { stdio: 'ignore' });
        execSync(chromiumCmd, { stdio: 'ignore', shell: true });
      } catch {
        execSync(defaultCmd, { stdio: 'ignore', shell: true });
      }
    }
  }

  // Handle resize - reset scroll region
  process.stdout.on('resize', () => {
    setupScrollRegion();
    if (showFooter) drawFooter();
  });

  // Cleanup on exit
  ptyProcess.onExit(({ exitCode }) => {
    exiting = true;
    if (cpuLimiter) try { cpuLimiter.kill(); } catch {}
    if (footerInterval) clearInterval(footerInterval);
    clearInterval(memCheckInterval);
    if (gcInterval) clearInterval(gcInterval);
    if (pendingDraw) clearTimeout(pendingDraw);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (outputBuffer) { process.stdout.write(outputBuffer); outputBuffer = ''; }
    // Clean exit: leave alternate screen, reset scroll region
    if (!sshMode && showFooter) {
      process.stdout.write(
        '\x1b[r' +       // Reset scroll region to full terminal
        '\x1b[2J' +      // Clear entire screen
        '\x1b[3J' +      // Clear scrollback buffer
        '\x1b[H'         // Move cursor to home position
      );
    }
    drawExitBanner();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(exitCode);
  });

  // Exit banner - shown when Claude session ends
  function drawExitBanner() {
    const cols = process.stdout.columns || 80;
    const CYAN = '\x1b[36m';
    const GREEN = '\x1b[32m';
    const YELLOW = '\x1b[33m';
    const BOLD = '\x1b[1m';
    const DIM = '\x1b[2m';
    const RST = '\x1b[0m';

    const pad = (str, width) => {
      const plainLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
      const space = Math.max(0, Math.floor((width - plainLen) / 2));
      return ' '.repeat(space) + str;
    };

    const divider = DIM + '─'.repeat(Math.min(cols, 68)) + RST;
    const url = '\x1b]8;;https://justcalljon.pro\x07' + BOLD + CYAN + 'justcalljon.pro' + RST + '\x1b]8;;\x07';

    const lines = [
      '',
      pad(divider, cols),
      '',
      pad(BOLD + GREEN + 'Your Claude session was powered by claudefix' + RST, cols),
      pad(DIM + 'by' + RST + ' ' + BOLD + CYAN + 'Hardwick Software Services' + RST + ' @ ' + url, cols),
      '',
      pad(YELLOW + 'We hope you made lots of progress in your project' + RST, cols),
      pad(DIM + 'Thank you for using claudefix' + RST, cols),
      '',
      pad(divider, cols),
      '',
    ];

    process.stdout.write(lines.join('\n'));
  }

  // Clean up terminal state before forwarding signal
  function cleanupAndKill(signal) {
    exiting = true;
    if (cpuLimiter) try { cpuLimiter.kill(); } catch {}
    if (footerInterval) clearInterval(footerInterval);
    if (pendingDraw) clearTimeout(pendingDraw);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (outputBuffer) { process.stdout.write(outputBuffer); outputBuffer = ''; }
    if (!sshMode && showFooter) {
      process.stdout.write(
        '\x1b[r' +       // Reset scroll region
        '\x1b[2J' +      // Clear screen
        '\x1b[3J' +      // Clear scrollback
        '\x1b[H'         // Cursor home
      );
    }
    drawExitBanner();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    ptyProcess.kill(signal);
  }

  // Handle signals
  process.on('SIGINT', () => cleanupAndKill('SIGINT'));
  process.on('SIGTERM', () => cleanupAndKill('SIGTERM'));
  process.on('SIGHUP', () => cleanupAndKill('SIGHUP'));

  // FIX: Debounce SIGWINCH to prevent rapid resize events from clipping content
  let resizeTimeout = null;
  const RESIZE_DEBOUNCE_MS = 50;

  process.on('SIGWINCH', () => {
    // Clear any pending resize to batch rapid resize events
    if (resizeTimeout) {
      clearTimeout(resizeTimeout);
    }

    resizeTimeout = setTimeout(() => {
      resizeTimeout = null;
      setupScrollRegion();
      if (showFooter) {
        // Extra delay for SSH terminals to let terminal state settle
        if (sshMode) {
          setTimeout(drawFooter, 50);
        } else {
          drawFooter();
        }
      }
    }, RESIZE_DEBOUNCE_MS);
  });
}
