import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const prisma = new PrismaClient();

// Load config files
function loadConfig(filename: string) {
  const configPath = join(__dirname, '../../docs/config', filename);
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

async function main() {
  console.log('🌱 Starting seed...\n');

  // ============================================================
  // 1. Create Tenant
  // ============================================================
  console.log('Creating tenant...');
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'greenbucks' },
    update: {},
    create: {
      name: 'GreenBucks',
      slug: 'greenbucks',
      status: 'ACTIVE',
      config: {
        branding: {
          primaryColor: '#22c55e',
          logo: 'https://greenbucks.app/logo.png',
        },
        features: {
          instantDisbursement: true,
          prefundAccounts: true,
        },
      },
    },
  });
  console.log(`  ✓ Tenant: ${tenant.name} (${tenant.id})\n`);

  // ============================================================
  // 2. Create Users
  // ============================================================
  console.log('Creating users...');
  const passwordHash = await bcrypt.hash('password123', 10);

  const adminUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'admin@greenbucks.app' } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'admin@greenbucks.app',
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  console.log(`  ✓ Admin: ${adminUser.email}`);

  const operatorUser = await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'operator@greenbucks.app' } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'operator@greenbucks.app',
      passwordHash,
      role: 'OPERATOR',
      status: 'ACTIVE',
    },
  });
  console.log(`  ✓ Operator: ${operatorUser.email}\n`);

  // ============================================================
  // 3. Create Loan Product
  // ============================================================
  console.log('Creating loan product...');

  const termSchema = loadConfig('personal_loan_simple.term_schema.json');
  const feesPolicy = loadConfig('personal_loan_simple.fees_policy.json');
  const paymentWaterfall = loadConfig('personal_loan_simple.payment_waterfall.json');
  const availabilityPolicy = loadConfig('personal_loan_simple.availability_policy.json');

  const loanProduct = await prisma.loanProduct.upsert({
    where: { tenantId_code_version: { tenantId: tenant.id, code: 'personal_loan_simple', version: '1.0.0' } },
    update: {},
    create: {
      tenantId: tenant.id,
      name: 'Personal Loan Simple',
      code: 'personal_loan_simple',
      status: 'ACTIVE',
      termSchema,
      feesPolicy,
      paymentWaterfall,
      availabilityPolicy,
      version: '1.0.0',
      effectiveDate: new Date('2025-01-01'),
    },
  });
  console.log(`  ✓ Product: ${loanProduct.name} (${loanProduct.code})\n`);

  // ============================================================
  // 4. Create Ledger Accounts (Chart of Accounts)
  // ============================================================
  console.log('Creating ledger accounts...');

  const accounts = [
    // Assets
    { code: 'assets', name: 'Assets', type: 'ASSET', isSystem: true },
    { code: 'assets:cash', name: 'Cash', type: 'ASSET', isSystem: true, parentCode: 'assets' },
    { code: 'assets:cash:operating', name: 'Operating Cash', type: 'ASSET', isSystem: true, parentCode: 'assets:cash' },
    { code: 'assets:cash:prefund', name: 'Prefund Custodial', type: 'ASSET', isSystem: true, parentCode: 'assets:cash' },
    { code: 'assets:loans_receivable', name: 'Loans Receivable', type: 'ASSET', isSystem: true, parentCode: 'assets' },
    { code: 'assets:loans_receivable:principal', name: 'Principal Receivable', type: 'ASSET', isSystem: true, parentCode: 'assets:loans_receivable' },
    { code: 'assets:loans_receivable:interest', name: 'Interest Receivable', type: 'ASSET', isSystem: true, parentCode: 'assets:loans_receivable' },
    { code: 'assets:loans_receivable:fees', name: 'Fees Receivable', type: 'ASSET', isSystem: true, parentCode: 'assets:loans_receivable' },

    // Liabilities
    { code: 'liabilities', name: 'Liabilities', type: 'LIABILITY', isSystem: true },
    { code: 'liabilities:prefund_balances', name: 'Prefund Balances', type: 'LIABILITY', isSystem: true, parentCode: 'liabilities' },
    { code: 'liabilities:pending_disbursements', name: 'Pending Disbursements', type: 'LIABILITY', isSystem: true, parentCode: 'liabilities' },
    { code: 'liabilities:pending_settlements', name: 'Pending Settlements', type: 'LIABILITY', isSystem: true, parentCode: 'liabilities' },

    // Equity
    { code: 'equity', name: 'Equity', type: 'EQUITY', isSystem: true },
    { code: 'equity:retained_earnings', name: 'Retained Earnings', type: 'EQUITY', isSystem: true, parentCode: 'equity' },

    // Revenue
    { code: 'revenue', name: 'Revenue', type: 'REVENUE', isSystem: true },
    { code: 'revenue:interest_income', name: 'Interest Income', type: 'REVENUE', isSystem: true, parentCode: 'revenue' },
    { code: 'revenue:fees', name: 'Fee Revenue', type: 'REVENUE', isSystem: true, parentCode: 'revenue' },
    { code: 'revenue:fees:express_disbursement', name: 'Express Disbursement Fees', type: 'REVENUE', isSystem: true, parentCode: 'revenue:fees' },
    { code: 'revenue:fees:late_payment', name: 'Late Payment Fees', type: 'REVENUE', isSystem: true, parentCode: 'revenue:fees' },
    { code: 'revenue:fees:nsf', name: 'NSF Fees', type: 'REVENUE', isSystem: true, parentCode: 'revenue:fees' },

    // Expenses
    { code: 'expenses', name: 'Expenses', type: 'EXPENSE', isSystem: true },
    { code: 'expenses:payment_processing', name: 'Payment Processing', type: 'EXPENSE', isSystem: true, parentCode: 'expenses' },
    { code: 'expenses:bad_debt', name: 'Bad Debt', type: 'EXPENSE', isSystem: true, parentCode: 'expenses' },
  ];

  for (const account of accounts) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      update: {},
      create: {
        code: account.code,
        name: account.name,
        type: account.type as any,
        isSystem: account.isSystem,
        parentCode: account.parentCode,
      },
    });
  }
  console.log(`  ✓ Created ${accounts.length} ledger accounts\n`);

  // ============================================================
  // 5. Create Sample Customers
  // ============================================================
  console.log('Creating sample customers...');

  const lender = await prisma.customer.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'alice.lender@example.com' } },
    update: {},
    create: {
      tenantId: tenant.id,
      externalId: 'lender-001',
      role: 'LENDER',
      email: 'alice.lender@example.com',
      phone: '+14155551001',
      firstName: 'Alice',
      lastName: 'Lender',
      dateOfBirth: new Date('1985-03-15'),
      addressLine1: '123 Main St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94102',
      country: 'US',
      kycLevel: 'ENHANCED',
      kycStatus: 'APPROVED',
      kycVerifiedAt: new Date(),
      riskTier: 'TRUSTED',
    },
  });
  console.log(`  ✓ Lender: ${lender.firstName} ${lender.lastName} (${lender.email})`);

  const borrower = await prisma.customer.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: 'bob.borrower@example.com' } },
    update: {},
    create: {
      tenantId: tenant.id,
      externalId: 'borrower-001',
      role: 'BORROWER',
      email: 'bob.borrower@example.com',
      phone: '+14155551002',
      firstName: 'Bob',
      lastName: 'Borrower',
      dateOfBirth: new Date('1990-07-22'),
      addressLine1: '456 Oak Ave',
      city: 'Oakland',
      state: 'CA',
      postalCode: '94612',
      country: 'US',
      kycLevel: 'BASIC',
      kycStatus: 'APPROVED',
      kycVerifiedAt: new Date(),
      riskTier: 'ESTABLISHED',
    },
  });
  console.log(`  ✓ Borrower: ${borrower.firstName} ${borrower.lastName} (${borrower.email})\n`);

  // ============================================================
  // 6. Create Sample Funding Instruments
  // ============================================================
  console.log('Creating sample funding instruments...');

  const lenderBank = await prisma.fundingInstrument.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      customerId: lender.id,
      type: 'BANK_ACCOUNT',
      status: 'VERIFIED',
      bankName: 'Chase Bank',
      accountType: 'CHECKING',
      last4: '4567',
      supportedRails: ['ACH', 'SAME_DAY_ACH', 'RTP'],
      isDefault: true,
      verifiedAt: new Date(),
      verificationMethod: 'plaid',
      providerRef: 'moov_ba_lender_001',
    },
  });
  console.log(`  ✓ Lender bank: ${lenderBank.bankName} ****${lenderBank.last4}`);

  const borrowerBank = await prisma.fundingInstrument.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      customerId: borrower.id,
      type: 'BANK_ACCOUNT',
      status: 'VERIFIED',
      bankName: 'Bank of America',
      accountType: 'CHECKING',
      last4: '8901',
      supportedRails: ['ACH', 'SAME_DAY_ACH'],
      isDefault: true,
      verifiedAt: new Date(),
      verificationMethod: 'plaid',
      providerRef: 'moov_ba_borrower_001',
    },
  });
  console.log(`  ✓ Borrower bank: ${borrowerBank.bankName} ****${borrowerBank.last4}`);

  const borrowerCard = await prisma.fundingInstrument.upsert({
    where: { id: '00000000-0000-0000-0000-000000000003' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000003',
      customerId: borrower.id,
      type: 'DEBIT_CARD',
      status: 'VERIFIED',
      bankName: 'Visa Debit',
      last4: '1234',
      supportedRails: ['PUSH_TO_CARD'],
      isDefault: false,
      verifiedAt: new Date(),
      verificationMethod: 'card_verification',
      providerRef: 'moov_card_borrower_001',
    },
  });
  console.log(`  ✓ Borrower card: ${borrowerCard.bankName} ****${borrowerCard.last4}\n`);

  // ============================================================
  // 7. Create Lender Prefund Balance
  // ============================================================
  console.log('Creating lender prefund balance...');

  const prefundDeposit = await prisma.prefundTransaction.create({
    data: {
      customerId: lender.id,
      type: 'DEPOSIT',
      amountCents: 1000000, // $10,000
      status: 'COMPLETED',
      fundingInstrumentId: lenderBank.id,
      rail: 'ACH',
      balanceAfterCents: 1000000,
      availableAfterCents: 1000000,
      completedAt: new Date(),
    },
  });
  console.log(`  ✓ Prefund deposit: $${(prefundDeposit.amountCents / 100).toFixed(2)}\n`);

  // ============================================================
  // 8. Create Sample Loan Offer
  // ============================================================
  console.log('Creating sample loan offer...');

  const firstPaymentDate = new Date();
  firstPaymentDate.setMonth(firstPaymentDate.getMonth() + 1);
  firstPaymentDate.setDate(1);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const loanOffer = await prisma.loanOffer.create({
    data: {
      tenantId: tenant.id,
      productId: loanProduct.id,
      lenderId: lender.id,
      borrowerId: borrower.id,
      status: 'SENT',
      principalCents: 150000, // $1,500
      aprBps: 1200, // 12.00%
      termMonths: 12,
      paymentFrequency: 'MONTHLY',
      firstPaymentDate,
      expressFeeEstimateCents: 499,
      expressFeeWaived: true, // Lender has prefund
      message: 'Here is a loan offer for your home improvement project!',
      expiresAt,
      sentAt: new Date(),
    },
  });
  console.log(`  ✓ Loan offer: $${(loanOffer.principalCents / 100).toFixed(2)} at ${loanOffer.aprBps / 100}% APR for ${loanOffer.termMonths} months`);
  console.log(`    Status: ${loanOffer.status}, Expires: ${loanOffer.expiresAt.toISOString().split('T')[0]}\n`);

  // ============================================================
  // Summary
  // ============================================================
  console.log('═'.repeat(50));
  console.log('✅ Seed completed successfully!\n');
  console.log('Summary:');
  console.log(`  • Tenant: ${tenant.name}`);
  console.log(`  • Users: admin@greenbucks.app, operator@greenbucks.app (password: password123)`);
  console.log(`  • Product: ${loanProduct.name}`);
  console.log(`  • Ledger Accounts: ${accounts.length}`);
  console.log(`  • Customers: ${lender.firstName} (lender), ${borrower.firstName} (borrower)`);
  console.log(`  • Funding Instruments: 3`);
  console.log(`  • Prefund Balance: $${(prefundDeposit.amountCents / 100).toFixed(2)}`);
  console.log(`  • Sample Loan Offer: $${(loanOffer.principalCents / 100).toFixed(2)}`);
  console.log('═'.repeat(50));
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
