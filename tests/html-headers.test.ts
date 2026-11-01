import { describe, expect, it } from 'vitest';
import { pageHeaders } from '../src/remote/html.js';

describe('page headers', () => {
  it('keep a referrer policy that lets browsers send a real Origin on form posts', () => {
    // With no-referrer, browsers send `Origin: null` on POST, and the CSRF origin check then
    // refuses every sign-in, consent and approval form (found on the live server, 2026-11-01).
    const policy = pageHeaders().get('Referrer-Policy');
    expect(policy).toBe('same-origin');
    expect(policy).not.toBe('no-referrer');
  });

  it('still block framing, caching and outside resources', () => {
    const headers = pageHeaders();
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
});
