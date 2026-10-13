const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024
function maxFileBytes() {
  const bytes = Number(process.env.FAIRDROP_MAX_FILE_BYTES || DEFAULT_MAX_BYTES)
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('FAIRDROP_MAX_FILE_BYTES must be a positive safe integer')
  return bytes
}
module.exports = { maxFileBytes }
