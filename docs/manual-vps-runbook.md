# Manual VPS Attach Runbook

This runbook is for the seminar version of ClawNow:

- one account = one manually managed VPS
- one VPS = one OpenClaw instance
- server details are inserted by the operator
- the customer sees the VPS in the dashboard after the DB rows exist

## Before You Start

Make sure these are true first:

- the customer has already signed up in `clawnow.my`, or you are going to create the account manually
- the VPS is already created and OpenClaw is installed manually
- you know the real public IP, root password, region, and hostname
- the backend `ENCRYPTION_KEY` in `/Users/shaun/Documents/CODE/clawnow/api.clawnow.my/apps/api/.env` is the same one used by the running API

## Option A. Customer Signs Up Through The App

If the customer has already used `/signup`, skip the manual user creation section and go straight to finding the account.

## Option B. Operator Creates The Customer In SQL

Use this when you want to create the `Account` and `User` yourself.

### Faster Option: Generate The SQL For Me

You can generate the full SQL transaction automatically with the helper script:

```bash
cd /Users/shaun/Documents/CODE/clawnow/api.clawnow.my
npm run generate:manual-sql --workspace @clawnow/api -- \
  --business-name "Acme Sdn Bhd" \
  --user-name "Jane Doe" \
  --email "jane@example.com" \
  --login-password "customer-login-password" \
  --server-password "root-password" \
  --server-ip "203.0.113.10" \
  --hostname "vmi123.contaboserver.net" \
  --server-name "Acme VPS" \
  --instance-name "Acme OpenClaw"
```

For an existing account:

```bash
cd /Users/shaun/Documents/CODE/clawnow/api.clawnow.my
npm run generate:manual-sql --workspace @clawnow/api -- \
  --account-id "ACCOUNT_ID_HERE" \
  --email "jane@example.com" \
  --server-password "root-password" \
  --server-ip "203.0.113.10" \
  --hostname "vmi123.contaboserver.net" \
  --server-name "Acme VPS" \
  --instance-name "Acme OpenClaw"
```

### 1. Generate A Bcrypt Password Hash

Never store the plaintext login password in SQL.

From the backend repo:

```bash
cd /Users/shaun/Documents/CODE/clawnow/api.clawnow.my
node --input-type=module -e "import bcrypt from 'bcryptjs'; console.log(await bcrypt.hash('CUSTOMER_PASSWORD_HERE', 12))"
```

Copy the bcrypt output.

### 2. Generate IDs For The Account And User

```bash
node -e "console.log(require('node:crypto').randomUUID())"
node -e "console.log(require('node:crypto').randomUUID())"
```

Use them as:

- `ACCOUNT_ID`
- `USER_ID`

### 3. Insert The Account And User

```sql
begin;

insert into "Account" (
  "id",
  "name",
  "createdAt",
  "updatedAt"
) values (
  'ACCOUNT_ID_HERE',
  'CUSTOMER_BUSINESS_NAME_HERE',
  now(),
  now()
);

insert into "User" (
  "id",
  "accountId",
  "email",
  "passwordHash",
  "name",
  "createdAt",
  "updatedAt"
) values (
  'USER_ID_HERE',
  'ACCOUNT_ID_HERE',
  'customer@example.com',
  'BCRYPT_HASH_HERE',
  'Customer Name Here',
  now(),
  now()
);

commit;
```

### 4. Verify The Customer Row

```sql
select
  u.id as user_id,
  u.email,
  u.name as user_name,
  a.id as account_id,
  a.name as account_name
from "User" u
join "Account" a on a.id = u."accountId"
where lower(u.email) = lower('customer@example.com');
```

After this, the customer can log in at `/login`.

## 1. Find The Customer Account

Use DBeaver or `psql` and look up the account by the customer's email.

```sql
select
  u.id as user_id,
  u.email,
  u.name as user_name,
  a.id as account_id,
  a.name as account_name
from "User" u
join "Account" a on a.id = u."accountId"
where lower(u.email) = lower('customer@example.com');
```

Keep the returned `account_id`.

## 2. Generate The Encrypted SSH Password

Never paste the plaintext password directly into SQL.

From the backend repo:

