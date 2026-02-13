'use strict';

/**
 * claudescreenfix-hardwicksoftware - stops the scroll glitch from cooking your terminal
 *
 * the problem:
 *   claude code uses ink (react for terminals) and it dont clear scrollback
 *   so after like 30 min your terminal got thousands of lines in the buffer
 *   every re-render touches ALL of em - O(n) where n keeps growing
 *   resize events fire with no debounce so tmux/screen users get cooked
 *
 * what we do:
 *   - hook stdout.write to inject scrollback clears periodically
 *   - debounce SIGWINCH so resize aint thrashing
 *   - enhance /clear to actually clear scrollback not just the screen
 *
 * FIXED v1.0.1: typing issue where stdin echo was being intercepted
 *   - now detects stdin echo writes and passes them through unmodified
 *   - uses setImmediate for periodic clears to not interrupt typing
 *   - tracks "active typing" window to defer clears during input
 *
 * NEW v2.2.0: headless/VNC mode
 *   - auto-detects Xvfb/VNC/headless environments
 *   - strips BACKGROUND colors that cause VTE rendering glitches
 *   - keeps foreground colors and spinners working perfectly
 *   - your Zesting still zests, just no broken color blocks
 */


const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_SAVE = '\x1b[s';
const CURSOR_RESTORE = '\x1b[u';
const CLEAR_SCREEN = '\x1b[2J';
const HOME_CURSOR = '\x1b[H';

