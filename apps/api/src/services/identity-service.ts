import { prisma } from '../lib/prisma.js'

export class IdentityService {
  async ensureDefaultIdentity() {
    let account = await prisma.account.findFirst({
      orderBy: { createdAt: 'asc' },
    })

    if (!account) {
      account = await prisma.account.create({
        data: {
          name: 'ClawNow Demo',
        },
      })
    }

    let user = await prisma.user.findFirst({
      where: {
        accountId: account.id,
      },
      orderBy: { createdAt: 'asc' },
    })

    if (!user) {
      user = await prisma.user.create({
        data: {
          accountId: account.id,
          email: 'owner@clawnow.my',
          name: 'ClawNow Owner',
        },
      })
    }

    return { account, user }
  }
}
