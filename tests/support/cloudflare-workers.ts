// Stand-in for the `cloudflare:workers` module when the Worker code runs under Vitest in Node.
// The OAuth provider imports WorkerEntrypoint only to tell class handlers from object handlers,
// and this app passes object handlers.
export class WorkerEntrypoint {}
