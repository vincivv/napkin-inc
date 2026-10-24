# The nine hard invariants

These come from the build prompt. Tests, the red team (`redteam/`) and the docs refer to them by number. The platform reducers enforce 1, 3, 4, 5, 6 and 8 in-transaction (PLAN.md §3.3), so a swapped LLM or a compromised brain still can't break them.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | **Balanced journal entries.** Every posted document's debits equal its credits. | ledger-core `post()`; platform posting; property tests |
| 2 | **Ledger cash = processor truth.** Stripe clearing on the books plus paid out equals what the processor reports. | Processor-event postings; Bookkeeper `reconcile` |
| 3 | **Stock never goes negative** unless the configuration allows backorders. | Platform register movements |
| 4 | **Margin floor.** No sale nets below cost × (1 + floor). Proven with Z3 for the configuration and checked again at runtime on every sale and refund. | services/prover; platform checks; guards |
| 5 | **Segregation of duties.** Whoever creates a document can't approve it when the document type says so. | Platform `cannotApproveOwn`; guards |
| 6 | **Policies and prices change only through the owner-authenticated channel.** Phone instructions are queued and confirmed in the app. Untrusted text never changes policy. | Platform owner-only reducers; phone `owner_instruction` queue; guards `inv6.owner_only` |
| 7 | **Exactly-once payments.** Processor events are de-duplicated by event id in the same transaction as posting. Side effects (refunds, SMS) go through the outbox with idempotency keys. | `processor_event`, `payment_intent_log`, `outbox` / `enqueueOutbox` |
| 8 | **Posted documents are immutable.** Corrections are reversals, and closed periods can't be posted to. | Platform `reverseDocument`, `closePeriod` |
| 9 | **Agents act only through the platform document APIs, through the guards, with DecisionRecords.** | services/brain/src/agents (`wrapTool`), guards, `decision_record` |

Customer-data disclosure (an agent telling a caller about someone else's order) isn't a numbered invariant. The red team measures it as `data_leak`, and the phone/agent privacy rules cover it.
