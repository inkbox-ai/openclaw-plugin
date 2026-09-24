// CI-only: match private native errors to public, installed source templates.
// Never print an error, a template, a substitution, or a path from a log record.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const LIMITS = Object.freeze({
  logBytes: 2 * 1024 * 1024,
  recordBytes: 32 * 1024,
  records: 20,
  files: 8000,
  fileBytes: 4 * 1024 * 1024,
  sourceBytes: 128 * 1024 * 1024,
  candidates: 10,
});
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|mjs)$/;
const ERROR_PREFIX = "Embedded agent failed before reply: ";

export function nativeErrors(log) {
  const errors = [];
  for (const line of log.split("\n")) {
    if (Buffer.byteLength(line) > LIMITS.recordBytes) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (Object.hasOwn(record, "subsystem") || record.level !== "error") continue;
    if (typeof record.message !== "string" || !record.message.startsWith(ERROR_PREFIX)) continue;
    errors.push(record.message.slice(ERROR_PREFIX.length));
  }
  // Native formatErrorMessage appends causes/codes with this literal delimiter.
  // Keep the full message too: a source literal may itself contain the delimiter.
  return [...new Set(errors.slice(-LIMITS.records).flatMap((error) =>
    [error, ...error.split(" | ").slice(0, LIMITS.records)]))];
}

function staticParts(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return undefined;
}

export function sourceTemplates(source, basename) {
  if (!SOURCE_NAME.test(basename)) return [];
  const tree = ts.createSourceFile(basename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const factories = new Map();
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      // Only direct returns: no evaluation, control-flow inference or nested factories.
      factories.set(statement.name.text, statement.body.statements.filter(ts.isReturnStatement)
        .map((entry) => entry.expression).filter(Boolean));
    }
  }
  const templates = [];
  function add(node) {
    const parts = staticParts(node);
    if (!parts || parts.length > 9) return;
    const staticLength = parts.reduce((sum, part) => sum + part.length, 0);
    if (staticLength < 20 || staticLength > LIMITS.recordBytes) return;
    // A template needs a meaningful anchored edge, not just generic punctuation.
    if (parts.length > 1 && Math.max(parts[0].length, parts.at(-1).length) < 12) return;
    templates.push({ basename, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      kind: parts.length === 1 ? "literal" : "template", parts });
  }
  function visit(node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && /(?:^|[A-Za-z0-9_$])Error(?:\$\d+)?$/.test(node.expression.text)) {
      const argument = node.arguments?.[0];
      if (argument) {
        add(argument);
        if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
          for (const returned of factories.get(argument.expression.text) ?? []) add(returned);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return templates;
}

function matches(parts, value) {
  if (parts.length === 1) return value === parts[0];
  if (!value.startsWith(parts[0]) || !value.endsWith(parts.at(-1))) return false;
  let offset = parts[0].length;
  const end = value.length - parts.at(-1).length;
  for (const part of parts.slice(1, -1)) {
    const index = value.indexOf(part, offset);
    if (index < 0 || index + part.length > end) return false;
    offset = index + part.length;
  }
  return offset <= end;
}

export function candidateShapes(errors, templates) {
  const matchesFound = templates.filter((candidate) => errors.some((error) => matches(candidate.parts, error)));
  matchesFound.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "literal" ? -1 : 1)
    || a.basename.localeCompare(b.basename) || a.line - b.line);
  const shapes = [...new Set(matchesFound.map(({ basename, line, kind }) =>
    `native_error_candidate source=${basename}:${line} kind=${kind}`))];
  if (!shapes.length) return ["native_error_candidates=none"];
  return [...shapes.slice(0, LIMITS.candidates), ...(shapes.length > LIMITS.candidates ? ["native_error_candidates=bounded"] : [])];
}

async function readLog(logPath) {
  const handle = await fs.open(logPath, "r");
  try {
    const size = (await handle.stat()).size;
    const offset = Math.max(0, size - LIMITS.logBytes);
    const data = Buffer.alloc(Math.min(size, LIMITS.logBytes));
    const { bytesRead } = await handle.read(data, 0, data.length, offset);
    const tail = data.subarray(0, bytesRead);
    return (offset ? tail.subarray(tail.indexOf(10) < 0 ? tail.length : tail.indexOf(10) + 1) : tail).toString("utf8");
  } finally { await handle.close(); }
}

export async function locateNativeErrors({ executable, logPath }) {
  try {
    const errors = nativeErrors(await readLog(logPath));
    if (!errors.length) return ["native_error_candidates=no_records"];
    const root = path.dirname(await fs.realpath(executable));
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (manifest.name !== "openclaw") return ["native_error_candidates=unavailable"];
    const dist = await fs.realpath(path.join(root, "dist"));
    if (dist !== path.join(root, "dist")) return ["native_error_candidates=unavailable"];
    const entries = (await fs.readdir(dist, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && SOURCE_NAME.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > LIMITS.files) return ["native_error_candidates=catalog_bounded"];
    const templates = [];
    let totalBytes = 0;
    for (const entry of entries) {
      const sourcePath = path.join(dist, entry.name);
      const size = (await fs.stat(sourcePath)).size;
      totalBytes += size;
      if (size > LIMITS.fileBytes || totalBytes > LIMITS.sourceBytes) return ["native_error_candidates=catalog_bounded"];
      const source = await fs.readFile(sourcePath, "utf8");
      if (/new\s+[A-Za-z_$][\w$]*Error(?:\$\d+)?\s*\(/.test(source) || /new\s+Error\s*\(/.test(source)) {
        templates.push(...sourceTemplates(source, entry.name));
      }
    }
    return candidateShapes(errors, templates);
  } catch { return ["native_error_candidates=unavailable"]; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const shape of await locateNativeErrors({ executable: process.argv[2], logPath: process.argv[3] })) console.log(shape);
}
