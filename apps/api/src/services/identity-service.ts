import { randomBytes } from 'node:crypto'

import type { FastifyReply, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'

const PASSWORD_ROUNDS = 12

function sessionExpiresAt() {
  return new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
}

function sessionCookieOptions() {
  const secure = env.PUBLIC_API_BASE_URL.startsWith('https://')
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    expires: sessionExpiresAt(),
  }
}

export class IdentityService {
  async signup(input: { businessName: string; email: string; password: string; name?: string | null }, reply: FastifyReply) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    })

    if (existingUser) {
      throw new HttpError(409, 'An account with this email already exists')
    }

    const passwordHash = await bcrypt.hash(input.password, PASSWORD_ROUNDS)

    const account = await prisma.account.create({
      data: {
        name: input.businessName,
      },
    })

    const user = await prisma.user.create({
      data: {
        accountId: account.id,
        email: input.email.toLowerCase(),
        name: input.name ?? input.businessName,
        passwordHash,
      },
    })

    await this.createSession(user.id, reply)
    return { account, user: this.sanitizeUser(user) }
  }

  async login(input: { email: string; password: string }, reply: FastifyReply) {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { account: true },
    })

    if (!user) {
      throw new HttpError(401, 'Invalid email or password')
    }

    if (!user.passwordHash.startsWith('$2')) {
      throw new HttpError(401, 'Invalid email or password')
    }

    const isValid = await bcrypt.compare(input.password, user.passwordHash)
    if (!isValid) {
      throw new HttpError(401, 'Invalid email or password')
    }

    await this.createSession(user.id, reply)
    return {
      account: user.account,
      user: this.sanitizeUser(user),
    }
  }

  async logout(request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies[env.SESSION_COOKIE_NAME]

    if (token) {
      await prisma.session.deleteMany({
        where: { token },
      })
    }

    reply.clearCookie(env.SESSION_COOKIE_NAME, {
      path: '/',
    })
  }

  async requireIdentity(request: FastifyRequest) {
    const token = request.cookies[env.SESSION_COOKIE_NAME]
    if (!token) {
      throw new HttpError(401, 'Authentication required')
    }

    const session = await prisma.session.findUnique({
      where: { token },
      include: {
        user: {
          include: {
            account: true,
          },
        },
      },
    })

    if (!session || session.expiresAt <= new Date()) {
      throw new HttpError(401, 'Authentication required')
    }

    return {
      account: session.user.account,
      user: this.sanitizeUser(session.user),
      session,
    }
  }

  private async createSession(userId: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('base64url')

    await prisma.session.create({
      data: {
        userId,
        token,
        expiresAt: sessionExpiresAt(),
      },
    })

    reply.setCookie(env.SESSION_COOKIE_NAME, token, sessionCookieOptions())
  }

  private sanitizeUser<T extends { passwordHash: string }>(user: T) {
    const { passwordHash, ...rest } = user
    return rest
  }
}
