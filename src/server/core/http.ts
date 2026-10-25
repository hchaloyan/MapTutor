export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode })
}
