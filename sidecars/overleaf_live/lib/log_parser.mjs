const FILE_EXT_RE =
  /\.(?:tex|sty|cls|bib|bbl|aux|clo|def|cfg|fd|ldf|toc|lof|lot|out|nav|snm|vrb|tikz|pgf|idx|ind|gls|acr|log)$/i;

const SYSTEM_PATH_RE =
  /^(?:\/usr\/|\/opt\/|\/var\/|\/etc\/|\/Library\/|[A-Za-z]:\/(?:texlive|miktex|Program Files))/i;

const TEXMF_RE = /(?:^|\/)(?:texlive|texmf(?:-dist|-local|-var)?|miktex)\//i;

export function normalizeLogPath(rawPath) {
  let p = String(rawPath ?? '').trim().replace(/\\/g, '/');
  p = p.replace(/^\/compile\/(?:\.\/)?/, '');
  p = p.replace(/^\/app\/(?:\.\/)?/, '');
  p = p.replace(/^(?:\.\/)+/, '');

  const isAbs = p.startsWith('/') || /^[A-Za-z]:\//.test(p);
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  if (p.startsWith('/') && !parts[0]?.match(/^[A-Za-z]:$/)) {
    return '/' + parts.join('/');
  }
  return isAbs ? parts.join('/') : parts.join('/');
}

function isProjectFile(rawPath) {
  const norm = normalizeLogPath(rawPath);
  if (!norm) return false;
  if (SYSTEM_PATH_RE.test(norm) || TEXMF_RE.test(norm)) return false;
  if (norm.startsWith('/') && !/^\/(?:compile|app)\//.test(rawPath.replace(/\\/g, '/'))) {
    // Generic absolute OS path outside sandbox (e.g. /etc, /tmp, etc. vs relative)
    if (/\.(?:aux|log|out|toc|bbl|fdb_latexmk|fls)$/i.test(norm)) return false;
    return false;
  }
  return true;
}

function isLikelyFileToken(token) {
  if (!token || token.length < 2) return false;
  if (token === '..' || token === '.') return false;
  if (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(token)
  ) {
    return !/^\/+$/.test(token);
  }
  return FILE_EXT_RE.test(token);
}

function getActiveFile(stack) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].isFile && stack[i].isProject) {
      return stack[i].file;
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].isFile) {
      return stack[i].file;
    }
  }
  return null;
}

function isErrorContextLine(line) {
  return (
    /^!\s/.test(line) ||
    /^l\.\d+/.test(line) ||
    /^<\*?>/.test(line) ||
    /^<recently read>/.test(line) ||
    /^<argument>/.test(line) ||
    /^<to be read again>/.test(line) ||
    /^<inserted text>/.test(line) ||
    /^<template>/.test(line)
  );
}

function scanParens(line, stack) {
  if (!line || isErrorContextLine(line)) return;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') {
      const rest = line.slice(i + 1);
      if (rest.startsWith('"')) {
        const endQuote = rest.indexOf('"', 1);
        if (endQuote > 1) {
          const rawPath = rest.slice(1, endQuote);
          if (isLikelyFileToken(rawPath)) {
            stack.push({
              isFile: true,
              file: normalizeLogPath(rawPath),
              isProject: isProjectFile(rawPath),
            });
            i += endQuote + 1;
            continue;
          }
        }
      }

      const spacedExtMatch = rest.match(
        /^((?:\.?\.?\/|[A-Za-z]:[\\/])[^\s()]+(?:\s+[^\s()]+)*?\.(?:tex|sty|cls|bib|bbl|aux|clo|def|cfg|fd|ldf|toc|lof|lot|out|nav|snm|vrb|tikz|pgf))(?=$|\s|\))/i
      );
      if (spacedExtMatch) {
        const rawPath = spacedExtMatch[1];
        stack.push({
          isFile: true,
          file: normalizeLogPath(rawPath),
          isProject: isProjectFile(rawPath),
        });
        i += rawPath.length;
        continue;
      }

      const tokMatch = rest.match(/^([^\s()]+)/);
      if (tokMatch && isLikelyFileToken(tokMatch[1])) {
        const rawPath = tokMatch[1];
        stack.push({
          isFile: true,
          file: normalizeLogPath(rawPath),
          isProject: isProjectFile(rawPath),
        });
        i += rawPath.length;
        continue;
      }

      stack.push({ isFile: false });
    } else if (ch === ')') {
      if (stack.length > 0) {
        stack.pop();
      }
    }
  }
}

