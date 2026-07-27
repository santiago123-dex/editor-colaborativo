import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const KEY_LENGTH = 64

export const createSessionToken = (): string => randomBytes(32).toString('base64url')

export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const createCsrfToken = (secret: string, sessionToken: string): string =>
  createHmac('sha256', secret).update(sessionToken).digest('base64url')

export const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export const hashPassword = async (password: string): Promise<{ hash: Buffer; salt: Buffer }> => {
  const salt = randomBytes(16)
  const hash = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer
  return { hash, salt }
}

export const verifyPassword = async (password: string, salt: Buffer, expected: Buffer): Promise<boolean> => {
  const actual = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
