// invoke-capabilities.js
// Asks the PhotoMap backend which recall features the configured InvokeAI
// instance supports and reflects the answer as classes on <body>. The CSS in
// metadata-drawer.css keeps every recall button hidden until support is
// positively confirmed, so a backend without the recall router shows no
// buttons at all, and one without the append option hides only
// "Append to InvokeAI".

import { fetchJson } from "./utils.js";

export async function refreshInvokeCapabilities({ refresh = false } = {}) {
  let caps = { recall: false, append: false };
  try {
    caps = await fetchJson(refresh ? "invokeai/capabilities?refresh=true" : "invokeai/capabilities");
  } catch (err) {
    // Unknown is treated as unsupported — a button that can't work is worse
    // than a missing one. The backend retries failed probes quickly.
    console.warn("Could not determine InvokeAI capabilities:", err);
  }
  document.body.classList.toggle("invoke-recall-supported", caps.recall === true);
  document.body.classList.toggle("invoke-append-supported", caps.append === true);
  return caps;
}
