# Claude.md (BigFin + GreenBucks Plan, Status, Next Steps)

## TL;DR
- **BigFin** = multi-tenant loan administration backbone (contract + servicing + ledger + payments + docs + audit + reporting).
- **GreenBucks** = first operator app built on BigFin APIs (MVP1).
- MVP1 is **payments-first** with **Instant to most users**: **RTP/FedNow** → **push-to-card** → **ACH** fallback.
- UI stays simple: users choose **Standard vs Instant** only. Rails never shown.
- **Prefunding** is a growth lever: it can **waive instant fees**.
- **Hash anchoring** (tamper-evidence) is a planned later enhancement, not MVP1.

---

## 0) Repo layout (recommended)
```
/backend/                 # BigFin backend (modular monolith to start)
/apps/greenbucks/         # GreenBucks cross-platform client (Flutter)
/docs/
  /config/                # product templates + policies (JSON)
  /adr/                   # architecture decision records
  /api/                   # OpenAPI specs
  /ops/                   # runbooks + reconciliation notes
Claude.md                 # this file (plan + log)
```

---

## 1) MVP1 scope (GreenBucks on BigFin)

### User-facing outcomes
- Create & send loan offer (amount, APR, term, frequency, first payment date)
- Accept/reject offer → contract created → schedule generated
- Disbursement:
  - **Standard**: ACH (1–2 business days)
  - **Instant**: route RTP/FedNow → push-to-card → ACH fallback
- Borrower can pay a **one-time Express Disbursement fee** when selecting Instant (configurable, itemized)
- Lender prefunding can **waive** Express fee (policy-driven)
- Repayments collected and distributed based on availability rules
- Documents: upload/view per-loan receipts/statements/docs
- Minimal dashboards: next payment, status, history

### Operator outcomes (minimum console)
- Search and view loans
- View loan ledger and payment timelines
- Reverse ledger journals (step-up required)
- Basic reconciliation exceptions view (daily)

---

## 2) BigFin v0 architecture principles (locked)
1. **Multi-tenant from day one**: `tenant_id` everywhere; tenant-scoped policies/config.
2. **Product templates are data**: terms schema + fee rules + waterfall + availability policy.
3. **Ledger is the truth**: double-entry, append-only; reversals only.
4. **Payments are orchestrated**: idempotency everywhere; webhook ingestion; reconciliation.
5. **Separate payment status from funds availability**: never conflate “submitted” with “available.”
6. **Hash anchoring later**: keep on roadmap; no MVP1 dependency.

---

## 3) BigFin v0 domain model (core)
### Identity
- Tenant, User, UserRole
- EndCustomer (borrower/lender) + KYC level + risk flags

### Funding
- FundingInstrument (bank acct, debit card)
- PrefundAccount (custodial balance; derived from ledger)

### Products & Policies
- LoanProduct (term_schema JSON, policy IDs)
- FeesPolicy (incl. Express fee)
- PaymentApplicationPolicy (waterfall)
- AvailabilityPolicy (tiers/limits/holds/prefund waiver)

### Loans
- LoanOffer
- LoanContract
- LoanContractVersion (immutable, effective-dated)
- RepaymentScheduleItem

### Payments
- PaymentIntent (idempotent)
- TransferRoute (rail selection + fee)
- TransferExecution (provider ref + status)
- FundsAvailability (initiated/received/settled/available/held/released)

### Ledger
- LedgerAccount (hierarchical)
- LedgerJournal
- LedgerEntry (balanced journals)

### Docs/Audit
- Document (sha256, storage ref)
- AuditLog

---

## 4) Routing policy (Instant-to-most)
**Inputs:** speed, fee_payer, amount, risk tier, KYC level, instrument support

**Priority order:**
1) RTP
2) FedNow
3) Push-to-card
4) Same Day ACH (optional)
5) ACH

**Express fee:** applied only when `speed=instant` AND not `waived_by_prefund`.

**Prefund waiver:** if lender has sufficient prefund available per policy thresholds, express fee is waived.

---

## 5) Compliance posture (engineering implications)
- Prefunding requires strong **subledger accuracy** + **daily reconciliation**
- Audit logging for all money/state changes
- Role-based access controls; step-up auth for sensitive actions
- Minimize sensitive data at rest; tokenize provider references

---

## 6) Deliverables to generate before heavy coding
### Config files (for /docs/config/)
- Term schema: `personal_loan_simple.term_schema.json`
- Fees policy: `personal_loan_simple.fees_policy.json`
- Payment waterfall: `personal_loan_simple.payment_waterfall.json`
- Availability policy: `personal_loan_simple.availability_policy.json`
- README for config loading/validation

