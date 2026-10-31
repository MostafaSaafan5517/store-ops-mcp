import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EM_DASH = String.fromCharCode(0x2014);
const TEXT_FILE = /\.(ts|mjs|js|json|sql|md|yaml|yml|example)$|^\.[a-z]+$/;

function repoFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter((file) => file.length > 0 && file !== 'pnpm-lock.yaml')
    .filter((file) => TEXT_FILE.test(file.split('/').pop() ?? ''));
}

describe('repo hygiene', () => {
  it('has no em dashes in any tracked text file', () => {
    const files = repoFiles();
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(EM_DASH));
    expect(offenders).toEqual([]);
  });
});
