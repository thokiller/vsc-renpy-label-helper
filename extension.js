const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const CONFIG_SECTION = 'renpyLabelTool';
const SCRIPT_GLOB = '**/*.{rpy,rpym,py}';
const DIAGNOSTIC_SOURCE = "Ren'Py Label Tool";

const IDENTIFIER_PATTERN = /^\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const LABEL_DEFINITION_PATTERN = /^(\s*(?:label|menu)\s+)(\.?[A-Za-z_][A-Za-z0-9_.]*)\s*(?:\([^)]*\))?\s*:/;
const SCREEN_DEFINITION_PATTERN = /^(\s*screen\s+)([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/;
const FUNCTION_DEFINITION_PATTERN = /^(\s*def\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const FUNCTION_CALL_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const FROM_CLAUSE_PATTERN = /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/;
const JUMP_CALL_PATTERN = /(?:^|[:\s])(jump|call)(?=\s)/g;
const SHOW_HIDE_SCREEN_PATTERN = /(?:^|[:\s])(show|hide)\s+screen(?=\s)/g;
const USE_SCREEN_PATTERN = /^\s*use(?=\s)/;

const PYTHON_KEYWORDS = new Set([
  'and', 'assert', 'class', 'def', 'del', 'elif', 'else', 'except', 'exec', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'not', 'or', 'pass', 'print', 'raise',
  'return', 'while', 'with', 'yield'
]);

// Python and screen-action helpers whose first argument is a label or screen name.
const FUNCTION_REFERENCE_PATTERN = /\b(renpy\.jump_out_of_context|renpy\.call_in_new_context|renpy\.call_screen|renpy\.show_screen|renpy\.hide_screen|renpy\.jump|renpy\.call|ShowMenu|Jump|Call|Show|Hide)\s*\(\s*/g;
const FUNCTION_REFERENCE_KINDS = new Map([
  ['renpy.jump', 'label'],
  ['renpy.call', 'label'],
  ['renpy.jump_out_of_context', 'label'],
  ['renpy.call_in_new_context', 'label'],
  ['Jump', 'label'],
  ['Call', 'label'],
  ['renpy.call_screen', 'screen'],
  ['renpy.show_screen', 'screen'],
  ['renpy.hide_screen', 'screen'],
  ['ShowMenu', 'screen'],
  ['Show', 'screen'],
  ['Hide', 'screen']
]);

const TRAILING_CLAUSE_PATTERN = /^(?:with|pass|from|nopredict|onlayer|zorder|as|behind|at|expression)\b/;

const DOCUMENT_SELECTORS = [
  { scheme: 'file', pattern: '**/*.rpy' },
  { scheme: 'file', pattern: '**/*.rpym' },
  { scheme: 'file', pattern: '**/*.py' }
];

let refreshTimer = null;

function activate(context) {
  const state = {
    index: null,
    indexPromise: null,
    indexDirty: true
  };

  const diagnostics = vscode.languages.createDiagnosticCollection('renpyLabelTool');
  const statusButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusButton.command = `${CONFIG_SECTION}.showMissingOverview`;
  statusButton.text = "$(list-selection) Ren'Py Labels";
  statusButton.tooltip = 'Show every jump/call target that does not resolve to a label or screen';
  statusButton.show();

  const insertButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  insertButton.command = `${CONFIG_SECTION}.insertLabel`;
  insertButton.text = "$(symbol-method) Insert Ren'Py Label";
  insertButton.tooltip = 'Search every label in the project and insert its name at the cursor';
  insertButton.show();

  const invalidate = (options = {}) => {
    state.indexDirty = true;
    if (options.immediate) {
      void refreshDiagnostics(state, diagnostics, statusButton);
    } else {
      scheduleRefresh(state, diagnostics, statusButton);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher(SCRIPT_GLOB);
  watcher.onDidCreate(() => invalidate({ immediate: true }));
  watcher.onDidDelete(() => invalidate({ immediate: true }));
  watcher.onDidChange(() => invalidate({ immediate: true }));

  context.subscriptions.push(
    diagnostics,
    statusButton,
    insertButton,
    watcher,
    vscode.languages.registerDefinitionProvider(DOCUMENT_SELECTORS, {
      async provideDefinition(document, position) {
        return resolveDefinition(state, document, position);
      }
    }),
    vscode.languages.registerReferenceProvider(DOCUMENT_SELECTORS, {
      async provideReferences(document, position, referenceContext) {
        return resolveReferences(state, document, position, referenceContext.includeDeclaration);
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTORS,
      {
        async provideCodeActions(document, range, actionContext) {
          return provideCasingFixes(state, document, actionContext);
        }
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.showMissingOverview`, async () => {
      await showMissingOverview(state, diagnostics, statusButton);
    }),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.insertLabel`, async () => {
      await showLabelPicker(state);
    }),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.rescan`, async () => {
      state.indexDirty = true;
      await refreshDiagnostics(state, diagnostics, statusButton);
      vscode.window.showInformationMessage("Ren'Py label index rebuilt.");
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isScriptDocument(event.document)) {
        invalidate();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isScriptDocument(document)) {
        invalidate({ immediate: true });
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isScriptDocument(document)) {
        invalidate();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate({ immediate: true })),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        invalidate({ immediate: true });
      }
    })
  );

  void refreshDiagnostics(state, diagnostics, statusButton);
}

function deactivate() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function isScriptDocument(document) {
  return (
    document
    && document.uri.scheme === 'file'
    && (
      document.fileName.endsWith('.rpy')
      || document.fileName.endsWith('.rpym')
      || document.fileName.endsWith('.py')
    )
  );
}

function getConfig() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    scanRoots: config.get('scanRoots', ['game']),
    excludeGlobs: config.get('excludeGlobs', []),
    checkLabels: config.get('checkLabels', true),
    checkScreens: config.get('checkScreens', true),
    checkExpressionStrings: config.get('checkExpressionStrings', true),
    reportDynamicTargets: config.get('reportDynamicTargets', false),
    ignoredLabels: new Set(config.get('ignoredLabels', [])),
    ignoredScreens: new Set(config.get('ignoredScreens', []))
  };
}

function scheduleRefresh(state, diagnostics, statusButton) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshDiagnostics(state, diagnostics, statusButton);
  }, 400);
}

async function refreshDiagnostics(state, diagnostics, statusButton) {
  const index = await getIndex(state);
  const problems = collectProblems(index);

  diagnostics.clear();
  const byFile = new Map();
  for (const problem of problems) {
    const key = problem.uri.toString();
    if (!byFile.has(key)) {
      byFile.set(key, { uri: problem.uri, items: [] });
    }
    byFile.get(key).items.push(buildDiagnostic(problem));
  }

  for (const entry of byFile.values()) {
    diagnostics.set(entry.uri, entry.items);
  }

  updateStatusButton(statusButton, problems.length);
  return problems;
}

function updateStatusButton(statusButton, problemCount) {
  if (problemCount > 0) {
    statusButton.text = `$(warning) Ren'Py Labels: ${problemCount}`;
    statusButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusButton.text = "$(check) Ren'Py Labels";
    statusButton.backgroundColor = undefined;
  }
}

function buildDiagnostic(problem) {
  const diagnostic = new vscode.Diagnostic(problem.range, problem.message, vscode.DiagnosticSeverity.Warning);
  diagnostic.source = DIAGNOSTIC_SOURCE;
  diagnostic.code = problem.code;
  return diagnostic;
}

function collectProblems(index) {
  const config = index.config;
  const problems = [];

  for (const reference of index.references) {
    if (reference.kind === 'function') {
      continue;
    }
    if (reference.kind === 'label' && !config.checkLabels) {
      continue;
    }
    if (reference.kind === 'screen' && !config.checkScreens) {
      continue;
    }

    if (reference.dynamic) {
      if (config.reportDynamicTargets) {
        problems.push({
          uri: reference.uri,
          range: reference.range,
          message: `The "${reference.statement}" target is computed at runtime and cannot be verified.`,
          code: 'dynamic-target',
          name: reference.raw,
          kind: reference.kind,
          statement: reference.statement
        });
      }
      continue;
    }

    if (reference.fromExpression && !config.checkExpressionStrings) {
      continue;
    }

    const ignored = reference.kind === 'label' ? config.ignoredLabels : config.ignoredScreens;
    if (ignored.has(reference.name)) {
      continue;
    }

    const definitions = reference.kind === 'label' ? index.labels : index.screens;
    if (definitions.has(reference.name)) {
      continue;
    }

    const suggestion = findCaseInsensitiveMatch(definitions, reference.name);
    const kindLabel = reference.kind === 'label' ? 'Label' : 'Screen';
    let message = `${kindLabel} "${reference.name}" does not exist.`;
    if (suggestion) {
      message += ` Ren'Py names are case sensitive; did you mean "${suggestion}"?`;
    }

    problems.push({
      uri: reference.uri,
      range: reference.range,
      message,
      code: reference.kind === 'label' ? 'missing-label' : 'missing-screen',
      name: reference.name,
      kind: reference.kind,
      statement: reference.statement,
      suggestion
    });
  }

  problems.sort((a, b) => {
    const pathCompare = a.uri.fsPath.localeCompare(b.uri.fsPath);
    if (pathCompare !== 0) {
      return pathCompare;
    }
    return a.range.start.line - b.range.start.line;
  });

  return problems;
}

function findCaseInsensitiveMatch(definitions, name) {
  const lowered = name.toLowerCase();
  for (const candidate of definitions.keys()) {
    if (candidate.toLowerCase() === lowered) {
      return candidate;
    }
  }
  return null;
}

async function getIndex(state) {
  if (state.index && !state.indexDirty) {
    return state.index;
  }
  if (state.indexPromise) {
    return state.indexPromise;
  }

  state.indexDirty = false;
  state.indexPromise = buildIndex()
    .then((index) => {
      state.index = index;
      return index;
    })
    .finally(() => {
      state.indexPromise = null;
    });

  return state.indexPromise;
}

async function buildIndex() {
  const config = getConfig();
  const index = {
    config,
    labels: new Map(),
    screens: new Map(),
    functions: new Map(),
    references: [],
    fileCount: 0
  };

  const files = await findScriptFiles(config);
  const openTexts = new Map();
  for (const document of vscode.workspace.textDocuments) {
    if (isScriptDocument(document)) {
      openTexts.set(document.uri.toString(), document.getText());
    }
  }

  for (const uri of files) {
    let text = openTexts.get(uri.toString());
    if (text === undefined) {
      text = await readFileText(uri);
    }
    if (text === null) {
      continue;
    }

    index.fileCount += 1;
    const parsed = parseScript(text);

    for (const definition of parsed.labels) {
      if (!index.labels.has(definition.name)) {
        index.labels.set(definition.name, { uri, line: definition.line });
      }
    }
    for (const definition of parsed.screens) {
      if (!index.screens.has(definition.name)) {
        index.screens.set(definition.name, { uri, line: definition.line });
      }
    }
    for (const definition of parsed.functions) {
      if (!index.functions.has(definition.name)) {
        index.functions.set(definition.name, {
          uri,
          line: definition.line,
          start: definition.start,
          end: definition.end
        });
      }
    }
    for (const reference of parsed.references) {
      index.references.push({
        ...reference,
        uri,
        range: new vscode.Range(reference.line, reference.start, reference.line, reference.end)
      });
    }
  }

  return index;
}

async function readFileText(uri) {
  try {
    const raw = await fs.promises.readFile(uri.fsPath, 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return null;
  }
}

async function findScriptFiles(config) {
  const folders = vscode.workspace.workspaceFolders || [];
  const exclude = config.excludeGlobs.length > 0 ? `{${config.excludeGlobs.join(',')}}` : null;
  const results = new Map();

  for (const folder of folders) {
    for (const root of resolveScanRoots(folder, config.scanRoots)) {
      const pattern = root === '' ? SCRIPT_GLOB : `${root}/${SCRIPT_GLOB}`;
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), exclude);
      for (const uri of found) {
        results.set(uri.toString(), uri);
      }
    }
  }

  return [...results.values()];
}

function resolveScanRoots(folder, scanRoots) {
  const existing = [];
  for (const root of scanRoots) {
    const normalized = root.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) {
      continue;
    }
    const candidate = path.join(folder.uri.fsPath, normalized);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        existing.push(normalized);
      }
    } catch {
      // Root does not exist in this workspace folder.
    }
  }

  return existing.length > 0 ? existing : [''];
}

/**
 * Returns the line without its comment, with string contents blanked out so
 * statement scanning never matches words inside dialogue or docstrings, plus
 * the single-line string literals with their original offsets.
 *
 * `openDelimiter` carries an unterminated triple-quoted string over from the
 * previous line; the returned value must be fed back in for the next line.
 */
function analyzeLine(rawLine, openDelimiter) {
  const masked = rawLine.split('');
  const strings = [];
  let index = 0;
  let cut = rawLine.length;
  let pendingDelimiter = openDelimiter || null;

  if (pendingDelimiter) {
    const closeIndex = rawLine.indexOf(pendingDelimiter);
    const maskEnd = closeIndex === -1 ? rawLine.length : closeIndex + pendingDelimiter.length;
    for (let position = 0; position < maskEnd; position += 1) {
      masked[position] = '\u0000';
    }
    if (closeIndex === -1) {
      return { masked: masked.join(''), strings, openDelimiter: pendingDelimiter };
    }
    pendingDelimiter = null;
    index = maskEnd;
  }

  while (index < rawLine.length) {
    const character = rawLine[index];

    if (character === '#') {
      cut = index;
      break;
    }

    if (character === '"' || character === "'") {
      const triple = rawLine.substr(index, 3);
      if (triple === '"""' || triple === "'''") {
        const closeIndex = rawLine.indexOf(triple, index + 3);
        const maskEnd = closeIndex === -1 ? rawLine.length : closeIndex + 3;
        for (let position = index; position < maskEnd; position += 1) {
          masked[position] = '\u0000';
        }
        if (closeIndex === -1) {
          return { masked: masked.join(''), strings, openDelimiter: triple };
        }
        index = maskEnd;
        continue;
      }

      const quote = character;
      let cursor = index + 1;
      let value = '';
      let terminated = false;

      while (cursor < rawLine.length) {
        if (rawLine[cursor] === '\\') {
          value += rawLine[cursor + 1] === undefined ? '' : rawLine[cursor + 1];
          masked[cursor] = '\u0000';
          if (cursor + 1 < rawLine.length) {
            masked[cursor + 1] = '\u0000';
          }
          cursor += 2;
          continue;
        }
        if (rawLine[cursor] === quote) {
          terminated = true;
          break;
        }
        value += rawLine[cursor];
        masked[cursor] = '\u0000';
        cursor += 1;
      }

      strings.push({
        quoteStart: index,
        contentStart: index + 1,
        contentEnd: Math.min(cursor, rawLine.length),
        value,
        terminated
      });
      index = cursor + 1;
      continue;
    }

    index += 1;
  }

  return {
    masked: masked.slice(0, cut).join(''),
    strings: strings.filter((entry) => entry.quoteStart < cut),
    openDelimiter: null
  };
}

function parseScript(text) {
  const lines = text.split(/\r?\n/);
  const labels = [];
  const screens = [];
  const functions = [];
  const references = [];
  let currentGlobalLabel = null;
  let openDelimiter = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const analyzed = analyzeLine(lines[lineNumber], openDelimiter);
    const { masked, strings } = analyzed;
    openDelimiter = analyzed.openDelimiter;

    if (!masked.trim()) {
      continue;
    }

    const labelMatch = LABEL_DEFINITION_PATTERN.exec(masked);
    if (labelMatch) {
      const rawName = labelMatch[2];
      const start = labelMatch[1].length;
      const position = { line: lineNumber, start, end: start + rawName.length };
      if (rawName.startsWith('.')) {
        if (currentGlobalLabel) {
          labels.push({ name: `${currentGlobalLabel}${rawName}`, ...position });
        }
      } else {
        currentGlobalLabel = rawName;
        labels.push({ name: rawName, ...position });
      }
    }

    const screenMatch = SCREEN_DEFINITION_PATTERN.exec(masked);
    if (screenMatch) {
      screens.push({
        name: screenMatch[2],
        line: lineNumber,
        start: screenMatch[1].length,
        end: screenMatch[1].length + screenMatch[2].length
      });
    }

    const functionMatch = FUNCTION_DEFINITION_PATTERN.exec(masked);
    if (functionMatch) {
      functions.push({
        name: functionMatch[2],
        line: lineNumber,
        start: functionMatch[1].length,
        end: functionMatch[1].length + functionMatch[2].length
      });
    }

    // `call target from _call_x` implicitly defines the return label `_call_x`.
    if (/(?:^|[:\s])call\s/.test(masked)) {
      const fromMatch = FROM_CLAUSE_PATTERN.exec(masked);
      if (fromMatch) {
        const start = masked.indexOf(fromMatch[1], fromMatch.index);
        labels.push({
          name: fromMatch[1],
          line: lineNumber,
          start,
          end: start + fromMatch[1].length
        });
      }
    }

    collectLineReferences(masked, strings, lineNumber, currentGlobalLabel, references);
    if (!functionMatch) {
      collectFunctionCalls(masked, lineNumber, references);
    }
  }

  return { labels, screens, functions, references };
}

function collectFunctionCalls(masked, lineNumber, references) {
  FUNCTION_CALL_PATTERN.lastIndex = 0;
  let match = FUNCTION_CALL_PATTERN.exec(masked);
  while (match) {
    const name = match[1];
    const start = match.index;
    const previous = masked.slice(0, start).trimEnd();

    if (!PYTHON_KEYWORDS.has(name) && !previous.endsWith('class')) {
      references.push({
        kind: 'function',
        statement: 'function call',
        name,
        raw: name,
        line: lineNumber,
        start,
        end: start + name.length,
        fromExpression: false,
        dynamic: false
      });
    }

    match = FUNCTION_CALL_PATTERN.exec(masked);
  }
}

function collectLineReferences(masked, strings, lineNumber, currentGlobalLabel, references) {
  JUMP_CALL_PATTERN.lastIndex = 0;
  let match = JUMP_CALL_PATTERN.exec(masked);
  while (match) {
    const keyword = match[1];
    if (isStatementStart(masked, match.index + match[0].indexOf(keyword))) {
      let cursor = skipSpaces(masked, match.index + match[0].length);
      let kind = 'label';
      let statement = keyword;

      if (matchesWord(masked, cursor, 'screen')) {
        kind = 'screen';
        statement = `${keyword} screen`;
        cursor = skipSpaces(masked, cursor + 'screen'.length);
      }

      const reference = parseTargetName(masked, strings, cursor, {
        kind,
        statement,
        lineNumber,
        currentGlobalLabel
      });
      if (reference) {
        references.push(reference);
      }
    }
    match = JUMP_CALL_PATTERN.exec(masked);
  }

  SHOW_HIDE_SCREEN_PATTERN.lastIndex = 0;
  match = SHOW_HIDE_SCREEN_PATTERN.exec(masked);
  while (match) {
    if (isStatementStart(masked, match.index + match[0].indexOf(match[1]))) {
      const reference = parseTargetName(masked, strings, match.index + match[0].length, {
        kind: 'screen',
        statement: `${match[1]} screen`,
        lineNumber,
        currentGlobalLabel
      });
      if (reference) {
        references.push(reference);
      }
    }
    match = SHOW_HIDE_SCREEN_PATTERN.exec(masked);
  }

  const useMatch = USE_SCREEN_PATTERN.exec(masked);
  if (useMatch) {
    const reference = parseTargetName(masked, strings, useMatch.index + useMatch[0].length, {
      kind: 'screen',
      statement: 'use',
      lineNumber,
      currentGlobalLabel
    });
    if (reference) {
      references.push(reference);
    }
  }

  FUNCTION_REFERENCE_PATTERN.lastIndex = 0;
  match = FUNCTION_REFERENCE_PATTERN.exec(masked);
  while (match) {
    const kind = FUNCTION_REFERENCE_KINDS.get(match[1]);
    const argumentStart = match.index + match[0].length;
    const literal = strings.find((entry) => entry.quoteStart === argumentStart && entry.terminated);
    const isPlainLiteral = literal ? isLiteralArgument(masked, literal) : false;

    references.push({
      kind,
      statement: `${match[1]}()`,
      name: isPlainLiteral ? resolveLocalName(literal.value, currentGlobalLabel) : null,
      raw: literal ? literal.value : masked.slice(argumentStart).trim(),
      line: lineNumber,
      start: literal ? literal.contentStart : argumentStart,
      end: literal ? literal.contentEnd : masked.length,
      fromExpression: true,
      dynamic: !isPlainLiteral
    });

    match = FUNCTION_REFERENCE_PATTERN.exec(masked);
  }
}

function isLiteralArgument(masked, literal) {
  const remainder = masked.slice(literal.contentEnd + 1).trimStart();
  return remainder.startsWith(',') || remainder.startsWith(')');
}

function parseTargetName(masked, strings, offset, options) {
  let cursor = skipSpaces(masked, offset);
  let fromExpression = false;
  let statement = options.statement;

  if (matchesWord(masked, cursor, 'expression')) {
    fromExpression = true;
    statement = `${statement} expression`;
    cursor = skipSpaces(masked, cursor + 'expression'.length);
  }

  if (cursor >= masked.length) {
    return null;
  }

  const literal = strings.find((entry) => entry.quoteStart === cursor);
  if (literal) {
    if (!literal.terminated) {
      return null;
    }

    // Only a bare string literal points at a fixed name; anything glued to it
    // (concatenation, formatting, indexing) is resolved at runtime.
    const remainder = masked.slice(literal.contentEnd + 1).trim();
    const isPlainString = remainder === '' || TRAILING_CLAUSE_PATTERN.test(remainder);

    return {
      kind: options.kind,
      statement,
      name: isPlainString ? resolveLocalName(literal.value, options.currentGlobalLabel) : null,
      raw: literal.value,
      line: options.lineNumber,
      start: literal.contentStart,
      end: literal.contentEnd,
      fromExpression: true,
      dynamic: !isPlainString
    };
  }

  const identifierMatch = IDENTIFIER_PATTERN.exec(masked.slice(cursor));

  if (fromExpression || !identifierMatch) {
    if (!fromExpression) {
      return null;
    }
    return {
      kind: options.kind,
      statement,
      name: null,
      raw: masked.slice(cursor).trim(),
      line: options.lineNumber,
      start: cursor,
      end: masked.length,
      fromExpression: true,
      dynamic: true
    };
  }

  const identifier = identifierMatch[0];

  return {
    kind: options.kind,
    statement,
    name: resolveLocalName(identifier, options.currentGlobalLabel),
    raw: identifier,
    line: options.lineNumber,
    start: cursor,
    end: cursor + identifier.length,
    fromExpression: false,
    dynamic: false
  };
}

function resolveLocalName(name, currentGlobalLabel) {
  if (name.startsWith('.')) {
    return currentGlobalLabel ? `${currentGlobalLabel}${name}` : name;
  }
  return name;
}

function skipSpaces(text, offset) {
  let cursor = offset;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor += 1;
  }
  return cursor;
}

function matchesWord(text, offset, word) {
  if (!text.startsWith(word, offset)) {
    return false;
  }
  const next = text[offset + word.length];
  return next === undefined || next === ' ' || next === '\t';
}

// Ren'Py statements start a line, or follow the colon of an inline block.
function isStatementStart(masked, keywordIndex) {
  const prefix = masked.slice(0, keywordIndex).trimEnd();
  return prefix === '' || prefix.endsWith(':');
}

function findReferenceAt(parsed, position) {
  for (const reference of parsed.references) {
    if (reference.line !== position.line || reference.dynamic || !reference.name) {
      continue;
    }
    if (position.character >= reference.start && position.character <= reference.end) {
      return {
        ...reference,
        range: new vscode.Range(reference.line, reference.start, reference.line, reference.end)
      };
    }
  }
  return null;
}

function findDefinitionAt(parsed, position) {
  const groups = [
    ['label', parsed.labels],
    ['screen', parsed.screens],
    ['function', parsed.functions]
  ];

  for (const [kind, definitions] of groups) {
    for (const definition of definitions) {
      if (
        definition.line === position.line
        && position.character >= definition.start
        && position.character <= definition.end
      ) {
        return { kind, name: definition.name };
      }
    }
  }

  return null;
}

function definitionsFor(index, kind) {
  if (kind === 'label') {
    return index.labels;
  }
  if (kind === 'screen') {
    return index.screens;
  }
  return index.functions;
}

function findUsages(index, kind, name) {
  return index.references.filter((reference) => reference.kind === kind && reference.name === name);
}

async function resolveDefinition(state, document, position) {
  const parsed = parseScript(document.getText());
  const index = await getIndex(state);

  // On a definition, list the usages instead so they open in a peek popup.
  const definition = findDefinitionAt(parsed, position);
  if (definition) {
    const usages = findUsages(index, definition.kind, definition.name);
    if (usages.length === 0) {
      return null;
    }
    return usages.map((usage) => new vscode.Location(usage.uri, usage.range));
  }

  const reference = findReferenceAt(parsed, position);
  if (!reference) {
    return null;
  }

  const target = definitionsFor(index, reference.kind).get(reference.name);
  if (!target) {
    return null;
  }

  return new vscode.Location(target.uri, new vscode.Position(target.line, 0));
}

async function resolveReferences(state, document, position, includeDeclaration) {
  const parsed = parseScript(document.getText());
  const index = await getIndex(state);
  const symbol = findDefinitionAt(parsed, position) || findReferenceAt(parsed, position);
  if (!symbol) {
    return null;
  }

  const locations = findUsages(index, symbol.kind, symbol.name)
    .map((usage) => new vscode.Location(usage.uri, usage.range));

  if (includeDeclaration) {
    const target = definitionsFor(index, symbol.kind).get(symbol.name);
    if (target) {
      locations.unshift(new vscode.Location(target.uri, new vscode.Position(target.line, 0)));
    }
  }

  return locations;
}

async function provideCasingFixes(state, document, actionContext) {
  const candidates = actionContext.diagnostics.filter(
    (diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE
      && (diagnostic.code === 'missing-label' || diagnostic.code === 'missing-screen')
  );
  if (candidates.length === 0) {
    return [];
  }

  const index = await getIndex(state);
  const parsed = parseScript(document.getText());
  const actions = [];

  for (const diagnostic of candidates) {
    const reference = findReferenceAt(parsed, diagnostic.range.start);
    if (!reference) {
      continue;
    }

    const definitions = reference.kind === 'label' ? index.labels : index.screens;
    const suggestion = findCaseInsensitiveMatch(definitions, reference.name);
    if (!suggestion) {
      continue;
    }

    const written = document.getText(diagnostic.range);
    const replacement = written.startsWith('.') ? `.${suggestion.split('.').pop()}` : suggestion;

    const action = new vscode.CodeAction(`Fix casing: use "${replacement}"`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diagnostic.range, replacement);
    action.diagnostics = [diagnostic];
    action.isPreferred = true;
    actions.push(action);
  }

  return actions;
}

async function showLabelPicker(state) {
  const index = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Collecting Ren'Py labels..." },
    () => getIndex(state)
  );

  const items = [...index.labels.entries()]
    .map(([name, definition]) => ({
      label: name,
      description: `${workspaceRelativePath(definition.uri)}:${definition.line + 1}`,
      alwaysShow: true,
      entry: { name, uri: definition.uri, line: definition.line },
      searchText: `${name} ${workspaceRelativePath(definition.uri)}`.toLowerCase()
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  if (items.length === 0) {
    vscode.window.showInformationMessage("No Ren'Py labels found in the scanned folders.");
    return;
  }

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = `Ren'Py labels (${items.length})`;
  quickPick.placeholder = 'Type parts of a label or path, in any order';
  quickPick.matchOnDescription = true;
  quickPick.items = items;

  quickPick.onDidChangeValue((value) => {
    quickPick.items = filterLabelItems(items, value);
  });

  quickPick.onDidAccept(async () => {
    const picked = quickPick.selectedItems[0];
    quickPick.hide();
    if (picked) {
      await insertLabelName(picked.entry);
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

function filterLabelItems(items, value) {
  const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return items;
  }

  const matches = [];
  for (const item of items) {
    if (terms.every((term) => item.searchText.includes(term))) {
      matches.push({ item, score: scoreLabelItem(item, terms) });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  return matches.map((match) => match.item);
}

function scoreLabelItem(item, terms) {
  const name = item.label.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.startsWith(term)) {
      score += 3;
    } else if (name.includes(term)) {
      score += 2;
    }
  }
  return score;
}

async function insertLabelName(entry) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(entry.name);
    vscode.window.showInformationMessage(`No active editor. Copied label name: ${entry.name}`);
    return;
  }

  await editor.edit((builder) => {
    for (const selection of editor.selections) {
      if (selection.isEmpty) {
        builder.insert(selection.active, entry.name);
      } else {
        builder.replace(selection, entry.name);
      }
    }
  });
}

async function showMissingOverview(state, diagnostics, statusButton) {
  const problems = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Scanning Ren'Py labels..." },
    () => refreshDiagnostics(state, diagnostics, statusButton)
  );
  const index = await getIndex(state);

  if (problems.length === 0) {
    vscode.window.showInformationMessage(
      `No unresolved jump/call targets found in ${index.fileCount} script file(s).`
    );
    return;
  }

  const items = problems.map((problem) => ({
    label: `$(${problem.kind === 'screen' ? 'window' : 'symbol-method'}) ${problem.name || problem.statement}`,
    description: `${problem.statement} - ${workspaceRelativePath(problem.uri)}:${problem.range.start.line + 1}`,
    detail: problem.message,
    problem
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Unresolved Ren'Py jump/call targets (${problems.length})`,
    placeHolder: 'Select an entry to open it',
    matchOnDescription: true,
    matchOnDetail: true
  });

  if (!picked) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(picked.problem.uri);
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(picked.problem.range.start, picked.problem.range.end);
  editor.revealRange(picked.problem.range, vscode.TextEditorRevealType.InCenter);
}

function workspaceRelativePath(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.fsPath;
  }
  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

module.exports = {
  activate,
  deactivate,
  parseScript
};
