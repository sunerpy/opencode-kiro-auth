You are auditing a chained ledger under `ledger/`.

Rules — follow them exactly:

1. Start at `ledger/step01`.
2. Read EXACTLY ONE ledger file per assistant turn. Never read two ledger files in the
   same turn, never batch reads, and never guess a file's contents.
3. Each file looks like `{"value": <int>, "op": "<op>", "next": "<stepNN or null>"}`.
4. Maintain a running total. Fold the file you just read into it using its `op`:
   - `seed`     -> the running total BECOMES `value` (this only appears on the first hop)
   - `multiply` -> running total = running total * value
   - `add`      -> running total = running total + value
   - `divide`   -> running total = running total / value
   - `subtract` -> running total = running total - value
5. After every read, restate the ENTIRE fold from the first hop to the current one
   (`hop N: file -> op value -> running total`), recomputed from scratch. Do not carry
   forward a previously printed line without re-deriving it.
6. Then follow `next`: read `ledger/<next>.json` on your NEXT turn.
7. When you read a file whose `next` is `null`, the chain is over. Stop reading and
   report the result.

The chain is 10 hops long. Every intermediate running total is an integer; if you
ever produce a fraction you have made an arithmetic error — recompute before continuing.

Your final message MUST end with exactly this line and nothing after it:

FINAL_TOTAL=<the integer running total after the last hop>
