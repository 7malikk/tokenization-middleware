# Product

## Register

product

## Users

Thesis examiners watching a live demonstration, usually on a projector or a shared screen, several metres away, while the candidate drives the page. They are sceptical by role: they want to see, not be told, that the reference application never holds a BVN, that the vault holds only ciphertext, and that erasure is real. A secondary audience is the candidate rehearsing the walkthrough.

## Product Purpose

The demonstration page of the reference application for a self-hosted tokenization middleware (MIT Professional Master's Project). It makes the three operations (tokenize, detokenize, erase) visible by showing, side by side, what the app database stores, what the vault stores, and what the audit log records. Success: an examiner can follow one customer's token across all three stores and see each claim of the design hold, without the presenter having to explain the screen.

## Brand Personality

Forensic, exacting, calm. Like an evidence ledger or a lab instrument: precise labels, nothing decorative, the data is the drama. Plain, specific copy that states exactly what happened.

## Anti-references

- Generic SaaS dashboard: rounded cards with soft shadows, a blue or teal accent, nothing memorable.
- Bank or fintech navy-and-gold: corporate trust-signalling.

## Design Principles

1. Show, don't tell: every claim is proved by data on screen, not by a caption.
2. Legible across a room: sizes, contrast and emphasis survive a washed-out projector.
3. Tell the truth: show the real stored bytes and the real audit outcome (NOT_OWNER, ERASED), even when the client saw only "not found".
4. Practise what it preaches: the page itself never stores, logs or lingers on a BVN.
5. One thing moves at a time: after each action, the eye is led to exactly what changed.

## Accessibility & Inclusion

WCAG 2.2 AA. Text contrast at least 4.5:1, higher where it helps projection. Full keyboard operation with visible focus. State never conveyed by color alone. Respect reduced motion.
