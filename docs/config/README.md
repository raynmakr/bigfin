# BigFin Configuration Files

This directory contains tenant-scoped configuration schemas and policies for loan products. These files are loaded at product instantiation and define the rules governing loan terms, fees, payment application, and funds availability.

## File Naming Convention

```
{product_name}.{config_type}.json
```

- **product_name**: Lowercase, underscore-separated (e.g., `personal_loan_simple`)
- **config_type**: One of `term_schema`, `fees_policy`, `payment_waterfall`, `availability_policy`

## Configuration Files

### Term Schema (`*.term_schema.json`)

Defines valid loan terms and their constraints.

| Field | Description |
|-------|-------------|
| `principal_cents` | Allowed principal range (min/max) |
| `apr_bps` | APR in basis points (range) |
| `term_months` | Allowed term lengths |
| `payment_frequency` | Weekly, biweekly, monthly |
| `first_payment_rules` | Min/max days until first payment |

**Validation**: Used during loan offer creation to ensure terms are within policy.

### Fees Policy (`*.fees_policy.json`)

Defines all fee types and their calculation rules.

| Fee Type | Description |
|----------|-------------|
| `express_disbursement` | Instant transfer fee (flat bands by principal) |
| `late_payment` | Late fee rules (disabled MVP1) |
| `nsf_returned_payment` | Returned payment fee (disabled MVP1) |
| `origination` | Origination fee (disabled MVP1) |
| `prepayment_penalty` | Early payoff penalty (disabled MVP1) |

**Key sections**:
- `prefund_waiver`: Rules for waiving express fee when lender has prefund balance
- `ledger_integration`: Account mappings for fee recognition

### Payment Waterfall (`*.payment_waterfall.json`)

Defines the order in which incoming payments are applied to loan balances.

**Application order** (default):
1. Past-due fees
2. Past-due interest
3. Past-due principal
4. Current fees
5. Current interest
6. Current principal
7. Future principal (prepayment)

**Regulatory notes**: Waterfall must comply with TILA and state-specific rules.

### Availability Policy (`*.availability_policy.json`)

Defines when funds become available based on payment rail, risk tier, and prefund status.

| Section | Description |
|---------|-------------|
| `availability_states` | Lifecycle states (initiated → available) |
| `risk_tiers` | User risk levels affecting hold times |
| `availability_rules_by_rail` | Per-rail timing (RTP, FedNow, ACH, etc.) |
| `prefund_availability` | Special rules for prefund disbursements |
| `hold_overrides` | Conditions extending/reducing holds |
| `limits` | Transaction/balance limits by tier |

## Loading and Validation

### At Product Registration

```python
# Pseudocode
product = LoanProduct.create(
    name="personal_loan_simple",
    tenant_id=tenant.id,
    term_schema=load_and_validate("personal_loan_simple.term_schema.json"),
    fees_policy=load_and_validate("personal_loan_simple.fees_policy.json"),
    payment_waterfall=load_and_validate("personal_loan_simple.payment_waterfall.json"),
    availability_policy=load_and_validate("personal_loan_simple.availability_policy.json")
)
```

### Validation Rules

1. **Schema validation**: Each file must pass JSON Schema validation against its meta-schema
2. **Cross-reference validation**: Fee accounts must exist in chart of accounts
3. **Regulatory validation**: Certain fields checked against jurisdiction rules

### Runtime Usage

```python
# Fee calculation example
fee = fees_policy.calculate_express_fee(
    principal_cents=150000,
    speed="instant",
    lender_prefund_available=0
)
# Returns: 499 (cents) for $1,500 principal in $500.01-$2,000 band

# Availability lookup example
hold_hours = availability_policy.get_hold_hours(
    rail="ach",
    direction="repayment",
    user_tier="established"
)
# Returns: 24 (base 48h * 0.5 multiplier for established tier)
```

## Versioning

Each config file includes:
- `version`: Semantic version (e.g., "1.0.0")
- `effective_date`: Date this version becomes active

**Important**: Config changes require new versions. Never edit existing versions in place—create new versions with updated `effective_date`. Loan contracts reference the config version active at origination.

## Tenant Overrides

Tenants may override default configs:

```
/config/
  personal_loan_simple.term_schema.json          # Default
  tenants/
    greenbucks/
      personal_loan_simple.term_schema.json      # GreenBucks override
```

Load order: tenant-specific → default fallback.

## Testing

All config files have corresponding test suites:

```
/backend/tests/config/
  test_term_schema_validation.py
  test_fees_policy_calculation.py
  test_payment_waterfall_application.py
  test_availability_policy_holds.py
```

Run tests after any config changes:

```bash
pytest tests/config/ -v
```

## Adding New Products

1. Copy existing product configs as templates
2. Modify values for new product
3. Add validation tests
4. Register product with new configs

## Regulatory Notes

- **TILA**: Payment waterfall must apply payments to interest/fees before principal unless borrower specifies prepayment
- **State laws**: Fee caps and late fee rules vary by state; validation layer checks jurisdiction
- **Disclosure**: Express fees must be itemized per `disclosure_requirements` in fees policy
