// @ts-check
// Stop hook: runs pnpm typecheck when Claude finishes a turn. On failure it exits with code 2
// and a short list of errors, so Claude keeps working until the types pass.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_LINES = 20;

function main() {
  const event = /** @type {{ stop_hook_active?: boolean }} */ (JSON.parse(readFileSync(0, 'utf8')));
  // Already continuing because of this hook: let Claude stop instead of looping forever.
  if (event.stop_hook_active === true) return;

  try {
    execSync('pnpm typecheck', { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const failure = /** @type {{ stdout?: string; stderr?: string }} */ (error);
    const lines = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
      .split('\n')
      .filter((line) => line.includes('error TS'));
    const shown = lines.slice(0, MAX_LINES).join('\n');
    const more = lines.length > MAX_LINES ? `\n...and ${lines.length - MAX_LINES} more` : '';
    process.stderr.write(
      `pnpm typecheck failed (${lines.length} errors). Fix them before finishing:\n${shown}${more}\n`,
    );
    process.exit(2);
  }
}

main();
