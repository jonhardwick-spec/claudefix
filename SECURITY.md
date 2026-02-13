# Security Policy

## What This Package Does

claudefix is a PTY wrapper for Claude Code. It intercepts terminal output and:

1. Strips ANSI background color escape sequences that cause VTE rendering bugs
2. Clears scrollback buffer periodically to prevent memory bloat
3. Debounces SIGWINCH resize events to prevent renderer crashes

That is the complete list of things it does.

## What This Package Does NOT Do

- Make network requests of any kind
- Collect telemetry or analytics
- Send data to any remote server
- Modify Claude Code's behavior or API calls
- Access files outside of the Claude binary path
- Store or transmit user data
- Run background processes after Claude exits

## Dependency Tree

```
claudefix
  └── node-pty (official Node.js pseudo-terminal bindings)
```

One production dependency. node-pty is maintained by Microsoft (VS Code uses it).

## Root Access

Root access is **optional**. It is only used when running `sudo npm install -g` to patch Claude's loader script so the `claude` command runs through the PTY wrapper automatically.

Without root, `claude-fixed` works identically - it just requires using the separate command instead of the patched `claude` command.

## Auditing

Every line of source is available in this repository under the MIT license. The total codebase is small enough to read in one sitting.

## Reporting Issues

Open an issue at https://github.com/jonhardwick-spec/claudefix/issues
