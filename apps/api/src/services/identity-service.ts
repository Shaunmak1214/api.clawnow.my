import type { CookieSerializeOptions } from '@fastify/cookie'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createClerkClient } from '@clerk/clerk-sdk-node'
import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'
import { HttpError } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'

type SessionCookieSameSite = 'lax' | 'strict' | 'none'

type SessionCookieConfig = {
  apiBaseUrl: string
  frontendOrigin: string
  sameSite: SessionCookieSameSite
  sessionTtlDays: number
  domain?: string
}

const clerk = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
})

function railwayCreateAllowlistEmails() {
  return env.CLAWNOW_RAILWAY_CREATE_ALLOWLIST_EMAILS
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function jwtExpiresIn(): string {
  return env.JWT_EXPIRES_IN
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
  /**
   * Sync a Clerk user to a local User/Account.
   * Called on first login (after Clerk OAuth/signup) or on subsequent requests.
   * Uses Clerk's API to fetch the latest user details.
   */
  async syncClerkUser(input: { clerkUserId: string; email: string; name?: string | null }) {
    let user = await prisma.user.findUnique({
      where: { clerkUserId: input.clerkUserId },
      include: { account: true },
    })

    if (!user) {
      // First login — create account + user
      const account = await prisma.account.create({
        data: { name: input.name ?? input.email.split('@')[0] },
      })

      user = await prisma.user.create({
        data: {
          accountId: account.id,
          email: input.email.toLowerCase(),
          clerkUserId: input.clerkUserId,
          name: input.name ?? null,
        },
        include: { account: true },
      })
    } else if (input.name && user.name !== input.name) {
      // Update name if changed in Clerk
      user = await prisma.user.update({
        where: { id: user.id },
        data: { name: input.name },
        include: { account: true },
      })
    }

    return {
      account: user.account,
      user: this.sanitizeUser(user),
      accessToken: this.createAccessToken({
        userId: user.id,
        accountId: user.accountId,
        email: user.email,
      }),
    }
  }

  async logout(_request: FastifyRequest) {
    return
  }

  clearAuthCookie(reply: FastifyReply) {
    reply.clearCookie(env.SESSION_COOKIE_NAME, this.cookieOptions())
  }

  async requireIdentity(request: FastifyRequest) {
    const token = this.extractBearerToken(request)
    if (!token) {
      throw new HttpError(401, 'Authentication required')
    }

    // Verify Clerk JWT and extract user info
    const { sub: clerkUserId } = await clerk.verifyToken(token)

    // Look up user by clerkUserId
    const user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: { account: true },
    })

    if (!user) {
      throw new HttpError(401, 'Account not found. Please sign in again.')
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
      env.ENCRYPTION_KEY,
      {
        subject: input.userId,
        expiresIn: jwtExpiresIn(),
      } as jwt.SignOptions,
    )
  }

  private extractBearerToken(request: FastifyRequest) {
    const header = request.headers.authorization
    if (header) {
      const [scheme, token] = header.split(' ')
      if (scheme === 'Bearer' && token) {
        return token
      }
    }
    return null
  }

  private sanitizeUser<T extends { passwordHash?: string; clerkUserId?: string | null }>(user: T) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash: _passwordHash, clerkUserId: _clerkUserId, ...rest } = user
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
