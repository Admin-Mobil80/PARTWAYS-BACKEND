// De-identification for free text. Email addresses and phone numbers are removed
// from what the employee says before it is stored; the interviewer and summariser
// are instructed to leave out names. This is a safety net, not a guarantee.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+|\b)\d[\d\s().-]{6,}\d\b/g;

export function redact(text) {
  return String(text ?? '')
    .replace(EMAIL, '[email removed]')
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[number removed]' : m));
}