// regex patterns for ANSI sequences we want to strip
// background colors + inverse video (which swaps FG to BG) + dim
const ANSI_BG_PATTERNS = [
  /\x1b\[48;5;\d+m/g,           // 256-color background: \x1b[48;5;XXXm
  /\x1b\[48;2;\d+;\d+;\d+m/g,   // true color background: \x1b[48;2;R;G;Bm
  /\x1b\[4[0-7]m/g,             // standard background colors: \x1b[40m - \x1b[47m
  /\x1b\[10[0-7]m/g,            // bright background colors: \x1b[100m - \x1b[107m
  /\x1b\[7m/g,                  // inverse video - swaps FG/BG, causes same glitch
  /\x1b\[27m/g,                 // inverse off (no-op but clean it up)
  /\x1b\[49m/g,                 // default background color
  /\x1b\[2m/g,                  // dim attribute - makes text grey, causes glitches
  /\x1b\[22m/g,                 // dim off (normal intensity)
];

// more aggressive stripping for compound sequences
// handles cases like \x1b[0;48;5;236m or \x1b[1;7m
function stripCompoundBgCodes(str) {
  // strip 48;5;XXX and 48;2;R;G;B from compound sequences
  str = str.replace(/(\x1b\[[0-9;]*)48;5;\d+(;?)/g, '$1$2');
  str = str.replace(/(\x1b\[[0-9;]*)48;2;\d+;\d+;\d+(;?)/g, '$1$2');
  // strip background params (4X where X is 0-7 or 9)
  str = str.replace(/(\x1b\[[0-9;]*)(;?)(4[0-79])(;?)([0-9;]*m)/g, (match, pre, sep1, bg, sep2, post) => {
    // reconstruct without the background code
    let params = pre.slice(2); // remove \x1b[
    if (sep2 && post) params += post;
    else if (!post.endsWith('m')) params += 'm';
    if (params === 'm' || params === ';m') return '\x1b[0m';
    return '\x1b[' + params.replace(/^;+/, '').replace(/;+$/, '').replace(/;;+/g, ';');
  });
  // strip bright backgrounds 10X
  str = str.replace(/(\x1b\[[0-9;]*)(;?)(10[0-7])(;?)([0-9;]*m)/g, (match, pre, sep1, bg, sep2, post) => {
    let params = pre.slice(2);
    if (sep2 && post) params += post;
    else if (!post.endsWith('m')) params += 'm';
    if (params === 'm' || params === ';m') return '\x1b[0m';
    return '\x1b[' + params.replace(/^;+/, '').replace(/;+$/, '').replace(/;;+/g, ';');
  });
  // strip inverse (7) and dim (2) from compound sequences
  str = str.replace(/(\x1b\[[0-9;]*)(;?)(7|2)(;)([0-9;]+m)/g, '$1$5');
  str = str.replace(/(\x1b\[[0-9;]+)(;)(7|2)(m)/g, '$1m');
  return str;
}

// supported terminals - only run fix on these
const SUPPORTED_TERMINALS = [
  'xterm', 'xterm-256color', 'xterm-color',
  'screen', 'screen-256color',
  'tmux', 'tmux-256color',
  'linux', 'vt100', 'vt220',
  'rxvt', 'rxvt-unicode', 'rxvt-unicode-256color',
  'gnome', 'gnome-256color',
  'konsole', 'konsole-256color',
];

function isTerminalSupported() {
  const term = process.env.TERM || '';
  // check exact match or prefix match
  return SUPPORTED_TERMINALS.some(t => term === t || term.startsWith(t + '-'));
}

// config - tweak these if needed
const config = {
  resizeDebounceMs: 150,        // how long to wait before firing resize
  periodicClearMs: 60000,       // clear scrollback every 60s
  clearAfterRenders: 500,       // or after 500 render cycles
  typingCooldownMs: 500,        // wait this long after typing to clear
  debug: process.env.CLAUDE_TERMINAL_FIX_DEBUG === '1',
  disabled: process.env.CLAUDE_TERMINAL_FIX_DISABLED === '1',
  stripBgColors: process.env.CLAUDE_STRIP_BG_COLORS !== '0', // always strip bg colors, disable with =0
  stripColors: process.env.CLAUDE_STRIP_COLORS !== '0', // strip by default, disable with =0
};

// state tracking
let renderCount = 0;
let lastResizeTime = 0;
let resizeTimeout = null;
let originalWrite = null;
let installed = false;
let lastTypingTime = 0;           // track when user last typed
let pendingClear = false;         // defer clear if typing active
let clearIntervalId = null;

function log(...args) {
  if (config.debug) {
    process.stderr.write('[terminal-fix] ' + args.join(' ') + '\n');
  }
}


/**
 * strip BACKGROUND colors from output
 * keeps foreground colors, cursor movement, and everything else
 * fixes VTE rendering glitches where BG colors overlay text
 */
function stripBackgroundColors(chunk) {
  if (typeof chunk !== 'string') return chunk;

  let result = chunk;

  // first pass: strip simple bg patterns
  for (const pattern of ANSI_BG_PATTERNS) {
    result = result.replace(pattern, '');
  }

  // second pass: handle compound sequences like \x1b[0;48;5;236m
  result = stripCompoundBgCodes(result);

  // cleanup: remove empty/malformed sequences
  result = result.replace(/\x1b\[;*m/g, '\x1b[0m'); // \x1b[;m -> \x1b[0m
  result = result.replace(/\x1b\[m/g, '\x1b[0m');   // \x1b[m -> \x1b[0m

  return result;
}

/**
 * check if user is actively typing (within cooldown window)
 */
function isTypingActive() {
  return (Date.now() - lastTypingTime) < config.typingCooldownMs;
}

/**
 * detect if this looks like a stdin echo (single printable char or short sequence)
 * stdin echoes are typically: single chars, backspace sequences, arrow key echoes
 */
function isStdinEcho(chunk) {
  // single printable character (including space)
  if (chunk.length === 1 && chunk.charCodeAt(0) >= 32 && chunk.charCodeAt(0) <= 126) {
    return true;
  }
  // backspace/delete echo (usually 1-3 chars with control codes)
  if (chunk.length <= 4 && (chunk.includes('\b') || chunk.includes('\x7f'))) {
    return true;
  }
  // arrow key echo or cursor movement (short escape sequences)
  if (chunk.length <= 6 && chunk.startsWith('\x1b[') && !chunk.includes('J') && !chunk.includes('H')) {
    return true;
  }
  // enter/newline
  if (chunk === '\n' || chunk === '\r' || chunk === '\r\n') {
    return true;
  }
  return false;
}

/**
 * safe clear - defers if typing active
 */
function safeClearScrollback() {
  if (isTypingActive()) {
    if (!pendingClear) {
      pendingClear = true;
      log('deferring clear - typing active');
      setTimeout(() => {
        pendingClear = false;
        if (!isTypingActive()) {
          safeClearScrollback();
        }
      }, config.typingCooldownMs);
    }
    return;
  }

  if (originalWrite && process.stdout.isTTY) {
    // use setImmediate to not block the event loop
    setImmediate(() => {
      log('executing deferred scrollback clear');
      originalWrite(CURSOR_SAVE + CLEAR_SCROLLBACK + CURSOR_RESTORE);
    });
  }
}

/**
 * installs the fix - hooks into stdout and sigwinch
 * call this once at startup, calling again is a no-op
 */
function install() {
  if (installed || config.disabled) {
    if (config.disabled) log('disabled via env var');
    return;
  }

  // only run on supported terminals
  if (!isTerminalSupported()) {
    log('terminal not supported: ' + (process.env.TERM || 'unknown') + ' - skipping install');
    return;
  }

  originalWrite = process.stdout.write.bind(process.stdout);

  // track stdin to know when user is typing
  if (process.stdin.isTTY) {
    process.stdin.on('data', () => {
      lastTypingTime = Date.now();
    });
  }

  // hook stdout.write - this is where the magic happens
  process.stdout.write = function(chunk, encoding, callback) {
    // CRITICAL FIX: pass stdin echoes through unmodified
    // this prevents the typing issue where keystrokes get lost
    if (typeof chunk === 'string') {
      // check if this is a stdin echo - if so, pass through immediately
      if (isStdinEcho(chunk)) {
        lastTypingTime = Date.now();  // update typing time
        return originalWrite(chunk, encoding, callback);
      }

      renderCount++;

      // strip colors that cause VTE rendering glitches
      if (config.stripBgColors) {
        chunk = stripBackgroundColors(chunk);
      }

      // ink clears screen before re-render, we piggyback on that
      // but only if not actively typing
      if (chunk.includes(CLEAR_SCREEN) || chunk.includes(HOME_CURSOR)) {
        if (config.clearAfterRenders > 0 && renderCount >= config.clearAfterRenders) {
          if (!isTypingActive()) {
            log('clearing scrollback after ' + renderCount + ' renders');
            renderCount = 0;
            chunk = CLEAR_SCROLLBACK + chunk;
          } else {
            log('skipping render-based clear - typing active');
          }
        }
      }

      // /clear command should actually clear everything (immediate, user-requested)
      if (chunk.includes('Conversation cleared') || chunk.includes('Chat cleared')) {
        log('/clear detected, nuking scrollback');
        chunk = CLEAR_SCROLLBACK + chunk;
      }
    }

    return originalWrite(chunk, encoding, callback);
  };

  // debounce resize events - tmux users know the pain
  installResizeDebounce();

  // periodic cleanup so long sessions dont get cooked
  // uses safeClearScrollback which respects typing activity
  if (config.periodicClearMs > 0) {
    clearIntervalId = setInterval(() => {
      log('periodic clear check');
      safeClearScrollback();
    }, config.periodicClearMs);
  }

  installed = true;
  const mode = config.stripBgColors ? 'bg+dim colors stripped' : 'all colors preserved';
  log('installed successfully - v2.3.1 - ' + mode + ' - TERM=' + process.env.TERM);
}

function installResizeDebounce() {
  const originalOn = process.on.bind(process);
  let sigwinchHandlers = [];

  function debouncedSigwinch() {
    const now = Date.now();
    const timeSince = now - lastResizeTime;
    lastResizeTime = now;

    if (resizeTimeout) clearTimeout(resizeTimeout);

    // if events coming too fast, batch em
    if (timeSince < config.resizeDebounceMs) {
      resizeTimeout = setTimeout(() => {
        log('firing debounced resize');
        sigwinchHandlers.forEach(h => { try { h(); } catch(e) {} });
      }, config.resizeDebounceMs);
    } else {
      sigwinchHandlers.forEach(h => { try { h(); } catch(e) {} });
    }
  }

  process.on = function(event, handler) {
    if (event === 'SIGWINCH') {
      sigwinchHandlers.push(handler);
      if (sigwinchHandlers.length === 1) {
        originalOn('SIGWINCH', debouncedSigwinch);
      }
      return this;
    }
    return originalOn(event, handler);
  };

  log('resize debounce installed');
}

/**
 * manually clear scrollback - call this whenever you want
 */
function clearScrollback() {
  if (originalWrite) {
    originalWrite(CLEAR_SCROLLBACK);
  } else {
    process.stdout.write(CLEAR_SCROLLBACK);
  }
  log('manual scrollback clear');
}

/**
 * get current stats for debugging
 */
function getStats() {
  return {
    renderCount,
    lastResizeTime,
    installed,
    config
  };
}

/**
 * update config at runtime
 */
function setConfig(key, value) {
  if (key in config) {
    config[key] = value;
    log('config updated: ' + key + ' = ' + value);
  }
}

/**
 * disable the fix (mostly for testing)
 */
function disable() {
  if (originalWrite) {
    process.stdout.write = originalWrite;
    log('disabled');
  }
}

module.exports = {
  install,
  clearScrollback,
  getStats,
  setConfig,
  disable,
  stripColors: stripBackgroundColors,
  config
};
