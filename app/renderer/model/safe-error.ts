export const safeDiagnostic = (
  value: string,
  fallback = "No diagnostic detail was provided.",
): string => {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[host]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s]+/g, "[path]")
    .trim();
  return normalized.length === 0 ? fallback : normalized.slice(0, 512);
};
