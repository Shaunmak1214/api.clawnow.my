import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyReply, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'
import jwt, { type JwtPayload, type Secret, type SignOptions } from 'jsonwebtoken'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'

const PASSWORD_ROUNDS = 12

type AccessTokenPayload = JwtPayload & {
  sub: string
  accountId: string
  email: string
}

type SessionCookieSameSite = 'lax' | 'strict' | 'none'

type SessionCookieConfig = {
  apiBaseUrl: string
  frontendOrigin: string
  sameSite: SessionCookieSameSite
  sessionTtlDays: number
  domain?: string
}

function railwayCreateAllowlistEmails() {
  return env.CLAWNOW_RAILWAY_CREATE_ALLOWLIST_EMAILS
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function jwtSecret(): Secret {
  return env.JWT_SECRET ?? env.ENCRYPTION_KEY
}

function jwtExpiresIn(): SignOptions['expiresIn'] {
  return env.JWT_EXPIRES_IN as SignOptions['expiresIn']
}

export function buildSessionCookieOptions(config: SessionCookieConfig): CookieSerializeOptions {
  const apiBaseUrl = config.apiBaseUrl.toLowerCase()
  const frontendOrigin = config.frontendOrigin.toLowerCase()
  const isSecure = config.sameSite === 'none' || apiBaseUrl.startsWith('https://') || frontendOrigin.startsWith('https://')

  return {
    httpOnly: true,
    sameSite: config.sameSite,
    secure: isSecure,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
    ...(config.domain ? { domain: config.domain } : {}),
  }
}

export class IdentityService {
  async signup(input: { businessName: string; email: string; password: string; name?: string | null }) {
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

    return {
      account,
      user: this.sanitizeUser(user),
      accessToken: this.createAccessToken({
        userId: user.id,
        accountId: account.id,
        email: user.email,
      }),
    }
  }

  async login(input: { email: string; password: string }) {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
      include: { account: true },
    })

    if (!user) {
      throw new HttpError(401, 'Invalid email or password')
    }

    if (typeof user.passwordHash !== 'string' || !user.passwordHash.startsWith('$2')) {
      throw new HttpError(401, 'Invalid email or password')
    }

    const isValid = await bcrypt.compare(input.password, user.passwordHash)
    if (!isValid) {
      throw new HttpError(401, 'Invalid email or password')
    }

    return {
      account: user.account,
      user: this.sanitizeUser(user),
      accessToken: this.createAccessToken({
        userId: user.id,
        accountId: user.account.id,
        email: user.email,
      }),
    }
  }

  async logout(_request: FastifyRequest) {
    return
  }

  setAuthCookie(reply: FastifyReply, accessToken: string) {
    reply.setCookie(env.SESSION_COOKIE_NAME, accessToken, this.cookieOptions())
  }

  clearAuthCookie(reply: FastifyReply) {
    reply.clearCookie(env.SESSION_COOKIE_NAME, this.cookieOptions())
  }

  async requireIdentity(request: FastifyRequest) {
    const token = this.extractBearerToken(request)
    if (!token) {
      throw new HttpError(401, 'Authentication required')
    }

    const payload = this.verifyAccessToken(token)

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { account: true },
    })

    if (!user || user.accountId !== payload.accountId) {
      throw new HttpError(401, 'Authentication required')
    }

    const sanitizedUser = this.sanitizeUser(user)

    return {
      account: user.account,
      user: sanitizedUser,
      capabilities: this.capabilitiesForUser(sanitizedUser),
    }
  }

  capabilitiesForUser(user: { email: string }) {
    const normalizedEmail = user.email.trim().toLowerCase()
    const allowlist = railwayCreateAllowlistEmails()

    return {
      canCreateRailwayService: allowlist.includes(normalizedEmail),
    }
  }

  private createAccessToken(input: { userId: string; accountId: string; email: string }) {
    return jwt.sign(
      {
        accountId: input.accountId,
        email: input.email,
      },
      jwtSecret(),
      {
        subject: input.userId,
        expiresIn: jwtExpiresIn(),
      },
    )
  }

  private verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, jwtSecret())
      if (!decoded || typeof decoded === 'string' || typeof decoded.sub !== 'string' || typeof decoded.accountId !== 'string' || typeof decoded.email !== 'string') {
        throw new HttpError(401, 'Authentication required')
      }

      return decoded as AccessTokenPayload
    } catch {
      throw new HttpError(401, 'Authentication required')
    }
  }

  private extractBearerToken(request: FastifyRequest) {
    const header = request.headers.authorization
    if (header) {
      const [scheme, token] = header.split(' ')
      if (scheme === 'Bearer' && token) {
        return token
      }
    }

    const cookieToken = request.cookies?.[env.SESSION_COOKIE_NAME]
    if (typeof cookieToken === 'string' && cookieToken.length > 0) {
      return cookieToken
    }

    return null
  }

  private sanitizeUser<T extends { passwordHash: string }>(user: T) {
    const { passwordHash, ...rest } = user
    return rest
  }

  private cookieOptions(): CookieSerializeOptions {
    return buildSessionCookieOptions({
      apiBaseUrl: env.PUBLIC_API_BASE_URL,
      frontendOrigin: env.FRONTEND_ORIGIN,
      sameSite: env.SESSION_COOKIE_SAME_SITE,
      sessionTtlDays: env.SESSION_TTL_DAYS,
      domain: env.SESSION_COOKIE_DOMAIN,
    })
  }
}
