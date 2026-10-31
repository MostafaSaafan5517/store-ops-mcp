// In-memory stand-in for a Workers KV namespace, with the calls the OAuth provider makes
// (get as text or JSON, put with TTL and metadata, delete, list by prefix). Expiry follows
// Date.now(), so fake timers can expire tokens.

interface Entry {
  value: string;
  expiresAt?: number;
  metadata?: unknown;
}

interface PutOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: unknown;
}

export class MemoryKV {
  readonly #entries = new Map<string, Entry>();

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string, options?: string | { type?: string }): Promise<unknown> {
    const entry = this.#live(key);
    if (!entry) return Promise.resolve(null);
    const type = typeof options === 'string' ? options : options?.type;
    return Promise.resolve(type === 'json' ? (JSON.parse(entry.value) as unknown) : entry.value);
  }

  put(key: string, value: string, options: PutOptions = {}): Promise<void> {
    const expiresAt =
      options.expirationTtl !== undefined
        ? Date.now() + options.expirationTtl * 1000
        : options.expiration !== undefined
          ? options.expiration * 1000
          : undefined;
    this.#entries.set(key, {
      value,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const names = [...this.#entries.keys()]
      .filter((name) => name.startsWith(options.prefix ?? '') && this.#live(name))
      .sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return Promise.resolve({
      keys: page.map((name) => {
        const entry = this.#entries.get(name);
        return {
          name,
          ...(entry?.expiresAt !== undefined
            ? { expiration: Math.floor(entry.expiresAt / 1000) }
            : {}),
          ...(entry?.metadata !== undefined ? { metadata: entry.metadata } : {}),
        };
      }),
      list_complete: done,
      ...(done ? {} : { cursor: String(start + limit) }),
    });
  }

  /** Test helper: how many keys start with `prefix`. */
  count(prefix: string): number {
    return [...this.#entries.keys()].filter((name) => name.startsWith(prefix) && this.#live(name))
      .length;
  }
}
