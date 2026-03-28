import { encryptSecret } from '../lib/crypto.js'

const value = process.argv[2]

if (!value) {
  console.error('Usage: npm run encrypt:secret --workspace @clawnow/api -- "<plain-text-value>"')
  process.exit(1)
}

console.log(encryptSecret(value))
