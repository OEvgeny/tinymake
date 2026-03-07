#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import process from 'node:process';

function usage(code = 0) {
  const text = `tinymake.js - tiny GNU Makefile subset runner for JS runtimes

Usage:
  node tinymake.js [options] [VAR=value ...] [target ...]
  bun tinymake.js [options] [VAR=value ...] [target ...]
  deno -A tinymake.js [options] [VAR=value ...] [target ...]

Options:
  -f FILE         Read FILE instead of Makefile
  -n, --dry-run   Print commands without running them
  -h, --help      Show this help
`;
  process.stdout.write(text);
  process.exit(code);
}

function fail(message) {
  process.stderr.write(`tinymake: ${message}\n`);
  process.exit(1);
}

function findMakefile(explicitFile) {
  if (explicitFile) return explicitFile;
  const candidates = ['Makefile', 'makefile'];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return candidate;
  }
  fail('no Makefile found');
}

function parseArgs(argv) {
  let file = null;
  let dryRun = false;
  const cliVars = new Map();
  const targets = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-f') {
      i += 1;
      if (i >= argv.length) fail('missing file after -f');
      file = argv[i];
      continue;
    }
    if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') usage(0);
    if (/^[A-Za-z_][A-Za-z0-9_.-]*=.*/.test(arg)) {
      const eq = arg.indexOf('=');
      cliVars.set(arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    targets.push(arg);
  }

  return { file, dryRun, cliVars, targets };
}

function stripComments(line) {
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function splitInlineRecipe(rhs) {
  let escaped = false;
  for (let i = 0; i < rhs.length; i += 1) {
    const ch = rhs[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === ';') return [rhs.slice(0, i), rhs.slice(i + 1)];
  }
  return [rhs, null];
}

function tokenizeSpaceSeparated(text) {
  return text.trim() ? text.trim().split(/\s+/) : [];
}

function endsWithUnescapedBackslash(line) {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

function normalizeLogicalLines(content) {
  const rawLines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const lines = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    let text = rawLines[i];
    const lineNo = i + 1;

    while (endsWithUnescapedBackslash(text) && i + 1 < rawLines.length) {
      text = text.slice(0, -1) + rawLines[i + 1].trimStart();
      i += 1;
    }

    lines.push({ text, lineNo });
  }

  return lines;
}

function parseMakefile(content) {
  const variables = new Map();
  const rules = [];
  const phony = new Set();
  const exported = new Set();
  let currentRule = null;
  let defaultTargetRaw = null;

  const lines = normalizeLogicalLines(content);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const { text: rawLine, lineNo } = lines[lineIndex];

    if (/^\t/.test(rawLine)) {
      if (!currentRule) fail(`recipe without a rule at line ${lineNo}`);
      currentRule.recipes.push(rawLine.replace(/^\t/, ''));
      continue;
    }

    currentRule = null;

    const withoutComments = stripComments(rawLine);
    if (!withoutComments.trim()) continue;

    const phonyMatch = withoutComments.match(/^\s*\.PHONY\s*:\s*(.*)$/);
    if (phonyMatch) {
      for (const name of tokenizeSpaceSeparated(phonyMatch[1])) phony.add(name);
      continue;
    }

    const exportAssignMatch = withoutComments.match(
      /^\s*export\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(:=|\?=|=)\s*(.*)$/
    );
    if (exportAssignMatch) {
      const [, name, op, value] = exportAssignMatch;
      variables.set(name, { op, value });
      exported.add(name);
      continue;
    }

    const exportNamesMatch = withoutComments.match(/^\s*export\s+(.+)$/);
    if (exportNamesMatch) {
      for (const name of tokenizeSpaceSeparated(exportNamesMatch[1]))
        exported.add(name);
      continue;
    }

    const assignMatch = withoutComments.match(
      /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(:=|\?=|=)\s*(.*)$/
    );
    if (assignMatch) {
      const [, name, op, value] = assignMatch;
      variables.set(name, { op, value });
      continue;
    }

    const colonIndex = withoutComments.indexOf(':');
    if (colonIndex === -1) fail(`cannot parse line ${lineNo}: ${rawLine}`);

    const lhs = withoutComments.slice(0, colonIndex).trim();
    const rhsAll = withoutComments.slice(colonIndex + 1);
    if (!lhs) fail(`missing rule target at line ${lineNo}`);

    const [rhs, inlineRecipe] = splitInlineRecipe(rhsAll);
    const targets = tokenizeSpaceSeparated(lhs);
    const deps = tokenizeSpaceSeparated(rhs);

    if (
      !defaultTargetRaw &&
      targets.length > 0 &&
      !targets[0].startsWith('.')
    ) {
      defaultTargetRaw = targets[0];
    }

    const rule = {
      rawTargets: targets,
      rawDeps: deps,
      recipes: inlineRecipe && inlineRecipe.trim() ? [inlineRecipe.trim()] : [],
      lineNo,
    };
    rules.push(rule);
    currentRule = rule;
  }

  return { variables, rules, phony, exported, defaultTargetRaw };
}

