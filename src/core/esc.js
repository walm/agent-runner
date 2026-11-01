// Text that goes into markup (toasts, cards, the lists): agent names, messages and track titles come from
// outside, so the five characters HTML reads as its own are escaped.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
