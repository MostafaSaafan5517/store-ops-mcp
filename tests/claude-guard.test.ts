import { describe, expect, it } from 'vitest';
import { blockReason } from '../.claude/hooks/guard.mjs';

const EM_DASH = String.fromCharCode(0x2014);
const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const at = (rel: string) => `${ROOT}/${rel}`;
const options = { repoRoot: ROOT, trackedMigrations: ['migrations/0001_schema.sql'] };

describe('Claude Code guard hook', () => {
  it('allows normal edits', () => {
    expect(blockReason({ file_path: at('src/server.ts'), content: 'ok - fine' }, options)).toBe(
      null,
    );
    expect(blockReason({ file_path: at('.env.example'), new_string: 'A=1' }, options)).toBe(null);
  });

  it('blocks em dashes in Write, Edit and MultiEdit text', () => {
    const text = `a ${EM_DASH} b`;
    expect(blockReason({ file_path: at('README.md'), content: text }, options)).toMatch(/em dash/);
    expect(blockReason({ file_path: at('README.md'), new_string: text }, options)).toMatch(
      /em dash/,
    );
    expect(
      blockReason(
        { file_path: at('README.md'), edits: [{ new_string: 'x' }, { new_string: text }] },
        options,
      ),
    ).toMatch(/em dash/);
  });

  it('blocks the lock file and .env files', () => {
    expect(blockReason({ file_path: at('pnpm-lock.yaml'), content: '' }, options)).toMatch(/lock/);
    expect(blockReason({ file_path: at('.env'), content: '' }, options)).toMatch(/secrets/);
    expect(blockReason({ file_path: at('.env.local'), content: '' }, options)).toMatch(/secrets/);
  });

  it('blocks tracked migrations but allows new ones', () => {
    expect(
      blockReason({ file_path: at('migrations/0001_schema.sql'), new_string: 'x' }, options),
    ).toMatch(/already committed/);
    expect(
      blockReason({ file_path: 'migrations/0001_schema.sql', new_string: 'x' }, options),
    ).toMatch(/already committed/);
    expect(
      blockReason({ file_path: at('migrations/0004_new_table.sql'), content: 'x' }, options),
    ).toBe(null);
  });
});