function readBalancedRef(text, start, open, close) {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch === close) {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start, i), end: i };
    }
  }
  fail('unterminated variable or function reference');
}

function hasGlobMagic(segment) {
  return /[*?[]/.test(segment);
}

function escapeRegexChar(ch) {
  return /[|\\{}()[\]^$+?.]/.test(ch) ? `\\${ch}` : ch;
}

function globSegmentToRegex(segment) {
  let out = '^';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const end = segment.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      const body = segment.slice(i + 1, end);
      if (!body) {
        out += '\\[\\]';
      } else if (body[0] === '!') {
        out += `[^${body.slice(1)}]`;
      } else {
        out += `[${body}]`;
      }
      i = end;
      continue;
    }
    out += escapeRegexChar(ch);
  }
  out += '$';
  return new RegExp(out);
}

function expandWildcardPattern(pattern, cwd) {
  const normalized = pattern.replace(/\\/g, '/');
  const isAbsolute = path.isAbsolute(pattern);
  const root = isAbsolute ? path.parse(path.resolve(pattern)).root : cwd;
  const withoutRoot = isAbsolute
    ? normalized.slice(
        path.parse(path.resolve(pattern)).root.replace(/\\/g, '/').length
      )
    : normalized;
  const segments = withoutRoot.split('/').filter(Boolean);
  const matches = new Set();

  function pushMatch(displayParts) {
    if (isAbsolute) {
      matches.add(path.resolve(root, ...displayParts));
    } else {
      matches.add(displayParts.length > 0 ? displayParts.join('/') : '.');
    }
  }

  function visit(currentFsPath, index, displayParts) {
    if (index >= segments.length) {
      if (fs.existsSync(currentFsPath)) pushMatch(displayParts);
      return;
    }

    const segment = segments[index];

    if (segment === '**') {
      visit(currentFsPath, index + 1, displayParts);
      if (
        !fs.existsSync(currentFsPath) ||
        !fs.statSync(currentFsPath).isDirectory()
      )
        return;
      for (const entry of fs.readdirSync(currentFsPath, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        visit(path.join(currentFsPath, entry.name), index, [
          ...displayParts,
          entry.name,
        ]);
      }
      return;
    }

    if (!hasGlobMagic(segment)) {
      visit(path.join(currentFsPath, segment), index + 1, [
        ...displayParts,
        segment,
      ]);
      return;
    }

    if (
      !fs.existsSync(currentFsPath) ||
      !fs.statSync(currentFsPath).isDirectory()
    )
      return;
    const matcher = globSegmentToRegex(segment);
    for (const entry of fs.readdirSync(currentFsPath, {
      withFileTypes: true,
    })) {
      if (!matcher.test(entry.name)) continue;
      visit(path.join(currentFsPath, entry.name), index + 1, [
        ...displayParts,
        entry.name,
      ]);
    }
  }

  visit(root, 0, []);
  return [...matches].sort();
}

function createResolver(variableDefs, cliVars, options) {
  const simpleCache = new Map();
  const cwd = options.cwd;

  function evaluateFunction(name, argText, local, stack) {
    const expandedArgs = resolveText(argText, local, stack).trim();
    const words = tokenizeSpaceSeparated(expandedArgs);

    if (name === 'realpath') {
      const out = [];
      for (const word of words) {
        const full = path.resolve(cwd, word);
        if (!fs.existsSync(full)) continue;
        const real = fs.realpathSync.native
          ? fs.realpathSync.native(full)
          : fs.realpathSync(full);
        out.push(real);
      }
      return out.join(' ');
    }

    if (name === 'wildcard') {
      const out = [];
      for (const word of words) out.push(...expandWildcardPattern(word, cwd));
      return out.join(' ');
    }

    return null;
  }

  function expandRefBody(body, local, stack) {
    const trimmed = body.trim();
    const fnMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s+([\s\S]*)$/);
    if (fnMatch) {
      const [, fnName, argText] = fnMatch;
      const evaluated = evaluateFunction(fnName, argText, local, stack);
      if (evaluated != null) return evaluated;
    }
    return resolveVariable(trimmed, local, stack);
  }

  function resolveVariable(name, local, stack) {
    if (local && Object.prototype.hasOwnProperty.call(local, name))
      return String(local[name]);
    if (cliVars.has(name)) return cliVars.get(name);
    if (!variableDefs.has(name)) return process.env[name] || '';
    if (stack.includes(name)) {
      if (Object.prototype.hasOwnProperty.call(process.env, name))
        return process.env[name] || '';
      fail(`recursive variable reference: ${[...stack, name].join(' -> ')}`);
    }

    const def = variableDefs.get(name);
    if (def.op === ':=') {
      if (simpleCache.has(name)) return simpleCache.get(name);
      const value = resolveText(def.value, local, [...stack, name]);
      simpleCache.set(name, value);
      return value;
    }
    return resolveText(def.value, local, [...stack, name]);
  }

  function resolveText(text, local = {}, stack = []) {
    const input = String(text);
    let out = '';

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (ch !== '$') {
        out += ch;
        continue;
      }

      if (i + 1 >= input.length) {
        out += '$';
        continue;
      }

      const next = input[i + 1];

      if (next === '$') {
        out += '$';
        i += 1;
        continue;
      }

      if (next === '@' || next === '<' || next === '^') {
        out += resolveVariable(next, local, stack);
        i += 1;
        continue;
      }

      if (next === '(' || next === '{') {
        const open = next;
        const close = next === '(' ? ')' : '}';
        const ref = readBalancedRef(input, i + 2, open, close);
        out += expandRefBody(ref.body, local, stack);
        i = ref.end;
        continue;
      }

      out += '$';
    }

    return out;
  }

  const materialized = new Map();
  for (const [name] of variableDefs.entries())
    materialized.set(name, resolveVariable(name, {}, []));
  for (const [name, value] of cliVars.entries()) materialized.set(name, value);

  return { resolveText, resolveVariable, materialized };
}

