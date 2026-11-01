/** A business error whose message is safe to show to the client as is. */
export class ToolError extends Error {}

/** The store is gone: an expired demo store (24 hours), hidden and then wiped. */
export class StoreClosedError extends ToolError {
  constructor() {
    super(
      'This demo expired. Demo stores last 24 hours, then their data is deleted. Connect again and choose "Try the demo" to start a new one.',
    );
  }
}
