// Plain JavaScript so the extension (TypeScript) and the stats command (Node, no type stripping
// inside node_modules) share one definition.

/** Read-only lookup tools whose independent calls can go out together in one batch. */
export const DISCOVERY = new Set(["read", "grep", "find", "ls", "symbol_search", "module_report", "read_symbol", "read_enclosing", "lsp_diagnostics", "lens_diagnostics"]);

/** How the batch reminder begins; the stats command finds past reminders by it. */
export const BATCH_REMINDER = "efficient tool use: the last 3 singleton discovery batches";
/** How a repeated reminder begins, after the model sent another lookup alone. */
export const BATCH_REMINDER_AGAIN = "efficient tool use: reminder again";