function applyConditionalAssignments(variableDefs, cliVars) {
  const out = new Map();
  const seen = new Set();
  for (const [name, def] of variableDefs.entries()) {
    if (def.op === '?=' && (cliVars.has(name) || seen.has(name))) continue;
    out.set(name, def);
    seen.add(name);
  }
  return out;
}

function buildRuleIndex(parsed, resolver) {
  const ruleByTarget = new Map();
  let defaultTarget = null;

  for (const rule of parsed.rules) {
    const targets = rule.rawTargets.map((x) => resolver.resolveText(x));
    const deps = rule.rawDeps.map((x) => resolver.resolveText(x));
    const built = {
      targets,
      deps,
      recipes: rule.recipes.slice(),
      lineNo: rule.lineNo,
    };

    for (const target of targets) {
      if (!defaultTarget && !target.startsWith('.')) defaultTarget = target;
      if (ruleByTarget.has(target)) {
        const existing = ruleByTarget.get(target);
        if (existing.recipes.length > 0 && built.recipes.length > 0) {
          fail(
            `duplicate rule for target '${target}' (lines ${existing.lineNo} and ${built.lineNo})`
          );
        }
        if (existing.recipes.length === 0 && built.recipes.length > 0) {
          ruleByTarget.set(target, built);
        }
      } else {
        ruleByTarget.set(target, built);
      }
    }
  }

  if (!defaultTarget && parsed.defaultTargetRaw)
    defaultTarget = resolver.resolveText(parsed.defaultTargetRaw);

  const phony = new Set([...parsed.phony].map((x) => resolver.resolveText(x)));
  const exported = new Set(
    [...parsed.exported].map((x) => resolver.resolveText(x))
  );
  return { ruleByTarget, phony, exported, defaultTarget };
}