```bash
cd /Users/shaun/Documents/CODE/clawnow/api.clawnow.my
npm run encrypt:secret --workspace @clawnow/api -- 'YOUR_ROOT_PASSWORD_HERE'
```

Copy the ciphertext output. You will use that in the SQL insert.

## 3. Generate IDs For The Manual Insert

Prisma model IDs are string fields. For direct SQL inserts, generate them yourself.

Use these commands:

```bash
node -e "console.log(require('node:crypto').randomUUID())"
node -e "console.log(require('node:crypto').randomUUID())"
node -e "console.log(require('node:crypto').randomUUID())"
```

Use them as:

- `VM_ID`
- `INSTANCE_ID`
- `EVENT_ID`

You can also generate one more for a stable manual provider VM id if you want:

```bash
node -e "console.log('manual-contabo-' + require('node:crypto').randomUUID())"
```

## 4. Safety Check Before Insert

Make sure the account does not already have an attached instance:

```sql
select
  i.id,
  i.name,
  i.state,
  v."publicIp"
from "OpenClawInstance" i
left join "Vm" v on v.id = i."currentVmId"
where i."accountId" = 'ACCOUNT_ID_HERE';
```

For the seminar version, this should return zero rows before you attach a new VPS.

## 5. Insert The VM, Instance, And Event In One Transaction

Replace every placeholder before running this.

```sql
begin;

insert into "Vm" (
  "id",
  "provider",
  "providerVmId",
  "name",
  "hostname",
  "publicIp",
  "region",
  "sizeSlug",
  "cpuTotalMillicores",
  "reservedCpuMillicores",
  "memoryTotalMb",
  "reservedMemoryMb",
  "diskTotalGb",
  "containerCount",
  "maxInstances",
  "status",
  "createdAt",
  "updatedAt"
) values (
  'VM_ID_HERE',
  'CONTABO'::"Provider",
  'CONTABO_INSTANCE_ID_OR_MANUAL_KEY_HERE',
  'CUSTOMER_SERVER_NAME_HERE',
  'CUSTOMER_HOSTNAME_HERE',
  'REAL_PUBLIC_IP_HERE',
  'SIN',
  'manual-contabo',
  4000,
  0,
  8192,
  0,
  200,
  1,
  1,
  'ACTIVE'::"VmStatus",
  now(),
  now()
);

insert into "OpenClawInstance" (
  "id",
  "accountId",
  "currentVmId",
  "name",
  "imageTag",
  "sizeProfile",
  "reservedCpuMillicores",
  "reservedMemoryMb",
  "region",
  "state",
  "adminUsername",
  "sshPasswordCiphertext",
  "sshPasswordLastRotatedAt",
  "createdAt",
  "updatedAt"
) values (
  'INSTANCE_ID_HERE',
  'ACCOUNT_ID_HERE',
  'VM_ID_HERE',
  'CUSTOMER_INSTANCE_NAME_HERE',
  'manual-contabo',
  'SMALL'::"SizeProfile",
  0,
  0,
  'SIN',
  'RUNNING'::"InstanceState",
  'root',
  'ENCRYPTED_PASSWORD_CIPHERTEXT_HERE',
  now(),
  now(),
  now()
);

insert into "InstanceEvent" (
  "id",
  "instanceId",
  "type",
  "message",
  "metadata"
) values (
  'EVENT_ID_HERE',
  'INSTANCE_ID_HERE',
  'manual.attach',
  'Manually attached Contabo VPS for seminar access',
  jsonb_build_object(
    'provider', 'contabo',
    'publicIp', 'REAL_PUBLIC_IP_HERE',
    'username', 'root'
  )
);

commit;
```

## 6. Verify The Rows Immediately

Run this after the transaction:

```sql
select
  a.id as account_id,
  a.name as account_name,
  u.email,
  i.id as instance_id,
  i.name as instance_name,
  i.state,
  i."adminUsername",
  v.id as vm_id,
  v."publicIp",
  v.hostname,
  v.status as vm_status
from "Account" a
join "User" u on u."accountId" = a.id
left join "OpenClawInstance" i on i."accountId" = a.id
left join "Vm" v on v.id = i."currentVmId"
where lower(u.email) = lower('customer@example.com');
```