const FILE_LINE_ERROR_RE =
  /^((?:[A-Za-z]:)?[^:\n]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/;
const CLASSIC_ERROR_RE = /^!\s*(.+)$/;
const LINE_NUM_RE = /^l\.(\d+)\s*(.*)$/;
const WARNING_START_RE =
  /^(?:(LaTeX(?:\s+Font)?\s+Warning):\s*(.+)|(Package\s+([^\s]+)\s+Warning):\s*(.+)|(Class\s+([^\s]+)\s+Warning):\s*(.+))$/;
const STANDALONE_REF_WARN_RE =
  /^((?:Citation|Reference)\s+.+?\s+undefined.*)$/i;
const BADBOX_RE = /^((?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s+.*)$/;

function isNewRecordStart(line) {
  return (
    CLASSIC_ERROR_RE.test(line) ||
    FILE_LINE_ERROR_RE.test(line) ||
    WARNING_START_RE.test(line) ||
    STANDALONE_REF_WARN_RE.test(line) ||
    BADBOX_RE.test(line) ||
    /^\(\.?\.?\//.test(line) ||
    /^\(\//.test(line) ||
    /^\[\d+/.test(line)
  );
}

function extractWarningLine(msg) {
  const m =
    msg.match(/on input line\s+(\d+)/i) || msg.match(/at lines?\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function extractBadboxLine(msg) {
  const rangeMatch = msg.match(/at lines?\s+(\d+)\s*--\s*(\d+)/i);
  if (rangeMatch) return parseInt(rangeMatch[1], 10);
  const singleMatch =
    msg.match(/at line\s+(\d+)/i) || msg.match(/on input line\s+(\d+)/i);
  return singleMatch ? parseInt(singleMatch[1], 10) : null;
}

export function parseLatexLog(logText) {
  const normalized = String(logText ?? '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) {
    return {
      errors: [],
      warnings: [],
      badboxes: [],
      summary: {
        errorCount: 0,
        warningCount: 0,
        badboxCount: 0,
        ok: true,
      },
    };
  }

  const lines = normalized.split('\n');
  const stack = [];
  const errors = [];
  const warnings = [];
  const badboxes = [];

  let pendingError = null;
  let pendingErrorAge = 0;
  let lastLineWasErrorSnippet = false;

  const flushPendingError = () => {
    if (pendingError) {
      errors.push(pendingError);
      pendingError = null;
      pendingErrorAge = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Rejoin 79-char wrapped file-open lines before scanning parens
    if (
      line.length >= 78 &&
      /\((?:\.?\.?\/|\/)[^\s()]*$/.test(line) &&
      i + 1 < lines.length &&
      /^[^\s()]+/.test(lines[i + 1]) &&
      !isNewRecordStart(lines[i + 1])
    ) {
      const nextLine = lines[i + 1];
      const nextTok = nextLine.match(/^([^\s()]+)/);
      if (nextTok && FILE_EXT_RE.test(nextTok[1])) {
        line = line + nextLine;
        i++;
      }
    }

    if (lastLineWasErrorSnippet) {
      // TeX prints a second indented line immediately after `l.<n> ...` showing remaining input;
      // avoid scanning unmatched parens inside that snippet line.
      lastLineWasErrorSnippet = false;
      if (/^\s+\S/.test(line) && !isNewRecordStart(line)) {
        if (pendingError) {
          pendingErrorAge++;
          if (pendingErrorAge > 15) flushPendingError();
        }
        continue;
      }
    }

    const activeFileBeforeScan = getActiveFile(stack);
    scanParens(line, stack);
    const activeFile = getActiveFile(stack) || activeFileBeforeScan;

    // 1. Check `l.<n>` line matching for an open pending error
    const lineNumMatch = line.match(LINE_NUM_RE);
    if (lineNumMatch && pendingError) {
      if (pendingError.line === null) {
        pendingError.line = parseInt(lineNumMatch[1], 10);
      }
      if (!pendingError.snippet) {
        pendingError.snippet = lineNumMatch[2].trim();
      }
      flushPendingError();
      lastLineWasErrorSnippet = true;
      continue;
    }

    if (pendingError) {
      pendingErrorAge++;
      if (pendingErrorAge > 15) {
        flushPendingError();
      }
    }

    // 2. Classic TeX error: `^! ...`
    const classicErrMatch = line.match(CLASSIC_ERROR_RE);
    if (classicErrMatch) {
      flushPendingError();
      pendingError = {
        severity: 'error',
        file: activeFile,
        line: null,
        message: classicErrMatch[1].trim(),
        snippet: '',
      };
      pendingErrorAge = 0;
      continue;
    }

    // 3. `file:line: error` style
    const fileLineMatch = line.match(FILE_LINE_ERROR_RE);
    if (fileLineMatch) {
      flushPendingError();
      pendingError = {
        severity: 'error',
        file: normalizeLogPath(fileLineMatch[1]),
        line: parseInt(fileLineMatch[2], 10),
        message: fileLineMatch[3].trim(),
        snippet: '',
      };
      pendingErrorAge = 0;
      continue;
    }

    // 4. LaTeX / Package / Class warnings
    const warnMatch = line.match(WARNING_START_RE);
    if (warnMatch) {
      flushPendingError();
      const prefix = warnMatch[1] || warnMatch[3] || warnMatch[6];
      const pkgOrClass = warnMatch[4] || warnMatch[7] || null;
      const bodyParts = [
        (warnMatch[2] || warnMatch[5] || warnMatch[8] || '').trim(),
      ];

      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (!nextLine.trim()) break;
        if (isNewRecordStart(nextLine)) break;

        let cont = null;
        if (pkgOrClass) {
          const pkgContRe = new RegExp(
            `^\\(${pkgOrClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*(.+)$`
          );
          const pm = nextLine.match(pkgContRe);
          if (pm) {
            cont = pm[1].trim();
          }
        }
        if (cont === null && /^\(LaTeX\)\s*(.+)$/.test(nextLine)) {
          cont = nextLine.replace(/^\(LaTeX\)\s*/, '').trim();
        }
        if (cont === null && /^\s+\S/.test(nextLine)) {
          cont = nextLine.trim();
        }
        if (
          cont === null &&
          /\b(?:on input line|on page|at line)\s*$/i.test(
            bodyParts[bodyParts.length - 1]
          ) &&
          /^\d+\.?/.test(nextLine)
        ) {
          cont = nextLine.trim();
        }

        if (cont === null) break;
        i++;
        scanParens(nextLine, stack);
        bodyParts.push(cont);
      }

      const fullBody = bodyParts.filter(Boolean).join(' ');
      const fullMessage = `${prefix}: ${fullBody}`;
      warnings.push({
        severity: 'warning',
        file: activeFile,
        line: extractWarningLine(fullMessage),
        message: fullMessage,
        snippet: '',
      });
      continue;
    }

    // 5. Standalone Citation / Reference undefined warnings
    const refWarnMatch = line.match(STANDALONE_REF_WARN_RE);
    if (refWarnMatch) {
      flushPendingError();
      const bodyParts = [refWarnMatch[1].trim()];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (!nextLine.trim() || isNewRecordStart(nextLine)) break;
        if (
          /^\s+\S/.test(nextLine) ||
          (/\b(?:on input line|on page)\s*$/i.test(
            bodyParts[bodyParts.length - 1]
          ) &&
            /^\d+\.?/.test(nextLine))
        ) {
          i++;
          scanParens(nextLine, stack);
          bodyParts.push(nextLine.trim());
        } else {
          break;
        }
      }
      const fullMessage = bodyParts.join(' ');
      warnings.push({
        severity: 'warning',
        file: activeFile,
        line: extractWarningLine(fullMessage),
        message: fullMessage,
        snippet: '',
      });
      continue;
    }

    // 6. Overfull / Underfull \hbox / \vbox badboxes
    const badboxMatch = line.match(BADBOX_RE);
    if (badboxMatch) {
      flushPendingError();
      const msgParts = [badboxMatch[1].trim()];
      let snippet = '';

      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (
          /^\s+(?:in paragraph|detected|has occurred)/.test(nextLine) &&
          !isNewRecordStart(nextLine)
        ) {
          i++;
          scanParens(nextLine, stack);
          msgParts.push(nextLine.trim());
        }
      }

      if (i + 1 < lines.length) {
        const candSnippet = lines[i + 1];
        if (/^(?:\[\]|\\(?:OT1|T1|TU|OML|OMS|U)\/)/.test(candSnippet)) {
          i++;
          scanParens(candSnippet, stack);
          snippet = candSnippet.trim();
        }
      }

      const fullMessage = msgParts.join(' ');
      badboxes.push({
        severity: 'badbox',
        file: activeFile,
        line: extractBadboxLine(fullMessage),
        message: fullMessage,
        snippet,
      });
    }
  }

  flushPendingError();

  return {
    errors,
    warnings,
    badboxes,
    summary: {
      errorCount: errors.length,
      warningCount: warnings.length,
      badboxCount: badboxes.length,
      ok: errors.length === 0,
    },
  };
}