function shellForPlatform() {
  if (process.platform === 'win32') {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] };
  }
  return { cmd: process.env.SHELL || '/bin/sh', args: ['-c'] };
}

function runRecipeLine(command, options) {
  let cmd = command;
  let silent = false;
  let ignoreErrors = false;

  while (cmd.length > 0) {
    if (cmd[0] === '@') {
      silent = true;
      cmd = cmd.slice(1);
      continue;
    }
    if (cmd[0] === '-') {
      ignoreErrors = true;
      cmd = cmd.slice(1);
      continue;
    }
    if (cmd[0] === '+') {
      cmd = cmd.slice(1);
      continue;
    }
    break;
  }

  if (!silent) process.stdout.write(`> ${cmd}\n`);
  if (options.dryRun) return;

  const shell = shellForPlatform();
  const child = cp.spawnSync(shell.cmd, [...shell.args, cmd], {
    cwd: options.cwd,
    stdio: 'inherit',
    env: options.env,
  });

  if (child.error) {
    if (ignoreErrors) return;
    fail(`failed to run command: ${child.error.message}`);
  }

  const status = child.status == null ? 1 : child.status;
  if (status !== 0 && !ignoreErrors) process.exit(status);
}

function createBuilder(index, resolver, options) {
  const visited = new Set();
  const visiting = new Set();

  function build(target) {
    if (visited.has(target)) return;
    if (visiting.has(target))
      fail(`circular dependency detected at '${target}'`);

    const rule = index.ruleByTarget.get(target);
    if (!rule) {
      if (fs.existsSync(path.resolve(options.cwd, target))) {
        visited.add(target);
        return;
      }
      fail(`no rule to make target '${target}'`);
    }

    visiting.add(target);
    for (const dep of rule.deps) build(dep);

    if (rule.recipes.length > 0) {
      const local = {
        '@': target,
        '<': rule.deps[0] || '',
        '^': Array.from(new Set(rule.deps)).join(' '),
      };
      const env = { ...process.env };
      for (const name of index.exported)
        env[name] = resolver.resolveVariable(name, {}, []);
      for (const recipe of rule.recipes) {
        const command = resolver.resolveText(recipe, local, []);
        runRecipeLine(command, {
          cwd: options.cwd,
          env,
          dryRun: options.dryRun,
        });
      }
    } else if (index.phony.has(target) && options.verbosePhonyNoop) {
      process.stdout.write(`# phony target '${target}' has no recipe\n`);
    }

    visiting.delete(target);
    for (const sibling of rule.targets) visited.add(sibling);
    visited.add(target);
  }

  return { build };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const makefile = findMakefile(args.file);
  const content = fs.readFileSync(makefile, 'utf8');
  const parsed = parseMakefile(content);
  const variableDefs = applyConditionalAssignments(
    parsed.variables,
    args.cliVars
  );
  const resolver = createResolver(variableDefs, args.cliVars, {
    cwd: process.cwd(),
  });
  const index = buildRuleIndex(
    { ...parsed, variables: variableDefs },
    resolver
  );

  const targets =
    args.targets.length > 0 ? args.targets : [index.defaultTarget];
  if (!targets[0]) fail('no default target found');

  const builder = createBuilder(index, resolver, {
    cwd: process.cwd(),
    dryRun: args.dryRun,
    verbosePhonyNoop: false,
  });

  for (const target of targets) builder.build(target);
}

main();
