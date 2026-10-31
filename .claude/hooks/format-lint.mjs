// @ts-check
// PostToolUse hook for Edit, Write and MultiEdit. Formats the edited .ts, .mts or .mjs file
// with Prettier, then lints it with ESLint (zero warnings). Lint problems exit with code 2 so
// Claude sees them and fixes them right away.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSIONS = new Set(['.ts', '.mts', '.mjs']);

/**
 * Runs a command in the repo root and returns its exit code and combined output.
 * @param {string} command
 * @returns {{ ok: boolean; output: string }}
 */
function run(command) {
  try {
    const output = execSync(command, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, output };
  } catch (error) {
    const failure = /** @type {{ stdout?: string; stderr?: string }} */ (error);
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

function main() {
  const event = /** @type {{ tool_input?: { file_path?: string } }} */ (
    JSON.parse(readFileSync(0, 'utf8'))
  );
  const filePath = event.tool_input?.file_path;
  if (filePath === undefined || !EXTENSIONS.has(extname(filePath))) return;

  const absolute = isAbsolute(filePath) ? filePath : resolve(REPO_ROOT, filePath);
  const rel = relative(REPO_ROOT, absolute).split('\\').join('/');
  if (rel.startsWith('..') || rel.startsWith('node_modules/') || !existsSync(absolute)) return;

  const format = run(`pnpm exec prettier --write "${rel}"`);
  if (!format.ok) {
    process.stderr.write(`Prettier failed on ${rel}:\n${format.output.trim()}\n`);
    process.exit(2);
  }
  const lint = run(`pnpm exec eslint --max-warnings 0 "${rel}"`);
  if (!lint.ok) {
    process.stderr.write(`ESLint found problems in ${rel}. Fix them:\n${lint.output.trim()}\n`);
    process.exit(2);
  }
}

main();
