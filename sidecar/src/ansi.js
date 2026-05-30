const ANSI_PATTERN =
  // Matches CSI, OSC, and a few other common terminal control sequences.
  /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[()[#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g

export function stripAnsi(input) {
  return input.replace(ANSI_PATTERN, '')
}

export function normalizeWhitespace(input) {
  return stripAnsi(input).replace(/\r/g, '').replace(/\u0000/g, '').trim()
}