The important result should be:

- one account
- one attached instance
- `state = RUNNING`
- `adminUsername = root`
- the correct public IP
- `vm_status = ACTIVE`

## 7. One Combined SQL Flow

Use this if you want to do everything in one operator session:

1. generate a bcrypt password hash for the app login password
2. generate an encrypted ciphertext for the VPS `root` password
3. generate `ACCOUNT_ID`, `USER_ID`, `VM_ID`, `INSTANCE_ID`, and `EVENT_ID`
4. run this transaction

```sql
begin;

insert into "Account" (
  "id",
  "name",
  "createdAt",
  "updatedAt"
) values (
  'ACCOUNT_ID_HERE',
  'CUSTOMER_BUSINESS_NAME_HERE',
  now(),
  now()
);

insert into "User" (
  "id",
  "accountId",
  "email",
  "passwordHash",
  "name",
  "createdAt",
  "updatedAt"
) values (
  'USER_ID_HERE',
  'ACCOUNT_ID_HERE',
  'customer@example.com',
  'BCRYPT_HASH_HERE',
  'Customer Name Here',
  now(),
  now()
);

insert into "Vm" (
  "id",
  "provider",
  "providerVmId",
  "name",
  "hostname",
  "publicIp",
  "region",
  "sizeSlug",
  "cpuTotalMillicores",
  "reservedCpuMillicores",
  "memoryTotalMb",
  "reservedMemoryMb",
  "diskTotalGb",
  "containerCount",
  "maxInstances",
  "status",
  "createdAt",
  "updatedAt"
) values (
  'VM_ID_HERE',
  'CONTABO'::"Provider",
  'CONTABO_INSTANCE_ID_OR_MANUAL_KEY_HERE',
  'CUSTOMER_SERVER_NAME_HERE',
  'CUSTOMER_HOSTNAME_HERE',
  'REAL_PUBLIC_IP_HERE',
  'SIN',
  'manual-contabo',
  4000,
  0,
  8192,
  0,
  200,
  1,
  1,
  'ACTIVE'::"VmStatus",
  now(),
  now()
);

insert into "OpenClawInstance" (
  "id",
  "accountId",
  "currentVmId",
  "name",
  "imageTag",
  "sizeProfile",
  "reservedCpuMillicores",
  "reservedMemoryMb",
  "region",
  "state",
  "adminUsername",
  "sshPasswordCiphertext",
  "sshPasswordLastRotatedAt",
  "createdAt",
  "updatedAt"
) values (
  'INSTANCE_ID_HERE',
  'ACCOUNT_ID_HERE',
  'VM_ID_HERE',
  'CUSTOMER_INSTANCE_NAME_HERE',
  'manual-contabo',
  'SMALL'::"SizeProfile",
  0,
  0,
  'SIN',
  'RUNNING'::"InstanceState",
  'root',
  'ENCRYPTED_PASSWORD_CIPHERTEXT_HERE',
  now(),
  now(),
  now()
);

insert into "InstanceEvent" (
  "id",
  "instanceId",
  "type",
  "message",
  "metadata"
) values (
  'EVENT_ID_HERE',
  'INSTANCE_ID_HERE',
  'manual.attach',
  'Manually attached Contabo VPS for seminar access',
  jsonb_build_object(
    'provider', 'contabo',
    'publicIp', 'REAL_PUBLIC_IP_HERE',
    'username', 'root'
  )
);

commit;
```

## 8. Customer Check

After the SQL is done:

1. ask the customer to log in again or refresh
2. open the dashboard
3. confirm they can see:
   - server name
   - IP address
   - username `root`
   - password

## Notes

- Do not store plaintext passwords in SQL, screenshots, chat, or docs.
- Only store the encrypted ciphertext in `sshPasswordCiphertext`.
- Only store the bcrypt hash for the app login password in `passwordHash`.
- For the seminar version, keep one account attached to only one VPS.
- If you need to change the password later, generate a fresh ciphertext and run an `update` on `"OpenClawInstance"."sshPasswordCiphertext"` plus `"sshPasswordLastRotatedAt" = now()`.
