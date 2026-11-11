/**
 * Daemon logger.
 *
 * Sink routing:
 *   info / debug  → stdout  (pm2 `out_file` → daemon.log)
 *   warn / error  → stderr  (pm2 `error_file` → error.log)
 *
 * Why split: when everything goes to stderr, pm2's error.log fills with normal
 * operational events ("client ready", "session started", etc.) and real
 * warnings/errors get lost in the noise. Routing info/debug to stdout keeps
 * error.log focused on actionable signals.
 *
 * `debug` is gated behind the DEBUG env var (truthy = on). Use it for
 * critical-node instrumentation that you only need while troubleshooting.
 */
function timestamp(): string {
  return new Date().toISOString();
}

/** Human-readable timestamp in Asia/Shanghai (UTC+8), e.g. "2026-08-24 20:30:35".
 *  Useful for per-message logs where an ISO UTC string is hard to read.
 *  Pass withWeekday=true to append the Chinese weekday, e.g.
 *  "2026-08-24 20:30:35 周一". */
export function formatBeijingTime(date: Date = new Date(), withWeekday = false): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const base = `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  if (!withWeekday) return base;
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' })
    .formatToParts(date)
    .find(p => p.type === 'weekday')?.value ?? '';
  return `${base} ${weekday}`;
}

function fmt(msg: string, args: unknown[]): string {
  const extra = args.length ? ' ' + args.map(a => safeJson(a)).join(' ') : '';
  return `[${timestamp()}] ${msg}${extra}\n`;
}

function safeJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

const DEBUG_ON = !!process.env.DEBUG;

// Sinks for info/debug. Daemon mode: stdout (pm2 out_file → daemon.log).
// CLI mode: stderr (so stdout stays pristine for JSON output even under
// DEBUG=1). warn/error always go to process.stderr.
let infoSink: NodeJS.WriteStream = process.stdout;
let debugSink: NodeJS.WriteStream = process.stdout;
let silent = false;

export const logger = {
  info(msg: string, ...args: unknown[]): void {
    if (silent && !DEBUG_ON) return;
    infoSink.write(fmt(`[INFO] ${msg}`, args));
  },
  warn(msg: string, ...args: unknown[]): void {
    process.stderr.write(fmt(`[WARN] ${msg}`, args));
  },
  error(msg: string, ...args: unknown[]): void {
    process.stderr.write(fmt(`[ERROR] ${msg}`, args));
  },
  debug(msg: string, ...args: unknown[]): void {
    if (!DEBUG_ON) return;
    debugSink.write(fmt(`[DEBUG] ${msg}`, args));
  },
  /** Truthy if DEBUG=1 — callers can use this to skip expensive log-arg
   *  preparation (e.g. JSON.stringify of large objects) when debug is off. */
  isDebug(): boolean {
    return DEBUG_ON;
  },
  /** Switch the logger into CLI mode:
   *   - info/debug become no-ops by default (silent stdout for JSON output).
   *   - DEBUG=1 re-enables info/debug *but routes them to stderr* so that
   *     `DEBUG=1 botmux history` still emits clean JSON on stdout.
   *  warn/error always reach stderr.
   *  Called once by the CLI entrypoint; daemon never calls this. */
  setSilent(s: boolean): void {
    silent = s;
    if (s) {
      infoSink = process.stderr;
      debugSink = process.stderr;
    } else {
      infoSink = process.stdout;
      debugSink = process.stdout;
    }
  },
};
