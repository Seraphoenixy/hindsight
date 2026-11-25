/**
 * Log level classification for the local-settings log viewer.
 *
 * Parses daemon (Python logging, uvicorn, JSON) and control-plane (Next.js)
 * log lines so each level renders with distinct visual styling and can be
 * filtered by severity.
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "other";

export interface ParsedLogLine {
  line: string;
  level: LogLevel;
  /** Start index of the matched level token in `line`, when present. */
  matchStart?: number;
  /** Exclusive end index of the matched level token in `line`, when present. */
  matchEnd?: number;
}

const PYTHON_LOG_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?\s+-\s+(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b\s*-/;
const UVICORN_LOG_RE = /^(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE):(?:\s|$)/;
const BRACKET_LOG_RE =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?\s+)?\[(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\](?=\s|:|$)/;
const JSON_LEVEL_RE =
  /"(?:severity|level)"\s*:\s*"(CRITICAL|FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)"/i;
const TRACEBACK_RE = /^Traceback \(most recent call last\):/;
const PYTHON_EXCEPTION_RE = /^(?:[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)|ExceptionGroup):/;
const PYTHON_WARNING_RE = /(?:^|:\s+)(?:[A-Za-z_][A-Za-z0-9_.]*Warning|Warning):\s/;
const NEXT_ERROR_RE = /^\s*[✗⨯]\s/;
const CONTINUATION_RE =
  /^(?:\s+|(?:\||The above exception was the direct cause|During handling of the above exception))/;

function normalizeLevel(raw: string): Exclude<LogLevel, "other"> {
  const upper = raw.toUpperCase();
  if (upper === "CRITICAL" || upper === "FATAL" || upper === "ERROR") return "error";
  if (upper === "WARNING" || upper === "WARN") return "warn";
  if (upper === "INFO") return "info";
  return "debug";
}

function matchWithToken(line: string, regex: RegExp): Omit<ParsedLogLine, "line"> | null {
  const match = regex.exec(line);
  if (!match || !match[1]) return null;
  const token = match[1];
  const tokenStart = match.index + match[0].indexOf(token);
  return {
    level: normalizeLevel(token),
    matchStart: tokenStart,
    matchEnd: tokenStart + token.length,
  };
}

/** Detect an explicit log level on a single line, returning null if none is found. */
export function detectExplicitLogLevel(line: string): Omit<ParsedLogLine, "line"> | null {
  const structured =
    matchWithToken(line, PYTHON_LOG_RE) ??
    matchWithToken(line, UVICORN_LOG_RE) ??
    matchWithToken(line, BRACKET_LOG_RE);
  if (structured) return structured;

  if (line.trimStart().startsWith("{")) {
    const jsonMatch = matchWithToken(line, JSON_LEVEL_RE);
    if (jsonMatch) return jsonMatch;
  }

  if (TRACEBACK_RE.test(line) || PYTHON_EXCEPTION_RE.test(line) || NEXT_ERROR_RE.test(line)) {
    return { level: "error" };
  }

  if (PYTHON_WARNING_RE.test(line)) {
    return { level: "warn" };
  }

  return null;
}

/**
 * Parse raw log text into classified lines. Indented/traceback continuation
 * lines inherit `error` or `warn` from the preceding log entry.
 */
export function parseLogLines(text: string): ParsedLogLine[] {
  if (!text) return [];
  const rawLines = text.split(/\r?\n/);
  const parsed: ParsedLogLine[] = [];
  let activeBlockLevel: "error" | "warn" | null = null;

  for (const line of rawLines) {
    const explicit = detectExplicitLogLevel(line);
    if (explicit) {
      activeBlockLevel =
        explicit.level === "error" || explicit.level === "warn" ? explicit.level : null;
      parsed.push({ line, ...explicit });
      continue;
    }

    if (activeBlockLevel && line.length > 0 && CONTINUATION_RE.test(line)) {
      parsed.push({ line, level: activeBlockLevel });
      continue;
    }

    if (line.trim().length === 0) {
      activeBlockLevel = null;
    } else if (!CONTINUATION_RE.test(line)) {
      activeBlockLevel = null;
    }
    parsed.push({ line, level: "other" });
  }

  return parsed;
}

/** Count lines per log level. */
export function countLogLevels(lines: ParsedLogLine[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    other: 0,
  };
  for (const entry of lines) {
    counts[entry.level] += 1;
  }
  return counts;
}