### Specs (for /docs/api/)
- OpenAPI v0 for core endpoints + webhook contract
- Error taxonomy + idempotency guidance

### ADRs (for /docs/adr/)
- Why modular monolith first
- Ledger invariants and reversal-only policy
- Payments routing policy and fallback model

---

## 7) Open questions (answer as we implement)
- Jurisdiction scope for MVP1 (ACH implies U.S. accounts; cross-border later)
- Provider selection for RTP/FedNow/push-to-card/ACH
- Repayment funding methods (ACH only vs optional card)
- Prefund withdrawal rules + holds
- Express fee model (flat bands vs % with caps), and whether fee is financed or paid separately
- KYC requirements by action (instant, prefund, withdrawal)

---

## 8) Current status
- Architecture and v0 domain model defined.
- Payments-first + instant routing strategy locked.
- Prefunding incentive strategy defined (fee waiver).

---

## 9) Next steps (checklist)
### Planning
- [x] Select provider(s) for RTP/FedNow/push-to-card/ACH → **Moov**
- [x] Define "Personal Loan Simple" term schema → `docs/config/`
- [x] Define FeesPolicy (express fee, late/NSF optional) → `docs/config/`
- [x] Define AvailabilityPolicy (tiers, limits, holds, prefund thresholds) → `docs/config/`
- [x] Define PaymentApplicationPolicy waterfall → `docs/config/`
- [x] Draft OpenAPI v0 + webhook contract → `docs/api/openapi.yaml`

### Build (Backend)
- [x] Scaffold /backend with migrations + modules → TypeScript + Fastify + Prisma
- [x] Auth + tenant + roles (routes created, tested)
- [x] Ledger (double-entry + tests) → 14 tests passing
- [x] PaymentIntent + routing + webhook ingestion + idempotency → 100 tests (routing, transfer, webhook)
- [x] Daily reconciliation job + exception reporting → 33 tests
- [ ] Minimal operator endpoints

### Build (Client)
- [ ] Flutter scaffold + secure storage + auth flows
- [ ] Loan create/offer/accept flows
- [ ] Standard/Instant selector + fee disclosure
- [ ] Payment status timeline (Initiated/Received/Available)
- [ ] Prefund balance + deposit flow
- [ ] Documents + receipts/statements

### Later
- [ ] Ledger hash anchoring (Merkle root + optional chain tx hash)
- [ ] Expanded terms (balloon, IO, variable rates)
- [ ] Mortgage console slice (MVP2)

---

## 10) Session log (append-only)
- 2025-12-30: Defined BigFin/GreenBucks architecture; committed to payments-first; instant routing; borrower-paid express fee; prefund fee waiver; hash anchoring later.
- 2025-12-30: Rewrote Claude.md to include repo layout, deliverables, and tighter checklists.
- 2025-12-30: Selected Moov as payment provider (ACH, push-to-card, RTP/FedNow when available).
- 2025-12-30: Drafted OpenAPI v0 spec with full endpoint coverage, schemas, webhook events, and error taxonomy.
- 2025-12-30: Scaffolded /backend with TypeScript + Fastify + Prisma. Created full Prisma schema (25+ models), all module routes, error handling, auth middleware, and env config.
- 2025-12-30: Set up Neon database and seeded with GreenBucks tenant, users, loan product, ledger accounts, sample customers, funding instruments, and loan offer.
- 2025-12-30: Implemented double-entry ledger service with transaction templates (disbursement, repayment, fee, interest, write-off), balance queries, trial balance, and journal reversals. 12 tests passing.
- 2025-12-30: Implemented payment routing service (RTP→FedNow→push-to-card→ACH fallback), transfer service with Moov integration, and webhook handler. 100 tests covering routing, transfers, and webhooks.
- 2025-12-30: Added daily reconciliation service comparing local records with Moov provider, detecting status/amount mismatches, orphaned/missing transfers, ledger imbalances, and prefund balance discrepancies. Auto-resolution for status updates. 33 tests. Total: 145 tests passing.

---

## 11) “Claude Code” operating rules
- Modular monolith first; split later when stable.
- Idempotency on all money-moving endpoints.
- No edits to ledger entries; reversals only.
- Separate payment lifecycle from funds availability.
- Tests required for ledger balance, routing decisions, idempotency, schedule generation.

# End
